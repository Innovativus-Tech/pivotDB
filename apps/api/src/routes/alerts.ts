import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma.js';

const CreateRuleBody = z.object({
  connectionId: z.string(),
  metric: z.string(),
  condition: z.object({ operator: z.enum(['gt', 'lt', 'gte', 'lte']), threshold: z.number() }),
  durationSec: z.number().int().positive(),
  channels: z.array(z.object({ type: z.enum(['email', 'webhook']), target: z.string() })),
  enabled: z.boolean().default(true),
});

export async function alertRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  app.post('/rules', opts, async (req, reply) => {
    const body = CreateRuleBody.parse(req.body);
    const rule = await prisma.alertRule.create({ data: { ...body, condition: body.condition, channels: body.channels } });
    return reply.code(201).send(rule);
  });

  app.get('/rules', opts, async () => {
    return prisma.alertRule.findMany({ orderBy: { createdAt: 'desc' } });
  });

  app.put('/rules/:id', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = CreateRuleBody.partial().parse(req.body);
    try {
      return await prisma.alertRule.update({ where: { id }, data: body as Record<string, unknown> });
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.delete('/rules/:id', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    await prisma.alertRule.delete({ where: { id } });
    return reply.code(204).send();
  });

  app.get('/events', opts, async (req) => {
    const { page = 1, pageSize = 50 } = req.query as { page?: number; pageSize?: number };
    const skip = (Number(page) - 1) * Number(pageSize);
    return prisma.alertEvent.findMany({
      orderBy: { firedAt: 'desc' },
      skip,
      take: Number(pageSize),
      include: { rule: true },
    });
  });

  app.post('/events/:id/acknowledge', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { note } = (req.body as { note?: string }) ?? {};
    return prisma.alertEvent.update({ where: { id }, data: { acknowledged: true, note } });
  });
}
