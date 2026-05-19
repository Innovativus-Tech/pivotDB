import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { syncQueue, backupQueue } from '../lib/queue.js';
import { evaluateAlerts } from '../lib/alertEvaluator.js';
import { getSnapshot } from '../services/monitor.service.js';

// Map of jobId → cron task (for backup jobs)
const backupTasks = new Map<string, cron.ScheduledTask>();

export function scheduleBackupJob(job: { id: string; schedule: string }) {
  // Cancel any existing task for this job
  unscheduleBackupJob(job.id);

  if (!cron.validate(job.schedule)) {
    console.warn(`[scheduler] Invalid cron for backup job ${job.id}: ${job.schedule}`);
    return;
  }

  const task = cron.schedule(job.schedule, async () => {
    await backupQueue.add('run', { backupJobId: job.id }, {
      jobId: `backup-sched-${job.id}-${Date.now()}`,
    }).catch((err) => console.error(`[scheduler] backup enqueue error:`, err));
  });

  backupTasks.set(job.id, task);
  console.log(`[scheduler] registered backup job ${job.id} → ${job.schedule}`);
}

export function unscheduleBackupJob(jobId: string) {
  const existing = backupTasks.get(jobId);
  if (existing) {
    existing.stop();
    backupTasks.delete(jobId);
  }
}

export function reloadBackupJob(job: { id: string; schedule: string; status: string }) {
  if (job.status === 'active') {
    scheduleBackupJob(job);
  } else {
    unscheduleBackupJob(job.id);
  }
}

export async function startScheduler() {
  // Background alert evaluation safety net (every 30s).
  // The Monitor UI's 5s snapshot poll already evaluates alerts in real time
  // for the actively-viewed connection; this loop covers connections that
  // nobody is currently watching so backend rules still fire.
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

  // Register sync jobs via BullMQ repeat (stateless — BullMQ manages the schedule)
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

  // Load all active backup jobs and register their cron tasks on startup
  const activeBackups = await prisma.backupJob.findMany({
    where: { status: 'active' },
    select: { id: true, schedule: true },
  });

  for (const job of activeBackups) {
    scheduleBackupJob(job);
  }

  console.log(`[scheduler] started — ${activeBackups.length} backup job(s) registered`);
}
