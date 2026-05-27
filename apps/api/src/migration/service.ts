import { prisma } from '../lib/prisma.js';
import { decrypt } from '../crypto/encrypt.js';
import { isValidDbType } from '../lib/uri-validators.js';
import type { DbType } from '../lib/clients/index.js';
import { MongoReader } from './readers/mongo.reader.js';
import { PostgresReader } from './readers/postgres.reader.js';
import { MySqlReader } from './readers/mysql.reader.js';
import { MongoWriter } from './writers/mongo.writer.js';
import { PostgresWriter } from './writers/postgres.writer.js';
import { MySqlWriter } from './writers/mysql.writer.js';
import { MongoToPostgresMapper } from './mappers/mongo-to-pg.mapper.js';
import { PostgresToMongoMapper } from './mappers/pg-to-mongo.mapper.js';
import { MongoToMysqlMapper } from './mappers/mongo-to-mysql.mapper.js';
import { MysqlToMongoMapper } from './mappers/mysql-to-mongo.mapper.js';
import { PostgresToMysqlMapper } from './mappers/postgres-to-mysql.mapper.js';
import { MysqlToPostgresMapper } from './mappers/mysql-to-postgres.mapper.js';
import type { NamespaceReader, NamespaceWriter, RecordMapper, InferredSchema } from './types.js';

/**
 * Build the (reader, writer, mapperFactory) triple appropriate for a job row.
 *
 * Supported directions:
 *   Phase 1: mongodb ↔ postgres
 *   Phase 2: mongodb ↔ mysql
 *   Phase 3: postgres ↔ mysql
 */
export interface MigrationPlan {
  reader: NamespaceReader;
  writer: NamespaceWriter;
  makeMapper: (sourceSchema: InferredSchema) => RecordMapper;
  /** Resolved source database / schema name (already defaulted). */
  sourceDatabase: string;
}

export async function buildMigrationPlan(jobId: string): Promise<MigrationPlan> {
  const job = await prisma.migrationJobV2.findUniqueOrThrow({
    where: { id: jobId },
    include: { source: true, destination: true },
  });

  const sourceType = normaliseDbType(job.sourceType);
  const destType = normaliseDbType(job.destType);

  const sourceUri = decrypt(job.source.encryptedUri);
  const destUri = decrypt(job.destination.encryptedUri);

  const key = `${sourceType}→${destType}`;
  switch (key) {
    case 'mongodb→postgres': {
      const sourceDb = job.sourceDatabase ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mongodb → postgres');
      return {
        reader: new MongoReader(sourceUri),
        writer: new PostgresWriter(destUri, {
          schemaName: job.destDatabase ?? 'public',
          dropExisting: job.dropExisting,
        }),
        makeMapper: (schema) => new MongoToPostgresMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'postgres→mongodb': {
      const sourceDb = job.sourceDatabase ?? 'public';
      return {
        reader: new PostgresReader(sourceUri, { schemaName: sourceDb }),
        writer: new MongoWriter(destUri, {
          dropExisting: job.dropExisting,
          databaseOverride: job.destDatabase ?? undefined,
        }),
        makeMapper: (schema) => new PostgresToMongoMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'mongodb→mysql': {
      const sourceDb = job.sourceDatabase ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mongodb → mysql');
      return {
        reader: new MongoReader(sourceUri),
        writer: new MySqlWriter(destUri, {
          dbName: job.destDatabase ?? undefined,
          dropExisting: job.dropExisting,
        }),
        makeMapper: (schema) => new MongoToMysqlMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'mysql→mongodb': {
      const sourceDb = job.sourceDatabase ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mysql → mongodb');
      return {
        reader: new MySqlReader(sourceUri, { dbName: sourceDb }),
        writer: new MongoWriter(destUri, {
          dropExisting: job.dropExisting,
          databaseOverride: job.destDatabase ?? undefined,
        }),
        makeMapper: (schema) => new MysqlToMongoMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'postgres→mysql': {
      const sourceDb = job.sourceDatabase ?? 'public';
      return {
        reader: new PostgresReader(sourceUri, { schemaName: sourceDb }),
        writer: new MySqlWriter(destUri, {
          dbName: job.destDatabase ?? undefined,
          dropExisting: job.dropExisting,
        }),
        makeMapper: (schema) => new PostgresToMysqlMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    case 'mysql→postgres': {
      const sourceDb = job.sourceDatabase ?? '';
      if (!sourceDb) throw new Error('sourceDatabase required for mysql → postgres');
      return {
        reader: new MySqlReader(sourceUri, { dbName: sourceDb }),
        writer: new PostgresWriter(destUri, {
          schemaName: job.destDatabase ?? 'public',
          dropExisting: job.dropExisting,
        }),
        makeMapper: (schema) => new MysqlToPostgresMapper(schema),
        sourceDatabase: sourceDb,
      };
    }
    default:
      throw new Error(
        `Migration direction "${key}" is not yet supported. ` +
        `Supported: mongodb↔postgres, mongodb↔mysql, postgres↔mysql.`,
      );
  }
}

function normaliseDbType(s: string): DbType {
  if (!isValidDbType(s)) throw new Error(`Unknown dbType "${s}"`);
  return s;
}
