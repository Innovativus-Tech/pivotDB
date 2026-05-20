import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { syncQueue, backupQueue } from '../lib/queue.js';
import { evaluateAlerts } from '../lib/alertEvaluator.js';
import { getSnapshot } from '../services/monitor.service.js';

// ── Backup scheduling via BullMQ repeatable jobs ──────────────────────────────
// BullMQ stores repeatable jobs in Redis (persistent, survives restarts).
// This is more reliable than in-memory node-cron tasks which can ghost-fire
// after a schedule change if stop()/destroy() races with the event loop.

export async function scheduleBackupJob(job: { id: string; schedule: string }) {
  await unscheduleBackupJob(job.id); // remove any existing repeatable for this job

  if (!cron.validate(job.schedule)) {
    console.warn(`[scheduler] Invalid cron for backup job ${job.id}: ${job.schedule}`);
    return;
  }

  await backupQueue.add(
    'run',
    { backupJobId: job.id },
    {
      repeat: { pattern: job.schedule },
      // Embed the backup-job ID so we can find + remove it later
      jobId: `backup-repeat-${job.id}`,
    },
  );

  console.log(`[scheduler] scheduled backup job ${job.id} → ${job.schedule}`);
}

export async function unscheduleBackupJob(jobId: string) {
  const repeatableJobs = await backupQueue.getRepeatableJobs();
  for (const r of repeatableJobs) {
    // Match by the jobId we embedded OR by key containing the job id
    if (r.id === `backup-repeat-${jobId}` || r.key.includes(jobId)) {
      await backupQueue.removeRepeatableByKey(r.key);
      console.log(`[scheduler] removed repeatable backup job ${jobId}`);
    }
  }
}

export async function reloadBackupJob(job: { id: string; schedule: string; status: string }) {
  if (job.status === 'active') {
    await scheduleBackupJob(job);
  } else {
    await unscheduleBackupJob(job.id);
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────

export async function startScheduler() {
  // Background alert evaluation safety net (every 30s).
  cron.schedule('*/30 * * * * *', async () => {
    try {
      const profiles = await prisma.alertRule.groupBy({
        by: ['connectionId', 'profileId'],
        where: { enabled: true, status: { not: 'paused' } },
      });
      for (const { connectionId, profileId } of profiles) {
        try {
          const snapshot = await getSnapshot(connectionId);
          await evaluateAlerts(connectionId, profileId, snapshot);
        } catch (err) {
          console.error(`[scheduler] alert eval ${connectionId}:`, (err as Error).message);
        }
      }
    } catch (err) {
      console.error('[scheduler] alert sweep error:', (err as Error).message);
    }
  });

  // Sync jobs via BullMQ repeat (stateless — BullMQ manages the schedule)
  cron.schedule('*/5 * * * *', async () => {
    const syncJobs = await prisma.syncJob.findMany({
      where: { enabled: true, schedule: { not: null } },
    });
    for (const job of syncJobs) {
      if (job.schedule && cron.validate(job.schedule)) {
        await syncQueue.add('sync', { jobId: job.id }, {
          jobId: `sync-repeat-${job.id}`,
          repeat: { pattern: job.schedule },
        }).catch(() => {});
      }
    }
  });

  // ── Register backup jobs as BullMQ repeatable jobs on startup ────────────────
  const activeBackups = await prisma.backupJob.findMany({
    where: { status: 'active' },
    select: { id: true, schedule: true },
  });

  const activeIds = new Set(activeBackups.map(j => j.id));

  // Prune stale repeatable jobs from Redis that no longer exist in DB
  const existing = await backupQueue.getRepeatableJobs();
  for (const r of existing) {
    if (!r.id) continue;
    const match = r.id.match(/^backup-repeat-(.+)$/);
    if (match && !activeIds.has(match[1])) {
      await backupQueue.removeRepeatableByKey(r.key);
      console.log(`[scheduler] pruned stale repeatable job ${r.id}`);
    }
  }

  // Schedule all active backup jobs
  for (const job of activeBackups) {
    await scheduleBackupJob(job);
  }

  console.log(`[scheduler] started — ${activeBackups.length} backup job(s) registered`);
}
