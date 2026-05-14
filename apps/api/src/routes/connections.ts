import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createConnection, listConnections, getConnection,
  updateConnection, deleteConnection, testConnection,
} from '../services/connection.service.js';

const CreateBody = z.object({
  name: z.string().min(1),
  uri: z.string().min(1),
  tags: z.array(z.string()).default([]),
  readOnly: z.boolean().default(false),
});

const UpdateBody = z.object({
  name: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  readOnly: z.boolean().optional(),
});

export async function connectionRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [app.authenticate] }, async () => {
    return listConnections();
  });

  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    const body = CreateBody.parse(req.body);
    const user = req.user as { email: string };
    try {
      const conn = await createConnection({ ...body, createdBy: user.email });
      return reply.code(201).send(conn);
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  app.get('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const conn = await getConnection(id);
    if (!conn) return reply.code(404).send({ error: 'Not found' });
    return conn;
  });

  app.put('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const body = UpdateBody.parse(req.body);
    try {
      return await updateConnection(id, body);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.delete('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const user = req.user as { email: string };
    try {
      await deleteConnection(id, user.email);
      return reply.code(204).send();
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.post('/:id/test', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await testConnection(id);
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  // Auth: login
  app.post('/auth/login', async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const { prisma } = await import('../lib/prisma.js');
    const { createHash } = await import('node:crypto');
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(401).send({ error: 'Invalid credentials' });
    const hash = createHash('sha256').update(password).digest('hex');
    if (hash !== user.passwordHash) return reply.code(401).send({ error: 'Invalid credentials' });
    const token = app.jwt.sign({ email: user.email, role: user.role }, { expiresIn: '7d' });
    return { token, user: { email: user.email, role: user.role } };
  });

  // Auth: register (first-run or admin-only in production)
  app.post('/auth/register', async (req, reply) => {
    const { email, password, role } = req.body as { email: string; password: string; role?: string };
    const { prisma } = await import('../lib/prisma.js');
    const { createHash } = await import('node:crypto');
    const passwordHash = createHash('sha256').update(password).digest('hex');
    try {
      const user = await prisma.user.create({
        data: { email, passwordHash, role: role ?? 'viewer' },
      });
      return reply.code(201).send({ email: user.email, role: user.role });
    } catch {
      return reply.code(409).send({ error: 'Email already exists' });
    }
  });
}
