import { Worker, Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, stat } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { createCipheriv, randomBytes, CipherGCM } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import path from 'node:path';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';

const execFileAsync = promisify(execFile);

const BACKUP_BASE_DIR = process.env.BACKUP_DIR ?? '/app/backups';
const ENCRYPTION_KEY_HEX = process.env.BACKUP_ENCRYPTION_KEY;

export function startBackupWorker() {
  const worker = new Worker(
    'backup',
    async (job: Job) => {
      const { backupJobId } = job.data as { backupJobId: string };

      const backupJob = await prisma.backupJob.findUnique({
        where: { id: backupJobId },
        include: { connection: true },
      });
      if (!backupJob) return; // stale job — ignore

      // Create run record
      const run = await prisma.backupRun.create({
        data: { jobId: backupJobId, status: 'running', databases: backupJob.databases },
      });

      // Mark job as running
      await prisma.backupJob.update({
        where: { id: backupJobId },
        data: { lastRunAt: new Date(), lastRunStatus: 'running' },
      });

      const tempDir = path.join('/tmp', `backup-${run.id}`);
      const dumpDir = path.join(tempDir, 'dump');
      const outputDir = path.join(BACKUP_BASE_DIR, backupJob.profileId);
      const ext = ENCRYPTION_KEY_HEX ? '.tar.gz.enc' : '.tar.gz';
      const archivePath = path.join(outputDir, `${run.id}${ext}`);

      try {
        // Step 1: Create temp + output dirs
        await mkdir(dumpDir, { recursive: true });
        await mkdir(outputDir, { recursive: true });

        // Step 2: Decrypt MongoDB URI
        const uri = decrypt(backupJob.connection.encryptedUri);

        // Step 3: Run mongodump
        // NOTE: do NOT pass --tlsInsecure for mongodb+srv:// — Atlas has valid
        // certs and `--tlsInsecure` breaks SNI on Atlas's load balancer,
        // producing "remote error: tls: internal error" handshake failures.
        const baseDumpArgs = [
          '--uri', uri,
          '--out', dumpDir,
          '--gzip',
        ];

        if (backupJob.databases.length > 0) {
          // Dump each selected database separately
          for (const db of backupJob.databases) {
            await execFileAsync('mongodump', [...baseDumpArgs, '--db', db]);
          }
        } else {
          // Dump everything
          await execFileAsync('mongodump', baseDumpArgs);
        }

        // Step 4: tar the dump directory
        const tarPath = path.join(tempDir, 'backup.tar');
        await execFileAsync('tar', ['-cf', tarPath, '-C', tempDir, 'dump']);

        // Step 5: gzip + optional AES-256-GCM encryption → final archive
        const readStream = createReadStream(tarPath);
        const gzip = createGzip();
        const writeStream = createWriteStream(archivePath);

        if (ENCRYPTION_KEY_HEX) {
          const iv = randomBytes(12);
          const key = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
          const cipher = createCipheriv('aes-256-gcm', key, iv) as CipherGCM;

          // Append the 16-byte GCM auth tag as the very last bytes of the file.
          // File format: [12 bytes IV][encrypted gzipped tar][16 bytes auth tag]
          // We use a pass-through Transform whose flush() emits the auth tag so
          // pipeline() writes it before closing the write stream.
          const appendAuthTag = new Transform({
            transform(chunk, _enc, cb) { cb(null, chunk); },
            flush(cb) { cb(null, cipher.getAuthTag()); },
          });

          // Prepend IV as first 12 bytes so decrypt can extract it
          writeStream.write(iv);
          await pipeline(readStream, gzip, cipher, appendAuthTag, writeStream);
        } else {
          await pipeline(readStream, gzip, writeStream);
        }

        // Step 6: Get file size
        const fileStats = await stat(archivePath);

        // Step 7: Mark run as success
        await prisma.backupRun.update({
          where: { id: run.id },
          data: {
            status: 'success',
            finishedAt: new Date(),
            sizeBytes: fileStats.size,
            filePath: archivePath,
          },
        });

        await prisma.backupJob.update({
          where: { id: backupJobId },
          data: { lastRunStatus: 'success', lastRunError: null },
        });

        // Step 8: Enforce strict retention — keep only the 3 most recent successful runs
        const allSuccessfulRuns = await prisma.backupRun.findMany({
          where: { jobId: backupJobId, status: 'success' },
          orderBy: { startedAt: 'desc' },
          select: { id: true, filePath: true, startedAt: true },
        });

        const runsToDelete = allSuccessfulRuns.slice(3);
        for (const old of runsToDelete) {
          if (old.filePath) {
            await rm(old.filePath, { force: true }).catch(() => { /* file already gone */ });
          }
          await prisma.backupRun.delete({ where: { id: old.id } }).catch(() => { /* row already gone */ });
        }

      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        await prisma.backupRun.update({
          where: { id: run.id },
          data: { status: 'failed', finishedAt: new Date(), errorMsg: message },
        });

        await prisma.backupJob.update({
          where: { id: backupJobId },
          data: { lastRunStatus: 'failed', lastRunError: message },
        });

        throw err;
      } finally {
        // Always clean up temp directory
        await rm(tempDir, { recursive: true, force: true });
      }
    },
    { connection: redis },
  );

  worker.on('failed', (job, err) => {
    console.error(`[BackupWorker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
