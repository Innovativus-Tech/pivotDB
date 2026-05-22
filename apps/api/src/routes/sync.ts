import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { syncQueue } from '../lib/queue.js';
import { profileScope, requireAdmin } from '../plugins/auth.js';

interface JWTUser {
  userId: string; email: string; role: string; profileId: string | null;
}

const CreateSyncBody = z.object({
  sourceConnId: z.string(),
  destConnId: z.string(),
  scope: z.unknown(),
  writeMode: z.enum(['insertOnly', 'upsert', 'replace']),
  schedule: z.string().optional(),
  transforms: z.unknown().optional(),
  enabled: z.boolean().default(true),
});

export async function syncRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  app.post('/', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateSyncBody.parse(req.body);
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(400).send({ error: 'No profile assigned' });
    if (body.sourceConnId === body.destConnId) {
      return reply.code(400).send({ error: 'Source and destination cannot be the same connection' });
    }
    const dest = await prisma.connection.findUnique({ where: { id: body.destConnId } });
    if (dest?.readOnly) {
      return reply.code(400).send({ error: 'Destination connection is read-only' });
    }
    const job = await prisma.syncJob.create({
      data: {
        sourceConnId: body.sourceConnId,
        destConnId: body.destConnId,
        profileId: user.profileId,
        scope: body.scope as object,
        writeMode: body.writeMode,
        schedule: body.schedule,
        transforms: body.transforms as object | undefined,
        enabled: body.enabled,
      },
    });
    return reply.code(201).send(job);
  });

  app.get('/', opts, async (req) => {
    const scope = profileScope(req);
    return prisma.syncJob.findMany({ where: scope, orderBy: { createdAt: 'desc' } });
  });

  app.get('/:jobId', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const scope = profileScope(req);
    const job = await prisma.syncJob.findFirst({ where: { id: jobId, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return job;
  });

  app.put('/:jobId', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { jobId } = req.params as { jobId: string };
    const body = CreateSyncBody.partial().parse(req.body);
    const scope = profileScope(req);
    const existing = await prisma.syncJob.findFirst({ where: { id: jobId, ...scope } });
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    try {
      return await prisma.syncJob.update({ where: { id: jobId }, data: body as Record<string, unknown> });
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.delete('/:jobId', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { jobId } = req.params as { jobId: string };
    const scope = profileScope(req);
    const existing = await prisma.syncJob.findFirst({ where: { id: jobId, ...scope } });
    if (!existing) return reply.code(404).send({ error: 'Not found' });
    await prisma.syncJob.delete({ where: { id: jobId } });
    return reply.code(204).send();
  });

  app.post('/:jobId/run', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { jobId } = req.params as { jobId: string };
    const scope = profileScope(req);
    const user = req.user as JWTUser;
    const job = await prisma.syncJob.findFirst({ where: { id: jobId, ...scope } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    await syncQueue.add('sync', { jobId });

    // Audit destructive `replace` runs — they wipe destination data
    if (job.writeMode === 'replace') {
      await prisma.auditEvent.create({
        data: {
          actor: user.email,
          action: 'sync_replace',
          target: `sync_job:${jobId}`,
          metadata: {
            sourceConnId: job.sourceConnId,
            destConnId: job.destConnId,
          },
        },
      });
    }

    return { queued: true };
  });

  app.post('/:jobId/dryrun', opts, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { jobId } = req.params as { jobId: string };
    await syncQueue.add('sync', { jobId, dryRun: true });
    return { queued: true, dryRun: true };
  });

  app.get('/:jobId/runs', opts, async (req) => {
    const { jobId } = req.params as { jobId: string };
    return prisma.jobRun.findMany({ where: { syncJobId: jobId }, orderBy: { startedAt: 'desc' }, take: 50 });
  });
}
