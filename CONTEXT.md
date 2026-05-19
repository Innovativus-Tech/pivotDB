# MongoDB Visualizer — Project Context

> Paste this file into Claude chat to give full context about the codebase before asking questions or requesting changes.

---

## What This Is

A full-stack **MongoDB management platform** built as a pnpm monorepo. It lets teams connect to MongoDB instances (including Atlas), explore data, run exports, sync between clusters, schedule backups, migrate with mongodump/mongorestore, monitor live ops, and set alerts — all through a browser UI.

---

## Monorepo Layout

```
mongodb-visualizer/
├── apps/
│   ├── api/          # Fastify REST + Socket.IO backend (Node.js, TypeScript)
│   │   ├── src/
│   │   │   ├── index.ts              # Entry point, registers all routes & workers
│   │   │   ├── routes/               # HTTP route handlers
│   │   │   │   ├── connections.ts    # Connections + auth + profiles CRUD
│   │   │   │   ├── explore.ts        # Collection query / aggregation / schema
│   │   │   │   ├── export.ts         # Export job creation + file download
│   │   │   │   ├── sync.ts           # Sync job CRUD + run/dryrun
│   │   │   │   ├── backup.ts         # R2 destinations + backup job CRUD + restore
│   │   │   │   ├── migration.ts      # Migration job CRUD + preflight
│   │   │   │   ├── alerts.ts         # Alert rules + events
│   │   │   │   ├── monitor.ts        # currentOp, serverStatus, slow queries
│   │   │   │   ├── metrics.ts        # Prometheus metrics scrape endpoint
│   │   │   │   └── health.ts         # /health/live, /health/ready
│   │   │   ├── jobs/                 # BullMQ workers
│   │   │   │   ├── export.job.ts     # Collection export (JSON/CSV) + database tar.gz export
│   │   │   │   ├── sync.job.ts       # Data sync between two connections
│   │   │   │   ├── backup.job.ts     # mongodump → R2 upload
│   │   │   │   └── migration.job.ts  # Orchestrates migration.service.ts
│   │   │   ├── services/             # Business logic
│   │   │   │   ├── migration.service.ts  # mongodump + mongorestore pipeline
│   │   │   │   ├── connection.service.ts
│   │   │   │   ├── export.service.ts
│   │   │   │   ├── alert.service.ts
│   │   │   │   ├── metrics.service.ts
│   │   │   │   ├── monitor.service.ts
│   │   │   │   └── schema.service.ts
│   │   │   ├── plugins/
│   │   │   │   ├── auth.ts           # JWT plugin, profileScope(), requireAdmin()
│   │   │   │   └── socketio.ts       # Socket.IO plugin
│   │   │   ├── scheduler/index.ts    # Cron scheduler for sync/backup jobs
│   │   │   ├── lib/
│   │   │   │   ├── prisma.ts         # Prisma client singleton
│   │   │   │   ├── mongo.ts          # getFreshClient() — MongoDB driver client pool
│   │   │   │   ├── queue.ts          # BullMQ queue instances
│   │   │   │   ├── redis.ts          # Redis connection
│   │   │   │   ├── r2.ts             # Cloudflare R2 / S3 client
│   │   │   │   └── s3.ts             # AWS S3 client
│   │   │   └── crypto/encrypt.ts     # AES-256 encrypt/decrypt for stored URIs
│   │   └── prisma/schema.prisma      # Database schema
│   └── web/          # React frontend (Vite, TypeScript)
│       └── src/
│           ├── App.tsx               # React Router routes
│           ├── pages/
│           │   ├── Connections.tsx   # Connection list + add/edit/test/delete
│           │   ├── Explore.tsx       # Query editor, aggregation, schema graph
│           │   ├── Monitor.tsx       # Live currentOp, Grafana panels
│           │   ├── Move.tsx          # Export + Sync jobs
│           │   ├── Migrate.tsx       # Migration jobs (mongodump/mongorestore)
│           │   ├── Protect.tsx       # Backup jobs
│           │   ├── Settings.tsx      # Users, profiles, audit log
│           │   └── Login.tsx
│           ├── components/
│           │   ├── shared/           # Layout, ConfirmModal, JobStatusBadge
│           │   ├── connections/      # AddConnectionModal
│           │   ├── explore/          # AggregationEditor, SchemaGraph
│           │   └── monitor/          # CurrentOpsTable, GrafanaPanel
│           ├── lib/
│           │   ├── api.ts            # Axios instance (JWT in headers)
│           │   ├── socket.ts         # Socket.IO client
│           │   └── utils.ts          # cn(), formatBytes(), formatDate(), humanCron()
│           └── stores/connections.store.ts  # Zustand store
├── config/
│   ├── prometheus/prometheus.yml
│   └── grafana/
├── docker-compose.yml               # postgres, redis, prometheus, grafana, api, web
└── pnpm-workspace.yaml
```

