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

    const syncJob = await prisma.syncJob.findUnique({
      where: { id: jobId },
      include: { source: true, destination: true },
    });
    if (!syncJob) {
      // Sync job was deleted — silently discard this queued run
      return { skipped: true, reason: 'Sync job no longer exists' };
    }

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
      const systemDbs = new Set(['admin', 'local', 'config']);
      const rawDbList: Array<{ name: string; collections?: string[] }> = scope.all
        ? ((await srcAdmin.command({ listDatabases: 1 })).databases as Array<{ name: string }>)
            .filter((d) => !systemDbs.has(d.name))
            .map((d) => ({ name: d.name }))
        : (scope.databases ?? []).filter((d) => !systemDbs.has(d.name));
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
                if (dryRun) {
                  counts.transferred += batch.length;
                } else {
                  const result = await flushBatch(dstColl, batch, syncJob.writeMode);
                  counts.transferred += result.written;
                  counts.skipped += result.skipped;
                }
                batch = [];
              }
            }
            if (batch.length > 0) {
              if (dryRun) {
                counts.transferred += batch.length;
              } else {
                const result = await flushBatch(dstColl, batch, syncJob.writeMode);
                counts.transferred += result.written;
                counts.skipped += result.skipped;
              }
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
): Promise<{ written: number; skipped: number }> {
  if (writeMode === 'upsert') {
    // replaceOne with upsert:true — updates existing docs or inserts new ones.
    // Both update and insert count as "written" (destination reflects source).
    const ops = batch.map((doc) => ({
      replaceOne: { filter: { _id: doc['_id'] }, replacement: doc, upsert: true },
    }));
    const res = await coll.bulkWrite(ops as Parameters<typeof coll.bulkWrite>[0]);
    // upsertedCount = new inserts, matchedCount = existing docs replaced
    const written = (res.upsertedCount ?? 0) + (res.matchedCount ?? 0);
    return { written, skipped: 0 };
  }

  // insertOnly / replace-after-drop: ordered:false → duplicates don't abort the batch.
  // BulkWriteResult.insertedCount tells us exactly how many made it in;
  // anything else with code 11000 is a duplicate-key skip.
  try {
    const res = await coll.insertMany(
      batch as Parameters<typeof coll.insertMany>[0],
      { ordered: false },
    );
    return { written: res.insertedCount ?? batch.length, skipped: 0 };
  } catch (err: unknown) {
    const e = err as { code?: number; result?: { insertedCount?: number }; writeErrors?: Array<{ code: number }> };
    const isDup = e.code === 11000 || (e.writeErrors ?? []).every((w) => w.code === 11000);
    if (!isDup) throw err; // re-throw non-duplicate errors

    const inserted = e.result?.insertedCount ?? Math.max(0, batch.length - (e.writeErrors?.length ?? 0));
    const skipped  = (e.writeErrors?.length ?? 0) || (batch.length - inserted);
    return { written: inserted, skipped };
  }
}
