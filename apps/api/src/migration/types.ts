/**
 * Core types for the cross-engine migration pipeline.
 *
 * The pipeline is composed of three roles, one implementation per direction:
 *
 *     ┌──────────┐   docs   ┌──────────┐  rows   ┌──────────┐
 *     │  Reader  │ ───────▶ │  Mapper  │ ──────▶ │  Writer  │
 *     └──────────┘          └──────────┘         └──────────┘
 *
 *   Reader  — yields raw records from the source (Mongo cursor, PG cursor, …)
 *   Mapper  — transforms each record + generates init/teardown (DDL, indexes)
 *   Writer  — applies batches to the destination
 *
 * The orchestrator in pipeline.ts wires them together with backpressure,
 * batching, and per-namespace progress reporting.
 *
 * Adding a new engine = implement Reader + Writer for it; cross-engine mappers
 * are then a permutation problem (N readers × N writers needs at most N²/2
 * mapper modules, often less when types are symmetric).
 */

/** A logical namespace in a database — a collection (Mongo) or a table (SQL). */
export interface NamespaceRef {
  /** Database (Mongo) / schema (Postgres) / database (MySQL) containing the namespace. */
  database: string;
  /** Collection or table name. */
  name: string;
}

/** A single row/document streaming through the pipeline. Source-side shape. */
export type SourceRecord = Record<string, unknown>;
/** A single row/document streaming through the pipeline. Destination-side shape. */
export type DestRecord = Record<string, unknown>;

/**
 * The intermediate schema descriptor produced by Inference (Mongo→SQL) or by
 * the SQL DbClient.discoverSchema() (SQL→Mongo). Both directions use the same
 * shape, so a Writer always sees the same input regardless of which Reader
 * filled it in.
 */
export interface InferredSchema {
  namespace: NamespaceRef;
  /** Approximate row/doc count discovered during inference (for progress %). */
  approxCount?: number;
  columns: InferredColumn[];
  /** Type-mismatch / coercion warnings surfaced to the user before run. */
  warnings: SchemaWarning[];
}

export interface InferredColumn {
  /** Column / field name. Will be sanitised into a SQL identifier by DDL gen. */
  name: string;
  /** Canonical type token (see migration/canonical-types.ts). */
  type: CanonicalType;
  /** True if any sampled doc lacked this field, or if the SQL col is nullable. */
  nullable: boolean;
  /** True if this is the primary key (Mongo _id or SQL PK). */
  primaryKey?: boolean;
  /** "schema.table.column" for SQL FK columns. Unused for Mongo→SQL. */
  references?: string;
  /** For mongo→SQL inference: how many sampled docs had this field. */
  presenceCount?: number;
  /** For mongo→SQL inference: distinct types seen if the field was mixed. */
  observedTypes?: CanonicalType[];
}

/** A coercion or compatibility note that the user should see before running. */
export interface SchemaWarning {
  namespace: NamespaceRef;
  column?: string;
  severity: 'info' | 'warn' | 'error';
  code: string;     // stable token for i18n / dedup, e.g. "mixed_type_field"
  message: string;  // human-readable
}

/**
 * Canonical type tokens — the lingua franca between Readers and Writers.
 * Engine-specific Inference modules map their native types into this set;
 * engine-specific DDL/Mapping modules map this set back into native types.
 *
 * Keep this set MINIMAL. Adding a token requires updating every writer + mapper.
 */
export type CanonicalType =
  | 'string'      // TEXT / VARCHAR / String
  | 'int'         // INT4
  | 'long'        // INT8 / BSON Long
  | 'float'       // REAL
  | 'double'      // DOUBLE PRECISION
  | 'decimal'     // NUMERIC / BSON Decimal128
  | 'boolean'
  | 'date'        // DATE
  | 'timestamp'   // TIMESTAMPTZ / Mongo Date
  | 'time'
  | 'binary'      // BYTEA / Buffer
  | 'uuid'
  | 'objectid'    // 24-char hex string when targeting SQL
  | 'json'        // JSON (used for typed JSON in SQL)
  | 'jsonb'       // JSONB (Postgres) — generic fallback for nested objects / arrays
  | 'array'       // Mongo array of scalars; SQL side maps to JSONB unless promoted
  | 'mixed'       // Multiple observed types — DDL gen will widen to TEXT/JSONB + warn
  | 'null'        // Only sampled as null — DDL gen treats as nullable TEXT
  | 'unknown';    // Couldn't classify — treated like 'mixed'

