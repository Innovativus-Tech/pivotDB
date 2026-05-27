import mysql, { type Connection } from 'mysql2/promise';
import type {
  ChangeEvent, DestRecord, InferredSchema, NamespaceRef, NamespaceWriter, WriteResult,
} from '../types.js';
import { buildMysqlCreateTable, mysqlColumnList } from '../ddl/mysql-ddl.js';

const INSERT_CHUNK = 500; // rows per multi-row INSERT statement

/**
 * MySQL NamespaceWriter using multi-row INSERT for bulk loads.
 *
 * MySQL doesn't have a COPY protocol like Postgres, but multi-row INSERT
 * (INSERT INTO t (cols) VALUES (...),(...),(...)) is 5–20× faster than
 * individual row inserts because it amortises round-trip and parse overhead.
 *
 * FK checks are disabled for the session duration and re-enabled in close().
 * This lets us insert in any order without topologically sorting tables.
 */
export class MySqlWriter implements NamespaceWriter {
  private conn: Connection | null = null;
  private columnsByNs = new Map<string, string[]>();

  constructor(
    private readonly uri: string,
    private readonly opts: { dbName?: string; dropExisting?: boolean } = {},
  ) {}

  private nsKey(ns: NamespaceRef): string {
    return `${ns.database}.${ns.name}`;
  }

  private async connect(): Promise<Connection> {
    if (!this.conn) {
      this.conn = await mysql.createConnection({
        uri: this.uri,
        connectTimeout: 10_000,
        charset: 'utf8mb4',
        multipleStatements: false,
      });
      // Disable FK checks for the migration session.
      await this.conn.query('SET FOREIGN_KEY_CHECKS = 0;');
      // Use READ COMMITTED to reduce lock contention during inserts.
      await this.conn.query("SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED;");
    }
    return this.conn;
  }

  async init(ns: NamespaceRef, schema: InferredSchema): Promise<void> {
    const conn = await this.connect();
    const dbName = this.opts.dbName ?? ns.database;

    this.columnsByNs.set(this.nsKey(ns), mysqlColumnList(schema));

    const stmts = buildMysqlCreateTable(schema, {
      dbName,
      tableName: ns.name,
      ifNotExists: !this.opts.dropExisting,
      drop: this.opts.dropExisting,
    });

    // Ensure database exists. If it already does, skip the CREATE so users
    // without global CREATE privilege (the typical case for app-scoped MySQL
    // accounts) can still migrate into a pre-provisioned database.
    const [existsRows] = await conn.query<mysql.RowDataPacket[]>(
      `SELECT 1 AS x FROM information_schema.schemata WHERE schema_name = ? LIMIT 1`,
      [dbName],
    );
    if (existsRows.length === 0) {
      try {
        await conn.query(
          `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`,
        );
      } catch (err) {
        throw new Error(
          `Cannot create destination database "${dbName}": ${(err as Error).message}. ` +
          `Either create it manually first, or grant CREATE privilege to the migration user.`,
        );
      }
    }

    for (const sql of stmts) {
      await conn.query(sql);
    }
  }

