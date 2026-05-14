import { Worker, Job } from 'bullmq';
import { redis } from '../lib/redis.js';
import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';
import { getFreshClient } from '../lib/mongo.js';
import { Db } from 'mongodb';

const BATCH_SIZE = 500;

interface SyncScope {
  all?: boolean;
  databases?: Array<{ name: string; collections?: string[] }>;
}

export function startSyncWorker() {
  return new Worker('sync', async (job: Job) => {
    const { jobId, dryRun = false } = job.data as { jobId: string; dryRun?: boolean };

    const syncJob = await prisma.syncJob.findUniqueOrThrow({
      where: { id: jobId },
      include: { source: true, destination: true },
    });

    const run = await prisma.jobRun.create({
      data: { syncJobId: jobId, jobType: 'sync', status: 'running' },
    });

    const counts = { transferred: 0, skipped: 0, failed: 0, bytes: 0 };
    const errors: Array<{ namespace: string; error: string }> = [];

    try {
      const srcUri  = decrypt(syncJob.source.encryptedUri);
      const dstUri  = decrypt(syncJob.destination.encryptedUri);
      const srcClient = await getFreshClient(srcUri);
      const dstClient = await getFreshClient(dstUri);

      const scope = syncJob.scope as SyncScope;
      const srcAdmin = srcClient.db('admin');
      const rawDbList: Array<{ name: string; collections?: string[] }> = scope.all
        ? ((await srcAdmin.command({ listDatabases: 1 })).databases as Array<{ name: string }>).map((d) => ({ name: d.name }))
        : (scope.databases ?? []);
      const dbList = rawDbList;

      for (const dbDef of dbList) {
        const srcDb = srcClient.db(dbDef.name);
        const dstDb = dstClient.db(dbDef.name);
        const colls = dbDef.collections?.length
          ? dbDef.collections
          : (await srcDb.listCollections().toArray()).map((c) => c.name);

        for (const collName of colls) {
          const ns = `${dbDef.name}.${collName}`;
          try {
            const srcColl = srcDb.collection(collName);
            const dstColl = dstDb.collection(collName);

            if (syncJob.writeMode === 'replace' && !dryRun) {
              await dstColl.drop().catch(() => {});
            }

            const cursor = srcColl.find({}, { readPreference: 'secondaryPreferred' });
            let batch: Array<Record<string, unknown>> = [];

            for await (const doc of cursor) {
              batch.push(doc as Record<string, unknown>);
              if (batch.length >= BATCH_SIZE) {
                if (!dryRun) {
                  await flushBatch(dstColl, batch, syncJob.writeMode);
                }
                counts.transferred += batch.length;
                batch = [];
              }
            }
            if (batch.length > 0) {
              if (!dryRun) {
                await flushBatch(dstColl, batch, syncJob.writeMode);
              }
              counts.transferred += batch.length;
            }

            if (!dryRun) {
              const indexes = await srcColl.listIndexes().toArray();
              for (const idx of indexes) {
                if (idx.name === '_id_') continue;
                const { v: _v, ns: _ns, ...indexSpec } = idx;
                await dstColl.createIndex(indexSpec.key, indexSpec).catch(() => {});
              }
            }
          } catch (err) {
            errors.push({ namespace: ns, error: String(err) });
            counts.failed++;
          }
        }
      }

      await srcClient.close();
      await dstClient.close();

      const status = errors.length > 0 ? 'partial' : 'success';
      await prisma.jobRun.update({
        where: { id: run.id },
        data: { status, finishedAt: new Date(), counts, errorReport: errors.length ? errors : undefined },
      });
    } catch (err) {
      await prisma.jobRun.update({
        where: { id: run.id },
        data: { status: 'failed', finishedAt: new Date(), errorReport: { error: String(err) } },
      });
      throw err;
    }
  }, { connection: redis });
}

async function flushBatch(
  coll: ReturnType<Db['collection']>,
  batch: Array<Record<string, unknown>>,
  writeMode: string,
) {
  if (writeMode === 'upsert') {
    const ops = batch.map((doc) => ({
      replaceOne: { filter: { _id: doc['_id'] }, replacement: doc, upsert: true },
    }));
    await coll.bulkWrite(ops as Parameters<typeof coll.bulkWrite>[0]);
  } else {
    await coll.insertMany(batch as Parameters<typeof coll.insertMany>[0], { ordered: false }).catch(() => {});
  }
}
