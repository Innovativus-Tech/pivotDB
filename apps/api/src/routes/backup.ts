import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';
import { backupQueue } from '../lib/queue.js';
import { encrypt } from '../crypto/encrypt.js';
import { getS3Client } from '../lib/s3.js';
import { ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';

const CreateDestBody = z.object({
  connectionId: z.string(),
  bucket: z.string(),
  region: z.string(),
  prefix: z.string().default(''),
  credentials: z.object({
    accessKeyId: z.string().optional(),
    secretAccessKey: z.string().optional(),
    roleArn: z.string().optional(),
  }),
});

const CreateBackupJobBody = z.object({
  connectionId: z.string(),
  s3DestId: z.string(),
  schedule: z.string(),
  scope: z.unknown(),
  retentionPolicy: z.unknown(),
  enabled: z.boolean().default(true),
});

export async function backupRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  // S3 Destinations
  app.post('/destinations', opts, async (req, reply) => {
    const body = CreateDestBody.parse(req.body);
    const encryptedCredentials = encrypt(JSON.stringify(body.credentials));
    const dest = await prisma.s3Destination.create({
      data: {
        connectionId: body.connectionId,
        bucket: body.bucket,
        region: body.region,
        prefix: body.prefix,
        encryptedCredentials,
        verifiedAt: new Date(),
      },
    });
    return reply.code(201).send({ ...dest, encryptedCredentials: undefined });
  });

  app.get('/destinations', opts, async () => {
    const dests = await prisma.s3Destination.findMany();
    return dests.map(({ encryptedCredentials: _, ...d }) => d);
  });

  app.delete('/destinations/:destId', opts, async (req, reply) => {
    const { destId } = req.params as { destId: string };
    await prisma.s3Destination.delete({ where: { id: destId } });
    return reply.code(204).send();
  });

  // Backup Jobs
  app.post('/jobs', opts, async (req, reply) => {
    const body = CreateBackupJobBody.parse(req.body);
    const job = await prisma.backupJob.create({ data: { ...body, scope: body.scope as object, retentionPolicy: body.retentionPolicy as object } });
    return reply.code(201).send(job);
  });

  app.get('/jobs', opts, async () => {
    return prisma.backupJob.findMany({ orderBy: { createdAt: 'desc' } });
  });

  app.get('/jobs/:jobId', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = await prisma.backupJob.findUnique({ where: { id: jobId } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    return job;
  });

  app.put('/jobs/:jobId', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      return await prisma.backupJob.update({ where: { id: jobId }, data: req.body as Record<string, unknown> });
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.delete('/jobs/:jobId', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    await prisma.backupJob.delete({ where: { id: jobId } });
    return reply.code(204).send();
  });

  app.post('/jobs/:jobId/run', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    await backupQueue.add('backup', { jobId });
    return { queued: true };
  });

  app.get('/jobs/:jobId/catalog', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const job = await prisma.backupJob.findUnique({ where: { id: jobId }, include: { s3Destination: true } });
    if (!job) return reply.code(404).send({ error: 'Not found' });
    const s3 = getS3Client(job.s3Destination.encryptedCredentials, job.s3Destination.region);
    const result = await s3.send(new ListObjectsV2Command({
      Bucket: job.s3Destination.bucket,
      Prefix: `${job.s3Destination.prefix}${job.connectionId}/`,
    }));
    return result.Contents ?? [];
  });

  app.post('/jobs/:jobId/restore', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    const { artifactKey, destConnectionId, confirmed } = req.body as {
      artifactKey: string; destConnectionId: string; confirmed: boolean;
    };
    if (!confirmed) return reply.code(400).send({ error: 'Confirmation required' });
    const user = req.user as { email: string };
    await prisma.auditEvent.create({
      data: { actor: user.email, action: 'restore_backup', target: `backup:${artifactKey}`, metadata: { jobId, destConnectionId } },
    });
    await backupQueue.add('restore', { jobId, artifactKey, destConnectionId });
    return { queued: true };
  });

  app.delete('/catalog/:artifactKey', opts, async (req, reply) => {
    const artifactKey = decodeURIComponent((req.params as { artifactKey: string }).artifactKey);
    const { bucket, region, encryptedCredentials } = req.body as {
      bucket: string; region: string; encryptedCredentials: string;
    };
    const user = req.user as { email: string };
    await prisma.auditEvent.create({
      data: { actor: user.email, action: 'delete_backup', target: `s3://${bucket}/${artifactKey}` },
    });
    const s3 = getS3Client(encryptedCredentials, region);
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: artifactKey }));
    return reply.code(204).send();
  });
}