---

## Tech Stack

| Layer | Technology |
|---|---|
| Runtime | Node.js 20, TypeScript (ESM) |
| API framework | Fastify 4 |
| Auth | JWT (fastify-jwt), SHA-256 password hashing |
| Database (meta) | PostgreSQL via Prisma ORM |
| Queue / workers | BullMQ + Redis |
| MongoDB driver | `mongodb` official driver |
| Migrations / backups | `mongodump` / `mongorestore` CLI |
| Encryption | AES-256-GCM for stored connection URIs |
| Backup storage | Cloudflare R2 (S3-compatible) |
| Frontend | React 18, Vite, React Router v6 |
| UI components | shadcn/ui (Tailwind CSS + Radix) |
| State | Zustand (connections), React Query (server data) |
| Real-time | Socket.IO (migration logs, currentOp) |
| Monitoring | Prometheus metrics endpoint + Grafana |
| Dev infra | Docker Compose (postgres:5432, redis:6379, grafana:3003, prometheus:9090) |

---

## Running Services (dev)

| Service | URL | Credentials |
|---|---|---|
| Web UI | http://localhost:5173 | admin@localhost / changeme |
| API | http://localhost:3001 | — |
| PostgreSQL | localhost:5432 | postgres / changeme, DB: mongovis |
| Redis | localhost:6379 | — |
| Grafana | http://localhost:3003 | admin / admin |
| Prometheus | http://localhost:9090 | — |

**Start order:**
```bash
docker compose -f docker-compose.yml up -d postgres redis prometheus grafana
cd apps/api && pnpm dev    # tsx watch, port 3001
cd apps/web && pnpm dev    # Vite, port 5173
```

**API env** (`apps/api/.env`):
```
DATABASE_URL=postgresql://postgres:changeme@localhost:5432/mongovis
REDIS_URL=redis://localhost:6379
JWT_SECRET=...
ENCRYPTION_KEY=...
SUPERADMIN_EMAIL=admin@localhost
SUPERADMIN_PASSWORD=changeme
PORT=3001
```

---

## Database Schema (Prisma)

```
Profile          — tenant/team. Has one admin user, many connections/jobs.
User             — email + passwordHash + role (superadmin | admin | viewer) + profileId?
Connection       — MongoDB URI (AES-encrypted), topology, tags, readOnly flag
R2Destination    — Cloudflare R2 bucket config (encrypted keys)
ExportJob        — One export run: db, collection?, format, query/pipeline, exportType
SyncJob          — Recurring or one-shot sync between two connections
BackupJob        — Scheduled mongodump → R2 upload
MigrationJob     — One-time mongodump + mongorestore between two connections
MigrationRun     — Execution record with log lines, phase, status
JobRun           — Generic run record for export/sync/backup (status, counts, errorReport)
AlertRule        — Metric threshold + notification channel (email/webhook)
AlertEvent       — Fired alert instance
SavedQuery       — Named query/pipeline stored per connection
AuditEvent       — Append-only log of admin actions
```

---

## Auth & RBAC

Three roles — every request is profile-scoped except superadmin:

| Role | Can do |
|---|---|
| `superadmin` | Everything; no profileId; can manage profiles/users globally |
| `admin` | Full CRUD within their profile |
| `viewer` | Read-only within their profile |

**Key helpers in `plugins/auth.ts`:**
- `profileScope(req)` — returns Prisma `where` clause `{ profileId }` (empty object for superadmin, allowing all)
- `requireAdmin(req, reply)` — returns false + 403 if viewer
- `requireSuperAdmin(req, reply)` — returns false + 403 if not superadmin

**Superadmin caveat:** JWT has `profileId: null`. Routes that create jobs must look up `profileId` from the associated connection record:
```ts
let profileId = user.profileId;
if (!profileId) {
  const conn = await prisma.connection.findUnique({ where: { id: body.connectionId }, select: { profileId: true } });
  profileId = conn?.profileId ?? null;
}
```

