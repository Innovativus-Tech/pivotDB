import { Worker, Job } from 'bullmq';
import { createWriteStream, mkdirSync, createReadStream, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { createHash, createCipheriv, randomBytes } from 'node:crypto';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';
import { getFreshClient } from '../lib/mongo.js';
import { getS3Client } from '../lib/s3.js';
import { Upload } from '@aws-sdk/lib-storage';
import { ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

const TEMP_DIR = process.env.TEMP_DIR ?? '/tmp/mongovis';
const ALGORITHM = 'aes-256-gcm';

function getEncKey(): Buffer {
  return Buffer.from(process.env.ENCRYPTION_KEY!, 'hex');
}

async function encryptFile(inputPath: string, outputPath: string): Promise<string> {
  const iv     = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncKey(), iv);
  const hash   = createHash('sha256');

  const inStream  = createReadStream(inputPath);
  const outStream = createWriteStream(outputPath);

  outStream.write(iv);
  await streamPipeline(
    inStream,
    cipher,
    outStream,
  );

  const tag = cipher.getAuthTag();
  await new Promise<void>((res, rej) => outStream.write(tag, (err) => err ? rej(err) : res()));
  await new Promise<void>((res, rej) => outStream.end((err?: Error | null) => err ? rej(err) : res()));

  const fileBuffer = await import('node:fs/promises').then((fs) => fs.readFile(outputPath));
  hash.update(fileBuffer);
  return hash.digest('hex');
}

export function startBackupWorker() {
  return new Worker('backup', async (job: Job) => {
    const { jobId } = job.data as { jobId: string };

    const backupJob = await prisma.backupJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { connection: true, s3Destination: true },
    });

    const run = await prisma.jobRun.create({
      data: { backupJobId: jobId, jobType: 'backup', status: 'running' },
    });

    const workDir = path.join(TEMP_DIR, `backup_${jobId}_${Date.now()}`);
    mkdirSync(workDir, { recursive: true });

    try {
      const uri    = decrypt(backupJob.connection.encryptedUri);
      const client = await getFreshClient(uri);
      const scope  = backupJob.scope as { all?: boolean; databases?: string[] };
      const admin  = client.db('admin');

      const dbNames = scope.all
        ? ((await admin.command({ listDatabases: 1 })).databases as Array<{ name: string }>).map((d) => d.name)
        : (scope.databases ?? []);

      for (const dbName of dbNames) {
        const dbDir = path.join(workDir, dbName);
        mkdirSync(dbDir, { recursive: true });
        const colls = await client.db(dbName).listCollections().toArray();
        for (const coll of colls) {
          const filePath  = path.join(dbDir, `${coll.name}.ndjson`);
          const fileStream = createWriteStream(filePath);
          const cursor = client.db(dbName).collection(coll.name).find();
          for await (const doc of cursor) {
            fileStream.write(JSON.stringify(doc) + '\n');
          }
          await new Promise<void>((res, rej) => fileStream.end((err?: Error | null) => err ? rej(err) : res()));
        }
      }

      await client.close();

      const tarPath  = path.join(TEMP_DIR, `backup_${jobId}.tar.gz`);
      const encPath  = tarPath + '.enc';

      // Create tar.gz using Node.js streams
      const { create } = await import('tar');
      await create({ gzip: true, cwd: TEMP_DIR, file: tarPath }, [path.basename(workDir)]);
      const checksum = await encryptFile(tarPath, encPath);

      const s3   = getS3Client(backupJob.s3Destination.encryptedCredentials, backupJob.s3Destination.region);
      const ts   = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const key  = `${backupJob.s3Destination.prefix}${backupJob.connectionId}/${ts}.archive.enc`;

      const upload = new Upload({
        client: s3,
        params: {
          Bucket: backupJob.s3Destination.bucket,
          Key: key,
          Body: createReadStream(encPath),
          Metadata: { checksum },
          Tagging: `checksum=${checksum}`,
        },
      });
      await upload.done();

      await applyRetention(s3, backupJob.s3Destination.bucket,
        `${backupJob.s3Destination.prefix}${backupJob.connectionId}/`,
        backupJob.retentionPolicy as Record<string, unknown>,
        backupJob.id,
      );

      const encStat = statSync(encPath);
      await prisma.jobRun.update({
        where: { id: run.id },
        data: {
          status: 'success',
          finishedAt: new Date(),
          counts: { s3Key: key, checksum, bytes: encStat.size },
        },
      });
    } catch (err) {
      await prisma.jobRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), errorReport: { error: String(err) } },
      });
      throw err;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }, { connection: redis });
}

async function applyRetention(
  s3: ReturnType<typeof getS3Client>,
  bucket: string,
  prefix: string,
  policy: Record<string, unknown>,
  jobId: string,
) {
  const list = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
  const objects = (list.Contents ?? []).sort((a, b) =>
    (a.LastModified?.getTime() ?? 0) - (b.LastModified?.getTime() ?? 0),
  );

  let toDelete: typeof objects = [];

  if (typeof policy['keepN'] === 'number') {
    const excess = objects.length - policy['keepN'];
    if (excess > 0) toDelete = objects.slice(0, excess);
  } else if (typeof policy['olderThanDays'] === 'number') {
    const cutoff = Date.now() - policy['olderThanDays'] * 86400_000;
    toDelete = objects.filter((o) => (o.LastModified?.getTime() ?? 0) < cutoff);
  }

  for (const obj of toDelete) {
    if (!obj.Key) continue;
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: obj.Key }));
    await prisma.auditEvent.create({
      data: { actor: 'system', action: 'delete_backup', target: `s3://${bucket}/${obj.Key}`, metadata: { jobId } },
    });
  }
}