  async writeBatch(ns: NamespaceRef, batch: DestRecord[]): Promise<WriteResult> {
    if (batch.length === 0) return { written: 0, skipped: 0, failed: 0 };

    const conn = await this.connect();
    const columns = this.columnsByNs.get(this.nsKey(ns));
    if (!columns) throw new Error(`writeBatch called before init() for ${this.nsKey(ns)}`);

    const dbName = this.opts.dbName ?? ns.database;
    const colList = columns.map((c) => '`' + c + '`').join(', ');
    const placeholders = '(' + columns.map(() => '?').join(', ') + ')';

    // Split into chunks to avoid hitting max_allowed_packet.
    let written = 0;
    let failed  = 0;
    let lastError: Error | null = null;

    for (let i = 0; i < batch.length; i += INSERT_CHUNK) {
      const chunk = batch.slice(i, i + INSERT_CHUNK);
      const values: unknown[] = [];
      const rowPlaceholders: string[] = [];

      for (const row of chunk) {
        rowPlaceholders.push(placeholders);
        for (const col of columns) {
          values.push(encodeValue(row[col]));
        }
      }

      const sql = `INSERT INTO \`${dbName}\`.\`${ns.name}\` (${colList}) VALUES ${rowPlaceholders.join(', ')}`;
      try {
        await conn.query(sql, values);
        written += chunk.length;
      } catch (err) {
        failed += chunk.length;
        lastError = err as Error;
        // Log the first chunk failure per namespace with enough context to
        // diagnose. Avoids spamming logs on huge migrations.
        if (written === 0 && failed === chunk.length) {
          console.error(
            `[mysql-writer] INSERT into ${dbName}.${ns.name} failed: ${(err as Error).message}\n` +
            `  declared columns: [${columns.join(', ')}]\n` +
            `  sample row keys:  [${Object.keys(chunk[0]).join(', ')}]\n` +
            `  sample row:       ${JSON.stringify(chunk[0]).slice(0, 500)}`,
          );
        }
      }
    }

    // If every row failed, throw so the pipeline marks the namespace as
    // FAILED (not "partial") and the error message reaches `MigrationRunV2.errors`.
    // Otherwise return counts; "partial" semantics work fine for mixed batches.
    if (failed > 0 && written === 0 && lastError) {
      throw new Error(`All MySQL inserts failed for ${dbName}.${ns.name}: ${lastError.message}`);
    }
    return { written, skipped: 0, failed };
  }

  async finalize(ns: NamespaceRef): Promise<void> {
    // MySQL doesn't need an explicit ANALYZE — the optimizer uses real-time
    // stats. We could run ANALYZE TABLE here for large loads, but it's optional.
    // Skip to keep finalize fast.
  }

  /**
   * CDC apply path for MySQL.
   *
   * insert / update → INSERT … ON DUPLICATE KEY UPDATE col = VALUES(col), …
   *   Idempotent: re-delivering the same event just updates to the same values.
   *
   * delete → DELETE WHERE pk_col = ? (AND …)
   *   No-op if already gone — idempotent.
   */
  async applyChange(event: ChangeEvent): Promise<void> {
    const conn = await this.connect();
    const dbName = this.opts.dbName ?? event.ns.database;
    const table = `\`${dbName}\`.\`${event.ns.name}\``;
    const pkCols = Object.keys(event.key);

    if (event.op === 'delete') {
      const where = pkCols.map((c) => `\`${c}\` = ?`).join(' AND ');
      await conn.query(
        `DELETE FROM ${table} WHERE ${where}`,
        pkCols.map((c) => encodeValue(event.key[c])),
      );
      return;
    }

    if (!event.doc) throw new Error(`MySQL CDC ${event.op} missing doc`);
    const doc = event.doc;
    const cols = Object.keys(doc);
    const colList = cols.map((c) => `\`${c}\``).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const vals = cols.map((c) => encodeValue(doc[c]));

    // Non-PK columns get UPDATE on duplicate key.
    const updateCols = cols.filter((c) => !pkCols.includes(c));
    if (updateCols.length > 0) {
      const updateSet = updateCols.map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
      await conn.query(
        `INSERT INTO ${table} (${colList}) VALUES (${placeholders})
         ON DUPLICATE KEY UPDATE ${updateSet}`,
        vals,
      );
    } else {
      // All columns are PK — use INSERT IGNORE to skip exact duplicates.
      await conn.query(
        `INSERT IGNORE INTO ${table} (${colList}) VALUES (${placeholders})`,
        vals,
      );
    }
  }

  async close(): Promise<void> {
    if (this.conn) {
      await this.conn.query('SET FOREIGN_KEY_CHECKS = 1;').catch(() => {});
      await this.conn.end().catch(() => {});
      this.conn = null;
    }
  }
}

function encodeValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return v;
  if (v instanceof Date) return v;
  if (typeof v === 'object' || Array.isArray(v)) return JSON.stringify(v);
  return v;
}