---

## API Routes

All routes prefixed `/api/`. Auth via `Authorization: Bearer <jwt>`.

```
POST   /connections/auth/login            Login
POST   /connections/auth/register         First-run superadmin registration

GET    /connections                        List connections (profile-scoped)
POST   /connections                        Create connection
PUT    /connections/:id                    Update connection
DELETE /connections/:id                    Delete connection
POST   /connections/:id/test               Test connectivity

GET/POST/DELETE /connections/profiles      Profile management (superadmin)
POST   /connections/profiles/:id/viewers  Invite viewer

GET    /connections/:id/databases          List databases
GET    /connections/:id/databases/:db/collections   List collections
POST   /connections/:id/query              Run find query
POST   /connections/:id/aggregate          Run aggregation pipeline
GET    /connections/:id/schema             Infer schema for a collection

POST   /export                             Create export job
GET    /export/:jobId/download             Stream file download
GET    /export/:jobId/status               Poll job status

GET    /sync                               List sync jobs
POST   /sync                               Create sync job
PUT    /sync/:jobId                        Update sync job
DELETE /sync/:jobId                        Delete sync job
POST   /sync/:jobId/run                    Trigger immediate run
POST   /sync/:jobId/dryrun                 Dry run (no writes)
GET    /sync/:jobId/runs                   Run history

GET    /backup/r2-destinations             List R2 destinations
POST   /backup/r2-destinations             Add R2 destination
DELETE /backup/r2-destinations/:destId     Remove R2 destination
GET    /backup/jobs                        List backup jobs
POST   /backup/jobs                        Create backup job
POST   /backup/jobs/:jobId/run             Trigger backup now
GET    /backup/jobs/:jobId/catalog         List R2 artifacts
POST   /backup/jobs/:jobId/restore         Trigger restore

GET    /migration                          List migration jobs
POST   /migration                          Create + enqueue migration
POST   /migration/preflight                Check connections + environment
GET    /migration/:jobId                   Get job + latest run
GET    /migration/:jobId/runs              Run history

GET    /alerts/rules                       List alert rules
POST   /alerts/rules                       Create alert rule
PUT    /alerts/rules/:id                   Update alert rule
DELETE /alerts/rules/:id                   Delete alert rule
GET    /alerts/events                      Alert event history

GET    /connections/:id/monitor/current-op   Live currentOp
GET    /connections/:id/monitor/server-status
GET    /connections/:id/monitor/slow-queries

GET    /metrics                            Prometheus scrape endpoint
GET    /health/live
GET    /health/ready

GET    /api/settings/audit                 Audit log (paginated)
GET    /api/settings/users                 All users
DELETE /api/settings/users/:id             Delete user
```

---

## Frontend Pages

### `/connections` — Connections
List all connections. Add (with URI test), edit tags/name, test, delete. Tags for labeling (e.g. "prod", "atlas").

### `/explore` — Explore
Pick a connection → database → collection. Run find queries with JSON filter, or write aggregation pipelines. View schema graph (auto-inferred field types). Save queries. Export directly from results.

### `/monitor` — Monitor
Live `currentOp` table (auto-refreshes). Server stats. Grafana panels embedded via iframe. Kill operations.

### `/move` — Move (Export + Sync)
Two tabs:
- **Export**: Pick connection, database, optionally a collection. Choose JSON or CSV. For database-level exports, downloads a `.tar.gz` with one file per collection. Poll status and download when ready.
- **Sync**: Create sync jobs between two connections. Three write modes: `insertOnly`, `upsert`, `replace`. Schedule with a human-friendly builder (every N minutes / hourly / daily / weekly / monthly) with cron preview. Run Now with live status feedback. Delete jobs.

### `/migrate` — Migrate
Full mongodump + mongorestore pipeline. Pick source/destination connection, select scope (all DBs or specific), configure options:
- `Drop Destination` — drops only in-scope databases before restore
- `Drop All Destination` ⚠️ — wipes ENTIRE destination (all non-system DBs) regardless of scope
- `Preserve Users`, `Oplog`, `Gzip`, `Parallel collections`

Preflight check validates both connections before running. Live streaming log via Socket.IO. Run history with status badges.

