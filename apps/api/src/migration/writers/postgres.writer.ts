import { Client, type ClientConfig } from 'pg';
import { from as copyFrom } from 'pg-copy-streams';
import { pipeline as streamPipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type {
  ChangeEvent, DestRecord, InferredSchema, NamespaceRef, NamespaceWriter, WriteResult,
} from '../types.js';
import { buildCreateTable, pgColumnList } from '../ddl/postgres-ddl.js';

/**
 * Postgres NamespaceWriter using COPY FROM STDIN for bulk inserts.
 *
 * COPY is 10–50× faster than multi-row INSERT for large loads because it
 * skips parser overhead per row. We use the *text* COPY format because it's
 * easier to debug than binary and within ~20% of binary speed.
 *
 * One pg.Client per writer instance — pools are unnecessary because we write
 * one table at a time per worker.
 */
export class PostgresWriter implements NamespaceWriter {
  private client: Client | null = null;
  // Column order per namespace — populated by init(), consumed by writeBatch().
  private columnsByNs = new Map<string, string[]>();

  constructor(
    private readonly uri: string,
    private readonly opts: { schemaName?: string; dropExisting?: boolean } = {},
  ) {}

  private nsKey(ns: NamespaceRef): string {
    return `${ns.database}.${ns.name}`;
  }

  private async connect(): Promise<Client> {
    if (!this.client) {
      const needsSsl = /sslmode=(require|verify-ca|verify-full)/.test(this.uri);
      const cfg: ClientConfig = {
        connectionString: this.uri,
        connectionTimeoutMillis: 10_000,
        // Long-running migrations — no statement timeout on the writer side.
        // Individual COPY calls usually take seconds, but a 5-million-row
        // commit could exceed a 10s default.
        ssl: needsSsl ? { rejectUnauthorized: false } : undefined,
      };
      this.client = new Client(cfg);
      await this.client.connect();

      // Disable FK + trigger checks for the duration of this connection.
      // We re-enable in finalize() per-table. This dramatically speeds up
      // multi-table migrations because we don't need to topologically sort
      // tables or worry about constraint order within a single write.
      await this.client.query(`SET session_replication_role = 'replica';`).catch(() => {});
    }
    return this.client;
  }

  async init(ns: NamespaceRef, schema: InferredSchema): Promise<void> {
    const client = await this.connect();

    // Cache column order so writeBatch knows what shape to serialise.
    this.columnsByNs.set(this.nsKey(ns), pgColumnList(schema));

    const stmts = buildCreateTable(schema, {
      schemaName: this.opts.schemaName ?? 'public',
      tableName: ns.name,
      ifNotExists: !this.opts.dropExisting,
      drop: this.opts.dropExisting,
    });

    // Ensure target schema exists. CREATE SCHEMA is idempotent.
    const schemaName = this.opts.schemaName ?? 'public';
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schemaName}";`);

    for (const sql of stmts) {
      await client.query(sql);
    }
  }

  async writeBatch(ns: NamespaceRef, batch: DestRecord[]): Promise<WriteResult> {
    if (batch.length === 0) return { written: 0, skipped: 0, failed: 0 };
    const client = await this.connect();
    const columns = this.columnsByNs.get(this.nsKey(ns));
    if (!columns) throw new Error(`writeBatch called before init() for ${this.nsKey(ns)}`);

    const schemaName = this.opts.schemaName ?? 'public';
    const qualified = `"${schemaName}"."${ns.name}"`;
    const colList = columns.map((c) => `"${c}"`).join(', ');

    // Build the COPY stream + a Readable that emits TSV-encoded rows.
    const copyStream = client.query(
      copyFrom(`COPY ${qualified} (${colList}) FROM STDIN WITH (FORMAT text, NULL '\\N')`),
    );
    const source = Readable.from(encodeRows(batch, columns));

    try {
      await streamPipeline(source, copyStream);
      return { written: batch.length, skipped: 0, failed: 0 };
    } catch (err) {
      // COPY is all-or-nothing per batch — if it fails, every row in this
      // batch is rejected. Report as failed and let the pipeline decide
      // whether to retry, halve the batch, or abort.
      return { written: 0, skipped: 0, failed: batch.length };
    }
  }

  /**
   * CDC apply path for Postgres.
   *
   * insert / update → INSERT … ON CONFLICT (pk) DO UPDATE SET …
   *   This is idempotent: re-delivering the same event on a crash-restart
   *   just updates the row to the same values.
   *
   * delete → DELETE WHERE pk = $1
   *   No-op if already gone — also idempotent.
   *
   * We derive PK columns from `event.key`. For SQL sources the key is always
   * { col: value } pairs. For Mongo sources coming through a mapper the key
   * is { _id: "hexstring" }.
   */
  async applyChange(event: ChangeEvent): Promise<void> {
    const client = await this.connect();
    const schemaName = this.opts.schemaName ?? 'public';
    const table = `"${schemaName}"."${event.ns.name}"`;
    const pkCols = Object.keys(event.key);

    if (event.op === 'delete') {
      const whereClauses = pkCols.map((c, i) => `"${c}" = $${i + 1}`).join(' AND ');
      await client.query(
        `DELETE FROM ${table} WHERE ${whereClauses}`,
        pkCols.map((c) => pgVal(event.key[c])),
      );
      return;
    }

    if (!event.doc) throw new Error(`PG CDC ${event.op} missing doc`);
    const doc = event.doc;
    const cols = Object.keys(doc);
    const vals = cols.map((c) => pgVal(doc[c]));
    const colList = cols.map((c) => `"${c}"`).join(', ');
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const updateSet = cols
      .filter((c) => !pkCols.includes(c))
      .map((c) => `"${c}" = EXCLUDED."${c}"`)
      .join(', ');
    const conflictCols = pkCols.map((c) => `"${c}"`).join(', ');

    if (updateSet) {
      await client.query(
        `INSERT INTO ${table} (${colList}) VALUES (${placeholders})
         ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateSet}`,
        vals,
      );
    } else {
      // All columns are part of PK — nothing to update; just ensure it exists.
      await client.query(
        `INSERT INTO ${table} (${colList}) VALUES (${placeholders})
         ON CONFLICT (${conflictCols}) DO NOTHING`,
        vals,
      );
    }
  }

  async finalize(ns: NamespaceRef): Promise<void> {
    const client = await this.connect();
    const schemaName = this.opts.schemaName ?? 'public';
    // Update planner stats — important after a bulk load or query planning
    // will be wildly off for the next few minutes.
    await client.query(`ANALYZE "${schemaName}"."${ns.name}";`).catch(() => {});
  }

  async close(): Promise<void> {
    if (this.client) {
      // Restore normal trigger/FK behavior before disconnecting so subsequent
      // sessions on this connection (if pooled by anything else) aren't tainted.
      await this.client.query(`SET session_replication_role = 'origin';`).catch(() => {});
      await this.client.end().catch(() => {});
      this.client = null;
    }
  }
}

