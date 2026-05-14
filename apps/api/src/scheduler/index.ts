import cron from 'node-cron';
import { prisma } from '../lib/prisma.js';
import { syncQueue, backupQueue } from '../lib/queue.js';
import { evaluateAlerts } from '../services/alert.service.js';

export function startScheduler() {
  // Evaluate alerts every 30 seconds
  cron.schedule('*/30 * * * * *', async () => {
    await evaluateAlerts().catch((err) =>
      console.error('[scheduler] alert evaluation error:', err),
    );
  });

  // Poll enabled sync/backup jobs with schedules every minute
  cron.schedule('* * * * *', async () => {
    const now = new Date();

    const syncJobs = await prisma.syncJob.findMany({ where: { enabled: true, schedule: { not: null } } });
    for (const job of syncJobs) {
      if (job.schedule && cron.validate(job.schedule)) {
        const task = cron.schedule(job.schedule, async () => {
          await syncQueue.add('sync', { jobId: job.id });
          task.stop();
        }, { scheduled: false });
        // Check if now matches the cron schedule (simplified: delegate to BullMQ repeat)
        await syncQueue.add('sync', { jobId: job.id }, {
          jobId: `sync-${job.id}-${now.toISOString()}`,
          repeat: { pattern: job.schedule },
        }).catch(() => {});
      }
    }

    const backupJobs = await prisma.backupJob.findMany({ where: { enabled: true } });
    for (const job of backupJobs) {
      if (job.schedule && cron.validate(job.schedule)) {
        await backupQueue.add('backup', { jobId: job.id }, {
          jobId: `backup-${job.id}-sched`,
          repeat: { pattern: job.schedule },
        }).catch(() => {});
      }
    }
  });

  console.log('[scheduler] started');
}
