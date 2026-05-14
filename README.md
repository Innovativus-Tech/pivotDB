# MongoDB Advanced Data Visualizer

A production-grade, self-hostable web application for connecting to any MongoDB deployment and getting schema visualization, real-time Grafana-powered monitoring, data exports, deployment sync, and automated S3 backups — all from a single interface.

## Architecture

```
Browser (React App :3000)
  ├── REST API  → Fastify API (:3001)
  ├── Socket.IO → Fastify API (:3001)  [current-ops, slow-query live feed]
  └── Grafana iframes → Grafana (:3003) [all time-series monitoring charts]

Fastify API (:3001)
  ├── /api/connections    CRUD + test
  ├── /api/.../explore    schema sampling, query, aggregate
  ├── /api/.../monitor    snapshot, replica set, currentops, slow queries
  ├── /api/export         CSV/JSON export jobs (BullMQ)
  ├── /api/sync           deployment-to-deployment sync (BullMQ)
  ├── /api/backup         S3 backup jobs (BullMQ)
  ├── /api/alerts         alert rules + events
  ├── /health/*           liveness + readiness
  └── /metrics            Prometheus text format (no auth)

Prometheus (:9090) → scrapes /metrics every 15s
Grafana (:3003)    → reads Prometheus, serves pre-provisioned dashboards
PostgreSQL (:5432) → metadata, jobs, users (Prisma)
Redis (:6379)      → BullMQ job queue
```

## Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Docker Desktop

## Quick Start (5 commands)

```bash
# 1. Clone and enter the project
cd mongodb-visualizer

# 2. Copy and fill in secrets
cp .env.example .env
# Edit .env — set ENCRYPTION_KEY and JWT_SECRET (openssl rand -hex 32)

# 3. Start infrastructure
docker compose up -d postgres redis prometheus grafana

# 4. Install dependencies and initialize database
pnpm install
cd apps/api && pnpm prisma migrate dev --name init && pnpm prisma generate && cd ../..

# 5. Start dev servers
pnpm dev
```

- Web UI:    http://localhost:5173
- API:       http://localhost:3001
- Grafana:   http://localhost:3003
- Prometheus: http://localhost:9090

## Environment Variables

| Variable | Description | Required |
|---|---|---|
| `POSTGRES_PASSWORD` | PostgreSQL password | Yes |
| `ENCRYPTION_KEY` | 64-char hex string (32 bytes) for AES-256-GCM | Yes |
| `JWT_SECRET` | 64-char hex string for JWT signing | Yes |
| `GRAFANA_ADMIN_USER` | Grafana admin username (default: admin) | No |
| `GRAFANA_ADMIN_PASSWORD` | Grafana admin password | No |
| `TEMP_DIR` | Directory for export/backup temp files | No |
| `SMTP_HOST` | SMTP host for alert emails | No |
| `PROMETHEUS_URL` | Prometheus URL for alert evaluation | No |

Generate secrets:
```bash
openssl rand -hex 32   # ENCRYPTION_KEY
openssl rand -hex 32   # JWT_SECRET
```

## Production Deployment

```bash
docker compose up --build
```

Services:
| Service | URL |
|---|---|
| Web App | http://localhost:3000 |
| API | http://localhost:3001 |
| Grafana | http://localhost:3003 |
| Prometheus | http://localhost:9090 |

## Adding Your First Connection

1. Open http://localhost:5173 and create an account
2. Go to **Connections** → **Add Connection**
3. Enter your MongoDB URI (e.g. `mongodb://user:pass@host:27017`)
4. Click **Test Connection** — verify latency and version
5. Click **Add Connection**

Wait 15 seconds for Prometheus to scrape the first metrics, then open **Monitor** to see live Grafana dashboards.

## Grafana Dashboard

Pre-provisioned panels:
- Current/Available Connections (stat)
- Resident Memory (stat)
- WiredTiger Cache % (gauge)
- Operations Per Second (time-series)
- Memory Usage (time-series)
- Network Throughput (time-series)
- Replication Lag (time-series — replica sets only)

Open the full dashboard: http://localhost:3003/d/mongodb-adv-vis

## Five Capability Pillars

| Pillar | What it does |
|---|---|
| **P1 Data Visualization** | Schema graph, document explorer, query builder, aggregation editor |
| **P2 Real-Time Monitoring** | Grafana dashboards + live current-ops table + slow query feed |
| **P3 Export** | CSV/JSON streaming export of any query or full collection |
| **P4 Data Sync** | Scheduled or on-demand source → destination replication |
| **P5 S3 Backups** | Encrypted, checksummed, scheduled backups to Amazon S3 |
# MongoDB-Visualizer
