import { Client } from 'pg';
import type { DbClient, DiscoveredColumn, DiscoveredNamespace, ProbeResult } from './types.js';

/**
 * Postgres implementation of DbClient.
 *
 * Uses a single `pg.Client` (not a pool) since each instance is short-lived —
 * one per UI probe / discovery request. Real migrations will use pools.
 *
 * SSL handling: if the URI ends with `?sslmode=require` (Supabase, Render, etc.)
 * `pg` parses it automatically. For self-signed certs we set
 * `rejectUnauthorized: false` so users don't have to upload a CA on first try.
 */
export class PostgresDbClient implements DbClient {
  readonly dbType = 'postgres' as const;
  private client: Client | null = null;

  constructor(private readonly uri: string) {}

  private async connect(): Promise<Client> {
    if (!this.client) {
      const needsSsl = /sslmode=(require|verify-ca|verify-full)/.test(this.uri);
      this.client = new Client({
        connectionString: this.uri,
        connectionTimeoutMillis: 5000,
        statement_timeout: 10_000,
        // Lenient SSL by default — managed PGs (Supabase, Neon, RDS) need this.
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      });
      await this.client.connect();
    }
    return this.client;
  }

  async probe(): Promise<ProbeResult> {
    const start = Date.now();
    const client = await this.connect();
    const res = await client.query<{ version: string; current_database: string; schemas: string[] }>(
      `SELECT
         current_setting('server_version') AS version,
         current_database() AS current_database,
         array(SELECT schema_name::text FROM information_schema.schemata
               WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')) AS schemas`,
    );
    const latencyMs = Date.now() - start;
    const row = res.rows[0];
    return {
      version: row.version,
      latencyMs,
      topology: 'standalone',
      metadata: {
        currentDatabase: row.current_database,
        schemas: row.schemas,
      },
    };
  }

  async listDatabases(): Promise<string[]> {
    const client = await this.connect();
    const res = await client.query<{ datname: string }>(
      `SELECT datname FROM pg_database
       WHERE datistemplate = false AND datname NOT IN ('postgres','template0','template1')
       ORDER BY datname`,
    );
    return res.rows.map((r) => r.datname);
  }

  /**
   * For Postgres "database" arg = a schema (typically "public"). If omitted,
   * we walk every non-system schema in the *current* database.
   *
   * We don't connect to other Postgres databases — that would need fresh
   * Clients with rewritten URIs. The UI lets the user pick which DB to
   * connect to up front.
   */
  async discoverSchema(database?: string): Promise<DiscoveredNamespace[]> {
    const client = await this.connect();
    const schemas = database
      ? [database]
      : (await client.query<{ schema_name: string }>(
          `SELECT schema_name FROM information_schema.schemata
           WHERE schema_name NOT IN ('pg_catalog','information_schema','pg_toast')`,
        )).rows.map((r) => r.schema_name);

    const out: DiscoveredNamespace[] = [];

    for (const schema of schemas) {
      const tables = await client.query<{ table_name: string; approx_count: number }>(
        `SELECT c.relname AS table_name,
                c.reltuples::bigint AS approx_count
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = $1 AND c.relkind IN ('r','p')
         ORDER BY c.relname`,
        [schema],
      );

      for (const t of tables.rows) {
        const cols = await client.query<{
          column_name: string;
          data_type: string;
          is_nullable: 'YES' | 'NO';
          is_pk: boolean;
          fk_target: string | null;
        }>(
          `SELECT
             c.column_name,
             c.udt_name AS data_type,
             c.is_nullable,
             (
               EXISTS (
                 SELECT 1 FROM information_schema.table_constraints tc
                 JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
                 WHERE tc.constraint_type='PRIMARY KEY' AND tc.table_schema=c.table_schema
                   AND tc.table_name=c.table_name AND kcu.column_name=c.column_name
               )
             ) AS is_pk,
             (
               SELECT ccu.table_schema || '.' || ccu.table_name || '.' || ccu.column_name
               FROM information_schema.table_constraints tc
               JOIN information_schema.key_column_usage kcu USING (constraint_name, table_schema)
               JOIN information_schema.constraint_column_usage ccu USING (constraint_name, table_schema)
               WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=c.table_schema
                 AND tc.table_name=c.table_name AND kcu.column_name=c.column_name
               LIMIT 1
             ) AS fk_target
           FROM information_schema.columns c
           WHERE c.table_schema=$1 AND c.table_name=$2
           ORDER BY c.ordinal_position`,
          [schema, t.table_name],
        );

        // pg_class.reltuples returns -1 until ANALYZE runs on a fresh table.
        // Treat negative values as "unknown" instead of surfacing -1 to the UI.
        const rawCount = Number(t.approx_count);
        const approxCount = Number.isFinite(rawCount) && rawCount >= 0 ? rawCount : undefined;

        out.push({
          database: schema,
          name: t.table_name,
          approxCount,
          columns: cols.rows.map<DiscoveredColumn>((r) => ({
            name: r.column_name,
            type: normalizePgType(r.data_type),
            nullable: r.is_nullable === 'YES',
            primaryKey: r.is_pk || undefined,
            references: r.fk_target ?? undefined,
          })),
        });
      }
    }
    return out;
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.end().catch(() => {});
      this.client = null;
    }
  }
}

/** Map Postgres internal type names (`pg_type.typname`) to our canonical tokens. */
function normalizePgType(t: string): string {
  // Strip leading underscore (array types: _int4 → int4[])
  if (t.startsWith('_')) return normalizePgType(t.slice(1)) + '[]';
  const map: Record<string, string> = {
    int2: 'int', int4: 'int', int8: 'long',
    float4: 'float', float8: 'double',
    numeric: 'decimal', money: 'decimal',
    bool: 'boolean',
    text: 'string', varchar: 'string', char: 'string', bpchar: 'string',
    uuid: 'uuid',
    json: 'json', jsonb: 'jsonb',
    bytea: 'binary',
    date: 'date',
    timestamp: 'timestamp', timestamptz: 'timestamp',
    time: 'time', timetz: 'time',
  };
  return map[t] ?? t;
}
