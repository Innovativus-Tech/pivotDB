import { FastifyInstance } from 'fastify';
import { metricsService } from '../services/metrics.service.js';

export async function metricsRoutes(app: FastifyInstance) {
  app.get('/metrics', async (_req, reply) => {
    const metrics = await metricsService.getMetrics();
    reply.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(metrics);
  });
}