/**
 * Reader — pulls records out of a source namespace as an async stream.
 *
 * Implementations MUST:
 *   - emit one fully-formed record per yield (no partial buffering)
 *   - call .return() / cleanup on early break in the consumer
 *   - use a server-side cursor or equivalent to bound memory
 */
export interface NamespaceReader {
  /** List namespaces in scope for this migration. */
  listNamespaces(database?: string): Promise<NamespaceRef[]>;
  /**
   * Sample the namespace to produce an inferred schema (Mongo) or
   * read its declared schema (SQL). The pipeline calls this once per ns
   * before init/streaming so the writer can prepare DDL.
   */
  inferSchema(ns: NamespaceRef, opts: { sampleSize: number }): Promise<InferredSchema>;
  /** Best-effort exact count, used for progress %. May be expensive — pipeline
   *  may skip calling it if the user prefers fast-start. */
  countExact(ns: NamespaceRef): Promise<number>;
  /** Stream all records of the namespace. */
  read(ns: NamespaceRef): AsyncIterable<SourceRecord>;
  /** Release any held resources. Idempotent. */
  close(): Promise<void>;
}

/**
 * Writer — applies records to a destination namespace.
 *
 * Lifecycle per namespace:
 *   init(ns, schema) → writeBatch * N → finalize(ns)
 *
 * The schema passed to init() is the *destination* schema descriptor produced
 * by the mapper, so each writer can implement DDL in its own dialect.
 */
export interface NamespaceWriter {
  /** Initialise destination — create table/collection, indexes, etc. */
  init(ns: NamespaceRef, schema: InferredSchema): Promise<void>;
  /** Apply a batch and return how many rows actually landed. */
  writeBatch(ns: NamespaceRef, batch: DestRecord[]): Promise<WriteResult>;
  /** Post-load tasks — ANALYZE, secondary indexes, sequence resync. */
  finalize(ns: NamespaceRef): Promise<void>;
  /** Release any held resources. Idempotent. */
  close(): Promise<void>;
}

export interface WriteResult {
  /** Rows the destination accepted. */
  written: number;
  /** Rows the writer dropped intentionally (e.g. duplicate _id in insertOnly). */
  skipped: number;
  /** Rows the destination rejected. */
  failed: number;
}

/**
 * Mapper — transforms records from source shape into destination shape.
 *
 * Stateful: holds the InferredSchema, derives the destination column order,
 * accumulates warnings discovered at row-level (not just schema-level).
 */
export interface RecordMapper {
  /**
   * Produce a destination-side schema descriptor from a source-side one.
   * For Mongo→PG this *is* the source schema (sampled fields become columns).
   * For PG→Mongo it's a 1:1 translation with FK rules applied.
   */
  translateSchema(source: InferredSchema): InferredSchema;
  /** Per-record transform. Must be pure + sync (called per row in the hot path). */
  mapRecord(rec: SourceRecord): DestRecord;
  /** Warnings discovered at row-mapping time (sparse-field, coercion failure). */
  drainWarnings(): SchemaWarning[];
}

/** Per-namespace progress tick emitted by the pipeline. */
export interface MigrationProgress {
  namespace: NamespaceRef;
  phase: 'inferring' | 'initialising' | 'streaming' | 'finalising' | 'done' | 'failed';
  written: number;
  skipped: number;
  failed: number;
  approxTotal?: number;
  error?: string;
}

/** Options accepted by the pipeline orchestrator. */
export interface PipelineOptions {
  /** How many docs sampled per collection during Mongo inference. Default 1000. */
  sampleSize?: number;
  /** Rows per writeBatch call. Default 1000. */
  batchSize?: number;
  /** Run up to N namespaces concurrently. Default 1 (serial). */
  parallelism?: number;
  /** Subset of source namespaces. If omitted, all are migrated. */
  namespaces?: NamespaceRef[];
  /** Restrict to a single source database. */
  database?: string;
  /** Called on every progress tick — wire to Socket.io / DB / stdout. */
  onProgress?: (p: MigrationProgress) => void;
  /** Called for every warning emitted by mapper or inference. */
  onWarning?: (w: SchemaWarning) => void;
  /** If true, skip writeBatch and finalize — only run inference + DDL preview. */
  dryRun?: boolean;
}
