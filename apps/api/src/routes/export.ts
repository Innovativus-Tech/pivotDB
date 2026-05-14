import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { createExportJob, listExportJobs, getExportJob, deleteExportJob } from '../services/export.service.js';

const CreateExportBody = z.object({
  connectionId: z.string(),
  database: z.string(),
  collection: z.string(),
  query: z.unknown().default({}),
  isPipeline: z.boolean().default(false),
  format: z.enum(['csv', 'json']),
  options: z.record(z.unknown()).default({}),
  destination: z.string().optional(),
});

export async function exportRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  app.post('/', opts, async (req, reply) => {
    const body = CreateExportBody.parse(req.body);
    const job = await createExportJob(body as Parameters<typeof createExportJob>[0]);
    return reply.code(201).send(job);
  });

  app.get('/', opts, async (req) => {
    const { connectionId } = req.query as { connectionId: string };
    return listExportJobs(connectionId);
  });

  app.get('/:jobId', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      return await getExportJob(jobId);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.get('/:jobId/download', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    try {
      const job = await getExportJob(jobId);
      if (job.status !== 'done' || !job.fileKey) {
        return reply.code(400).send({ error: 'Export not ready' });
      }
      const filePath = job.fileKey;
      if (!fs.existsSync(filePath)) {
        return reply.code(404).send({ error: 'File not found' });
      }
      const fileName = path.basename(filePath);
      reply.header('Content-Disposition', `attachment; filename="${fileName}"`);
      reply.header('Content-Type', job.format === 'csv' ? 'text/csv' : 'application/json');
      return reply.send(fs.createReadStream(filePath));
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.delete('/:jobId', opts, async (req, reply) => {
    const { jobId } = req.params as { jobId: string };
    await deleteExportJob(jobId);
    return reply.code(204).send();
  });
}