/**
 * Generator that yields TSV rows in COPY-text-format encoding.
 *
 * COPY format reference (text mode):
 *   - columns separated by TAB
 *   - rows terminated by LF
 *   - NULL serialized as literal \N (we configured NULL '\N' above)
 *   - backslash, tab, LF, CR inside values must be escaped: \\, \t, \n, \r
 *
 * We yield one full row at a time (Readable.from will buffer + apply
 * backpressure) so the COPY stream never has to wait on a partial line.
 */
function* encodeRows(rows: DestRecord[], columns: string[]): Generator<string> {
  for (const row of rows) {
    const fields = new Array<string>(columns.length);
    for (let i = 0; i < columns.length; i++) {
      const v = row[columns[i]];
      fields[i] = encodeField(v);
    }
    yield fields.join('\t') + '\n';
  }
}

/** Coerce a value for pg parameterised query (not COPY). */
function pgVal(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object' || Array.isArray(v)) return JSON.stringify(v);
  return v;
}

function encodeField(v: unknown): string {
  if (v === null || v === undefined) return '\\N';
  // Buffers are written as Postgres bytea hex literal: \xDEADBEEF
  if (Buffer.isBuffer(v)) return '\\\\x' + v.toString('hex');
  const s = typeof v === 'string' ? v : String(v);
  // Escape COPY's metacharacters. Order matters: backslash first.
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\t/g, '\\t')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}
