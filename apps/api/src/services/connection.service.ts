import { MongoClient } from 'mongodb';
import { prisma } from '../lib/prisma.js';
import { encrypt, decrypt } from '../crypto/encrypt.js';
import { closeMongoClient } from '../lib/mongo.js';

export interface ConnectionPublic {
  id: string;
  name: string;
  topology: string;
  tags: string[];
  readOnly: boolean;
  createdBy: string;
  profileId: string;
  createdAt: Date;
  updatedAt: Date;
}

export async function detectTopology(uri: string): Promise<{ topology: string; version: string; latencyMs: number }> {
  const start = Date.now();
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  try {
    await client.connect();
    const admin = client.db('admin');
    const hello = await admin.command({ hello: 1 });
    const latencyMs = Date.now() - start;
    let topology = 'standalone';
    if (hello.setName) topology = 'replicaSet';
    else if (hello.msg === 'isdbgrid') topology = 'sharded';
    const buildInfo = await admin.command({ buildInfo: 1 });
    return { topology, version: buildInfo.version as string, latencyMs };
  } finally {
    await client.close();
  }
}

export function sanitizeConnection(conn: {
  id: string; name: string; topology: string; tags: string[];
  readOnly: boolean; createdBy: string; profileId: string; createdAt: Date; updatedAt: Date;
}): ConnectionPublic {
  return {
    id: conn.id,
    name: conn.name,
    topology: conn.topology,
    tags: conn.tags,
    readOnly: conn.readOnly,
    createdBy: conn.createdBy,
    profileId: conn.profileId,
    createdAt: conn.createdAt,
    updatedAt: conn.updatedAt,
  };
}

export async function createConnection(data: {
  name: string; uri: string; tags: string[]; readOnly: boolean; createdBy: string; profileId: string;
}): Promise<ConnectionPublic> {
  const { topology } = await detectTopology(data.uri);
  const conn = await prisma.connection.create({
    data: {
      name: data.name,
      encryptedUri: encrypt(data.uri),
      topology,
      tags: data.tags,
      readOnly: data.readOnly,
      createdBy: data.createdBy,
      profileId: data.profileId,
    },
  });
  return sanitizeConnection(conn);
}

export async function listConnections(scope: Record<string, unknown> = {}): Promise<ConnectionPublic[]> {
  const conns = await prisma.connection.findMany({ where: scope, orderBy: { createdAt: 'desc' } });
  return conns.map(sanitizeConnection);
}

export async function getConnection(id: string, scope: Record<string, unknown> = {}): Promise<ConnectionPublic | null> {
  const conn = await prisma.connection.findFirst({ where: { id, ...scope } });
  return conn ? sanitizeConnection(conn) : null;
}

export async function updateConnection(id: string, data: {
  name?: string; tags?: string[]; readOnly?: boolean;
}, scope: Record<string, unknown> = {}): Promise<ConnectionPublic> {
  const existing = await prisma.connection.findFirst({ where: { id, ...scope } });
  if (!existing) throw new Error('Not found');
  const conn = await prisma.connection.update({ where: { id }, data });
  return sanitizeConnection(conn);
}

export async function deleteConnection(id: string, actor: string, scope: Record<string, unknown> = {}): Promise<void> {
  const existing = await prisma.connection.findFirst({ where: { id, ...scope } });
  if (!existing) throw new Error('Not found');
  await prisma.$transaction(async (tx) => {
    await tx.syncJob.updateMany({ where: { OR: [{ sourceConnId: id }, { destConnId: id }] }, data: { enabled: false } });
    await tx.backupJob.updateMany({ where: { connectionId: id }, data: { status: 'paused' } });
    await tx.auditEvent.create({
      data: { actor, action: 'delete_connection', target: `connection:${id}` },
    });
    await tx.connection.delete({ where: { id } });
  });
  await closeMongoClient(id).catch(() => {});
}

export async function testConnection(id: string): Promise<{ latencyMs: number; serverVersion: string; topology: string }> {
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id } });
  const uri = decrypt(conn.encryptedUri);
  const result = await detectTopology(uri);
  return { latencyMs: result.latencyMs, serverVersion: result.version, topology: result.topology };
}

export async function getDecryptedUri(id: string): Promise<string> {
  const conn = await prisma.connection.findUniqueOrThrow({ where: { id } });
  return decrypt(conn.encryptedUri);
}
