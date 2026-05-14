import { FastifyInstance } from 'fastify';
import {
  getSnapshot, getReplicaSetStatus, getCurrentOps,
  killOp, getSlowQueries, getDatabaseSizes,
} from '../services/monitor.service.js';

export async function monitorRoutes(app: FastifyInstance) {
  const opts = { preHandler: [app.authenticate] };

  app.get('/:id/monitor/snapshot', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await getSnapshot(id);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get('/:id/monitor/replicaset', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await getReplicaSetStatus(id);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get('/:id/monitor/currentops', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await getCurrentOps(id);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.delete('/:id/monitor/currentops/:opid', opts, async (req, reply) => {
    const { id, opid } = req.params as { id: string; opid: string };
    const { confirmed } = (req.body as { confirmed?: boolean }) ?? {};
    if (!confirmed) return reply.code(400).send({ error: 'Confirmation required' });
    const user = req.user as { email: string };
    try {
      return await killOp(id, opid, user.email);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get('/:id/monitor/slowqueries', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    const { thresholdMs = 100 } = req.query as { thresholdMs?: number };
    try {
      return await getSlowQueries(id, Number(thresholdMs));
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });

  app.get('/:id/monitor/databases/sizes', opts, async (req, reply) => {
    const { id } = req.params as { id: string };
    try {
      return await getDatabaseSizes(id);
    } catch (err) {
      return reply.code(500).send({ error: String(err) });
    }
  });
}

export function registerMonitorSocket(app: FastifyInstance) {
  const io = app.io;
  const ns = io.of(/^\/monitor\/.+$/);

  ns.on('connection', async (socket) => {
    const connectionId = socket.nsp.name.replace('/monitor/', '');
    let interval: ReturnType<typeof setInterval>;

    try {
      interval = setInterval(async () => {
        try {
          const ops = await getCurrentOps(connectionId);
          socket.emit('currentops', ops);
        } catch { /* connection may be unavailable */ }
      }, 3000);

      socket.on('disconnect', () => clearInterval(interval));
    } catch (err) {
      socket.emit('error', String(err));
    }
  });
}
