import { MongoClient, type Collection, type Db } from 'mongodb';
import type {
  DestRecord, InferredColumn, InferredSchema, NamespaceRef,
  NamespaceWriter, WriteResult,
} from '../types.js';

/**
 * Mongo NamespaceWriter.
 *
 * Lifecycle per namespace:
 *   init(ns, schema):
 *     - (optionally) drop existing collection
 *     - create collection
 *     - if mapper signalled composite PK via a `pk` JSONB column, build the
 *       compound unique index on the encoded subdocument fields
 *   writeBatch(ns, batch):
 *     - insertMany({ ordered: false })
 *     - duplicate-key errors swallowed (counted as `skipped`)
 *     - other write errors counted as `failed`
 *   finalize(ns):
 *     - no-op (we don't auto-create FK secondary indexes; that's a Phase 1D feature)
 */
export class MongoWriter implements NamespaceWriter {
  private client: MongoClient | null = null;

  constructor(
    private readonly uri: string,
    private readonly opts: { dropExisting?: boolean; databaseOverride?: string } = {},
  ) {}

  private async connect(): Promise<MongoClient> {
    if (!this.client) {
      this.client = new MongoClient(this.uri, {
        serverSelectionTimeoutMS: 10_000,
        connectTimeoutMS: 10_000,
      });
      await this.client.connect();
    }
    return this.client;
  }

  /**
   * Pick the destination database. By default we use the source `ns.database`
   * (so `public.users` → `public.users` in Mongo). The `databaseOverride`
   * lets the CLI pin all collections into one Mongo DB regardless of source.
   */
  private async db(ns: NamespaceRef): Promise<Db> {
    const client = await this.connect();
    return client.db(this.opts.databaseOverride ?? ns.database);
  }

  async init(ns: NamespaceRef, schema: InferredSchema): Promise<void> {
    const db = await this.db(ns);

    if (this.opts.dropExisting) {
      await db.collection(ns.name).drop().catch(() => {
        // Collection didn't exist — fine, drop is best-effort.
      });
    }

    // createCollection is idempotent in modern Mongo when collection exists;
    // older servers throw NamespaceExists (code 48), which is harmless.
    try {
      await db.createCollection(ns.name);
    } catch (err: unknown) {
      const code = (err as { code?: number }).code;
      if (code !== 48) throw err;
    }

    // Composite PK → compound unique index.
    // The PG→Mongo mapper encodes the original PK column names in
    // `pk.observedTypes` as a hack — we'd refactor this into a structured
    // field in Phase 1C, but it keeps the InferredColumn shape stable today.
    const pkCol = schema.columns.find((c) => c.name === 'pk' && c.type === 'jsonb');
    if (pkCol && pkCol.observedTypes && pkCol.observedTypes.length > 0) {
      const indexSpec: Record<string, 1> = {};
      for (const colName of pkCol.observedTypes as unknown as string[]) {
        indexSpec[`pk.${colName}`] = 1;
      }
      await db.collection(ns.name).createIndex(indexSpec, {
        unique: true,
        name: 'compound_pk',
      }).catch(() => {
        // Index might already exist with a different name — non-fatal.
      });
    }

    // Optional: build FK reference indexes for the "reference" strategy.
    // We index every column that has `references` set so the user can
    // efficiently query "give me orders where user_id = X" against the
    // destination Mongo collection without manual indexing later.
    for (const col of schema.columns) {
      if (!col.references) continue;
      await db.collection(ns.name).createIndex({ [col.name]: 1 }, {
        name: `fk_${col.name}`,
      }).catch(() => {});
    }
  }

  async writeBatch(ns: NamespaceRef, batch: DestRecord[]): Promise<WriteResult> {
    if (batch.length === 0) return { written: 0, skipped: 0, failed: 0 };
    const db = await this.db(ns);
    const coll = db.collection(ns.name);

    try {
      const res = await coll.insertMany(batch, { ordered: false });
      return { written: res.insertedCount, skipped: 0, failed: 0 };
    } catch (err: unknown) {
      // ordered:false partial-success: BulkWriteError carries .result.insertedCount
      // and .writeErrors[] enumerating per-row failures.
      const e = err as {
        code?: number;
        result?: { insertedCount?: number };
        writeErrors?: Array<{ code: number }>;
      };
      const inserted = e.result?.insertedCount ?? 0;
      const writeErrs = e.writeErrors ?? [];
      const dupSkipped = writeErrs.filter((w) => w.code === 11000).length;
      const realFailed = writeErrs.length - dupSkipped;

      // Re-throw if we got an error that isn't bulk-write-related at all.
      if (writeErrs.length === 0 && e.code !== 11000) throw err;

      return {
        written: inserted,
        skipped: dupSkipped,
        failed: realFailed,
      };
    }
  }

  async finalize(_ns: NamespaceRef): Promise<void> {
    // Nothing to do — indexes built in init(), no ANALYZE equivalent.
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.close().catch(() => {});
      this.client = null;
    }
  }

  /** Helper for the CLI: peek at the Mongo collection without leaking the client. */
  async sampleDocs(ns: NamespaceRef, limit = 3): Promise<DestRecord[]> {
    const db = await this.db(ns);
    return db.collection(ns.name).find({}, { limit }).toArray() as Promise<DestRecord[]>;
  }
}

// Quiet the "InferredColumn imported but unused" — referenced by signature only.
void (null as unknown as InferredColumn);
