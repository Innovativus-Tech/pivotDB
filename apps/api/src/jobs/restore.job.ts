import { Worker, Job } from 'bullmq';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm, open } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { createDecipheriv, DecipherGCM } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';

const execFileAsync = promisify(execFile);
const ENCRYPTION_KEY_HEX = process.env.BACKUP_ENCRYPTION_KEY;

export interface RestoreJobPayload {
  restoreRunId: string;
}

export function startRestoreWorker() {
  const worker = new Worker(
    'restore',
    async (job: Job<RestoreJobPayload>) => {
      const { restoreRunId } = job.data;

      const restoreRun = await prisma.restoreRun.findUnique({
        where: { id: restoreRunId },
        include: {
          backupRun: { include: { job: { include: { connection: true } } } },
          targetConnection: true,
        },
      });
      if (!restoreRun) return; // stale — ignore

      // Mark as running
      await prisma.restoreRun.update({
        where: { id: restoreRunId },
        data: { status: 'running', startedAt: new Date() },
      });

      const tempDir = path.join('/tmp', `restore-${restoreRunId}`);
      const extractDir = path.join(tempDir, 'extracted');
      const dumpDir = path.join(extractDir, 'dump');
      const decryptedTar = path.join(tempDir, 'backup.tar.gz');

      try {
        await mkdir(extractDir, { recursive: true });

        const encryptedFilePath = restoreRun.backupRun.filePath;
        if (!encryptedFilePath) throw new Error('Backup file path is missing');

        const isEncrypted = encryptedFilePath.endsWith('.enc');

        if (isEncrypted) {
          if (!ENCRYPTION_KEY_HEX) {
            throw new Error('BACKUP_ENCRYPTION_KEY is not set but the backup file is encrypted');
          }

          // ── STEP 1: Read IV (first 12 bytes) and auth tag (last 16 bytes) ──
          const fileHandle = await open(encryptedFilePath, 'r');
          const stats = await fileHandle.stat();
          const totalSize = stats.size;

          const ivBuffer = Buffer.alloc(12);
          await fileHandle.read(ivBuffer, 0, 12, 0);

          const tagBuffer = Buffer.alloc(16);
          await fileHandle.read(tagBuffer, 0, 16, totalSize - 16);
          await fileHandle.close();

          // ── STEP 2: Stream-decrypt the middle [12 .. size-16) ──
          const key = Buffer.from(ENCRYPTION_KEY_HEX, 'hex');
          const decipher = createDecipheriv('aes-256-gcm', key, ivBuffer) as DecipherGCM;
          decipher.setAuthTag(tagBuffer);

          // createReadStream `end` is INCLUSIVE — so to read up to (but not including)
          // totalSize-16 we use end = totalSize - 17.
          const encryptedStream = createReadStream(encryptedFilePath, {
            start: 12,
            end: totalSize - 17,
          });
          const gunzip = createGunzip();
          const tarWriteStream = createWriteStream(decryptedTar);

          await pipeline(encryptedStream, decipher, gunzip, tarWriteStream);
        } else {
          // Unencrypted .tar.gz — just gunzip into a .tar
          const readStream = createReadStream(encryptedFilePath);
          const gunzip = createGunzip();
          const tarWriteStream = createWriteStream(decryptedTar);
          await pipeline(readStream, gunzip, tarWriteStream);
        }

        // ── STEP 3: Extract tar ──
        await execFileAsync('tar', ['-xf', decryptedTar, '-C', extractDir]);

        // ── STEP 4: Decrypt target MongoDB URI ──
        const targetUri = decrypt(restoreRun.targetConnection.encryptedUri);
        const tlsInsecure = targetUri.startsWith('mongodb+srv://');

        // ── STEP 5: mongorestore ──
        // --drop: drops each collection before restoring (clean restore)
        // --gzip: because mongodump used --gzip
        // NOTE: --preserveUUID is intentionally omitted — it requires the
        // `applyOps` admin command which MongoDB Atlas does not grant to
        // regular users. New UUIDs are fine for restore semantics.
        const restoreArgs = [
          '--uri', targetUri,
          '--dir', dumpDir,
          '--gzip',
          '--drop',
          ...(tlsInsecure ? ['--tlsInsecure'] : []),
        ];

        const { stdout, stderr } = await execFileAsync('mongorestore', restoreArgs, {
          env: { ...process.env },
          maxBuffer: 50 * 1024 * 1024,
        });

        // ── STEP 6: Mark success ──
        const log = [stderr, stdout].filter(Boolean).join('\n') || 'Restore completed successfully';
        await prisma.restoreRun.update({
          where: { id: restoreRunId },
          data: { status: 'success', finishedAt: new Date(), log },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        await prisma.restoreRun.update({
          where: { id: restoreRunId },
          data: { status: 'failed', finishedAt: new Date(), log: message },
        });
        throw err;
      } finally {
        await rm(tempDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
      }
    },
    {
      connection: redis,
      concurrency: 1, // Never run two restores simultaneously
    },
  );

  worker.on('failed', (job, err) => {
    console.error(`[RestoreWorker] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}
