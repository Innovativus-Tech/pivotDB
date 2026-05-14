import { MongoClient } from 'mongodb';
import { decrypt } from '../crypto/encrypt.js';
import { prisma } from '../lib/prisma.js';
import { getMongoClient } from '../lib/mongo.js';

export async function getClientForConnection(connectionId: string) {
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id: connectionId } });
  const uri  = decrypt(conn.encryptedUri);
  return { client: await getMongoClient(connectionId, uri), conn };
}

export async function getSnapshot(connectionId: string) {
  const { client } = await getClientForConnection(connectionId);
  const admin = client.db('admin');
  const status = await admin.command({ serverStatus: 1 });
  return {
    connections: status.connections,
    opcounters: status.opcounters,
    mem: status.mem,
    network: status.network,
    uptime: status.uptime,
    version: status.version,
    storageEngine: status.storageEngine?.name,
    wiredTiger: status.wiredTiger ? {
      cacheUsed: status.wiredTiger.cache?.['bytes currently in the cache'],
      cacheMax:  status.wiredTiger.cache?.['maximum bytes configured'],
    } : undefined,
  };
}

export async function getReplicaSetStatus(connectionId: string) {
  const { client } = await getClientForConnection(connectionId);
  try {
    const rs = await client.db('admin').command({ replSetGetStatus: 1 });
    return rs;
  } catch {
    return null;
  }
}

export async function getCurrentOps(connectionId: string) {
  const { client } = await getClientForConnection(connectionId);
  const result = await client.db('admin').command({ currentOp: 1, active: true });
  return (result.inprog as Array<Record<string, unknown>>).map((op) => ({
    opid:      op['opid'],
    ns:        op['ns'],
    op:        op['op'],
    secs_running: op['secs_running'],
    microsecs_running: op['microsecs_running'],
    client:    op['client'],
    desc:      op['desc'],
    planSummary: op['planSummary'],
  }));
}

export async function killOp(connectionId: string, opid: number | string, actor: string) {
  const { client } = await getClientForConnection(connectionId);
  const result = await client.db('admin').command({ killOp: 1, op: opid });
  await prisma.auditEvent.create({
    data: { actor, action: 'kill_op', target: `op:${opid}`, metadata: { connectionId } },
  });
  return result;
}

export async function getSlowQueries(connectionId: string, thresholdMs = 100) {
  const { client } = await getClientForConnection(connectionId);
  try {
    const profile = await client.db('admin').collection('system.profile')
      .find({ millis: { $gte: thresholdMs } })
      .sort({ ts: -1 })
      .limit(50)
      .toArray();
    return profile;
  } catch {
    return [];
  }
}

export async function getDatabaseSizes(connectionId: string) {
  const { client } = await getClientForConnection(connectionId);
  const admin = client.db('admin');
  const dbList = await admin.command({ listDatabases: 1 });
  const result = [];
  for (const db of dbList.databases as Array<{ name: string; sizeOnDisk: number }>) {
    const dbStats = await client.db(db.name).command({ dbStats: 1 });
    result.push({
      name: db.name,
      sizeOnDisk: db.sizeOnDisk,
      dataSize: dbStats.dataSize,
      storageSize: dbStats.storageSize,
      indexSize: dbStats.indexSize,
      collections: dbStats.collections,
    });
  }
  return result;
}
