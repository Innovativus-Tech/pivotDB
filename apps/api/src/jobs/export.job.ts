import { Worker, Job } from 'bullmq';
import { createWriteStream, mkdirSync } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { stringify } from 'csv-stringify';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';
import { getFreshClient } from '../lib/mongo.js';

const TEMP_DIR = process.env.TEMP_DIR ?? '/tmp/mongovis';

function jsonTransform() {
  let first = true;
  return new Transform({
    objectMode: true,
    transform(doc, _enc, cb) {
      const chunk = first ? '[\n' + JSON.stringify(doc) : ',\n' + JSON.stringify(doc);
      first = false;
      cb(null, chunk);
    },
    flush(cb) {
      cb(null, first ? '[]' : '\n]');
    },
  });
}

export function startExportWorker() {
  return new Worker('export', async (job: Job) => {
    const { jobId } = job.data as { jobId: string };

    const exportJob = await prisma.exportJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { connection: true },
    });

    await prisma.exportJob.update({ where: { id: jobId }, data: { status: 'running' } });

    const run = await prisma.jobRun.create({
      data: { exportJobId: jobId, jobType: 'export', status: 'running' },
    });

    try {
      const uri    = decrypt(exportJob.connection.encryptedUri);
      const client = await getFreshClient(uri);
      const db     = client.db(exportJob.database);
      const coll   = db.collection(exportJob.collection);

      const query    = exportJob.query as Record<string, unknown>;
      const pipeline_stages = exportJob.isPipeline ? (query as unknown as unknown[]) : undefined;
      const filter   = exportJob.isPipeline ? {} : query;

      mkdirSync(TEMP_DIR, { recursive: true });
      const ext      = exportJob.format === 'csv' ? 'csv' : 'json';
      const fileKey  = path.join(TEMP_DIR, `export_${jobId}.${ext}`);
      const outStream = createWriteStream(fileKey);

      const cursor = pipeline_stages
        ? coll.aggregate(pipeline_stages as Parameters<typeof coll.aggregate>[0])
        : coll.find(filter);

      const docStream = Readable.from(cursor as AsyncIterable<Record<string, unknown>>);

      if (exportJob.format === 'csv') {
        const opts = exportJob.options as { delimiter?: string; header?: boolean };
        const csvStream = stringify({ delimiter: opts.delimiter ?? ',', header: opts.header !== false });
        await pipeline(docStream, csvStream, outStream);
      } else {
        await pipeline(docStream, jsonTransform(), outStream);
      }

      await client.close();
      await prisma.exportJob.update({ where: { id: jobId }, data: { status: 'done', fileKey } });
      await prisma.jobRun.update({ where: { id: run.id }, data: { status: 'success', finishedAt: new Date() } });
    } catch (err) {
      await prisma.exportJob.update({ where: { id: jobId }, data: { status: 'failed' } });
      await prisma.jobRun.update({ where: { id: run.id }, data: { status: 'failed', finishedAt: new Date(), errorReport: { error: String(err) } as object } });
      throw err;
    }
  }, { connection: redis });
}
