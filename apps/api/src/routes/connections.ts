import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  createConnection, listConnections, getConnection,
  updateConnection, deleteConnection, testConnection,
} from '../services/connection.service.js';
import { profileScope, requireAdmin, requireSuperAdmin } from '../plugins/auth.js';
import { prisma } from '../lib/prisma.js';
import { createHash } from 'node:crypto';

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

interface JWTUser {
  userId: string;
  email: string;
  role: 'superadmin' | 'admin' | 'viewer';
  profileId: string | null;
}

export async function connectionRoutes(app: FastifyInstance) {
  app.get('/', { preHandler: [app.authenticate] }, async (req) => {
    const scope = profileScope(req);
    return listConnections(scope);
  });

  app.post('/', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const body = CreateBody.parse(req.body);
    const user = req.user as JWTUser;
    if (!user.profileId) return reply.code(400).send({ error: 'No profile assigned' });
    try {
      const conn = await createConnection({ ...body, createdBy: user.email, profileId: user.profileId });
      return reply.code(201).send(conn);
    } catch (err) {
      return reply.code(400).send({ error: String(err) });
    }
  });

  app.get('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const scope = profileScope(req);
    const conn = await getConnection(id, scope);
    if (!conn) return reply.code(404).send({ error: 'Not found' });
    return conn;
  });

  app.put('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const body = UpdateBody.parse(req.body);
    const scope = profileScope(req);
    try {
      return await updateConnection(id, body, scope);
    } catch {
      return reply.code(404).send({ error: 'Not found' });
    }
  });

  app.delete('/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const user = req.user as JWTUser;
    const scope = profileScope(req);
    try {
      await deleteConnection(id, user.email, scope);
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

  // ── Auth routes ────────────────────────────────────────────────────────────

  app.post('/auth/login', async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string };
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return reply.code(401).send({ error: 'Invalid credentials' });
    const hash = createHash('sha256').update(password).digest('hex');
    if (hash !== user.passwordHash) return reply.code(401).send({ error: 'Invalid credentials' });
    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    const payload: JWTUser = {
      userId: user.id,
      email: user.email,
      role: user.role as JWTUser['role'],
      profileId: user.profileId,
    };
    const token = app.jwt.sign(payload, { expiresIn: '7d' });
    return { token, user: { id: user.id, email: user.email, role: user.role, profileId: user.profileId } };
  });

  // Register — only works when 0 users exist (creates superadmin)
  app.post('/auth/register', async (req, reply) => {
    const { email, password } = req.body as { email: string; password: string; role?: string };
    const count = await prisma.user.count();
    if (count > 0) {
      return reply.code(403).send({ error: 'Registration is closed. Contact your super admin.' });
    }
    const passwordHash = createHash('sha256').update(password).digest('hex');
    try {
      const user = await prisma.user.create({
        data: { email, passwordHash, role: 'superadmin' },
      });
      return reply.code(201).send({ email: user.email, role: user.role });
    } catch {
      return reply.code(409).send({ error: 'Email already exists' });
    }
  });

  // ── Profile management routes (superadmin only) ────────────────────────────

  app.post('/profiles', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const { name, adminEmail, adminPassword } = req.body as {
      name: string; adminEmail: string; adminPassword: string;
    };
    const passwordHash = createHash('sha256').update(adminPassword).digest('hex');
    try {
      const adminUser = await prisma.user.create({
        data: { email: adminEmail, passwordHash, role: 'admin' },
      });
      const profile = await prisma.profile.create({
        data: { name, adminId: adminUser.id },
      });
      await prisma.user.update({ where: { id: adminUser.id }, data: { profileId: profile.id } });
      return reply.code(201).send({ profile, adminUser: { id: adminUser.id, email: adminUser.email } });
    } catch {
      return reply.code(409).send({ error: 'Email already exists' });
    }
  });

  app.get('/profiles', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    return prisma.profile.findMany({
      include: { users: { select: { id: true, email: true, role: true, createdAt: true, lastLoginAt: true } } },
      orderBy: { createdAt: 'asc' },
    });
  });

  app.delete('/profiles/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    await prisma.user.deleteMany({ where: { profileId: id } });
    await prisma.profile.delete({ where: { id } });
    return reply.code(204).send();
  });

  // Invite viewer to a profile (admin of that profile or superadmin)
  app.post('/profiles/:id/viewers', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const user = req.user as JWTUser;
    if (user.role === 'admin' && user.profileId !== id) {
      return reply.code(403).send({ error: 'Can only invite to your own profile' });
    }
    const { email, password } = req.body as { email: string; password: string };
    const passwordHash = createHash('sha256').update(password).digest('hex');
    try {
      const viewer = await prisma.user.create({
        data: { email, passwordHash, role: 'viewer', profileId: id, invitedBy: user.userId },
      });
      return reply.code(201).send({ id: viewer.id, email: viewer.email, role: viewer.role });
    } catch {
      return reply.code(409).send({ error: 'Email already exists' });
    }
  });

  app.get('/profiles/:id/viewers', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id } = req.params as { id: string };
    const user = req.user as JWTUser;
    if (user.role === 'admin' && user.profileId !== id) {
      return reply.code(403).send({ error: 'Access denied' });
    }
    return prisma.user.findMany({
      where: { profileId: id, role: 'viewer' },
      select: { id: true, email: true, createdAt: true, lastLoginAt: true },
    });
  });

  app.delete('/profiles/:id/viewers/:userId', { preHandler: [app.authenticate] }, async (req, reply) => {
    if (!requireAdmin(req, reply)) return;
    const { id, userId } = req.params as { id: string; userId: string };
    const user = req.user as JWTUser;
    if (user.role === 'admin' && user.profileId !== id) {
      return reply.code(403).send({ error: 'Access denied' });
    }
    await prisma.user.delete({ where: { id: userId, profileId: id, role: 'viewer' } });
    return reply.code(204).send();
  });
}