### `/protect` — Protect (Backups)
Configure Cloudflare R2 destinations. Create scheduled backup jobs (mongodump → R2). View backup catalog, trigger restores.

### `/settings` — Settings
- Users list (superadmin: see all; admin: see own profile)
- Profile management (superadmin: create tenant profiles with admin user)
- Invite viewers to a profile
- Audit log (all admin actions)

---

## Key Implementation Details

### Connection URI Encryption
All MongoDB URIs stored AES-256-GCM encrypted in `Connection.encryptedUri`. `decrypt()` is called only inside workers/services, never exposed to the frontend.

### Export Pipeline
**Collection export** — Streams documents through a Transform to build JSON array or CSV, writes to `/tmp/mongovis/export_<id>.<ext>`. Custom `docToJson()` replacer handles BSON types (ObjectId → hex string, Date → ISO, Decimal128/Long → string, Binary → base64) without importing the `bson` package (avoids v6/v7 conflict with the MongoDB driver's internal bson).

**Database export** — Lists all collections, writes each to a temp staging dir (JSON array or CSV), then packs everything into a `.tar.gz` with the `tar` npm package. Includes optional `_metadata.json` with document counts and indexes.

### Sync Worker
Three write modes in `flushBatch()`:
- `insertOnly` — `insertMany` with `ordered: false`; only ignores duplicate-key errors (code 11000)
- `upsert` — `bulkWrite` with `replaceOne + upsert: true` per document
- `replace` — drops destination collection first, then `insertMany`

System databases (`admin`, `local`, `config`) are always excluded from sync scope. Stale BullMQ jobs (sync job deleted from DB) are silently discarded rather than retried.

### Migration Service
1. Optional pre-drop via MongoDB driver (not `--drop` flag) to cleanly remove destination DBs
2. `mongodump` with `--tlsInsecure` auto-applied for Atlas SRV URIs (`mongodb+srv://`)
3. `mongorestore` from the temp dump directory
4. Real-time log streaming via Socket.IO events `migration:log:<jobId>` and `migration:done:<jobId>`
5. Temp dir cleaned up on success and failure

### Scheduler
`scheduler/index.ts` runs on startup, loads all enabled sync and backup jobs with cron schedules from the DB, and registers them with a cron library. Fires BullMQ jobs on schedule.

### Human-readable cron (`humanCron` in utils.ts)
Converts 5-part cron expressions to English:
- `*/15 * * * *` → "Every 15 minutes"
- `30 * * * *` → "Every hour at :30"
- `0 9 * * *` → "Every day at 09:00"
- `0 9 * * 1` → "Every Monday at 09:00"
- `0 9 1 * *` → "Every month on day 1 at 09:00"

---

## Common Patterns

**API fetch in frontend** (`lib/api.ts`): Axios instance with base URL `/` (proxied to port 3001 via Vite config) and JWT auto-injected from `localStorage.getItem('token')`.

**Profile-scoped queries**: Every list query passes `profileScope(req)` to Prisma `where`. Superadmin gets `{}` (no filter = see all). Regular users get `{ profileId: user.profileId }`.

**BullMQ worker pattern**: Each worker (`startXxxWorker()`) is called once on startup. Jobs are enqueued by routes. Workers read job data (`jobId`), fetch full record from Prisma, do the work, update status.

**Socket.IO events**: Migration log lines emitted as `migration:log:<jobId>` with `{ phase, line }`. Frontend subscribes on the job detail page.

---

## Known Gotchas

1. **Superadmin has `profileId: null`** — any route that creates a resource must look up `profileId` from the connection, not the JWT.
2. **Atlas blocks `local` DB** — always filter `systemDbs = new Set(['admin', 'local', 'config'])` from sync/migration scope.
3. **`mongodump --oplog`** only works on replica sets and only for full (unscoped) dumps. Skip it for scoped database dumps.
4. **BSON version conflict** — don't `import { EJSON } from 'bson'`. The MongoDB driver bundles bson internally (v7); importing bson v6 from npm causes `BSONVersionError`. Use the custom `docToJson()` replacer instead.
5. **archiver v8 API changed** — `require('archiver')` no longer returns a function. Use the `tar` npm package instead.
6. **BullMQ stale jobs** — when a sync job is deleted from the DB, its scheduled repeat jobs in Redis still fire. The worker now calls `findUnique` (not `findUniqueOrThrow`) and returns early if the record is gone.
