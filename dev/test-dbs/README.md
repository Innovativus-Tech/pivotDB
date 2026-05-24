# Local test fixtures — Postgres + MySQL

These containers are for **local development only**. They are not referenced by
the production `docker-compose.yml` and don't ship to Coolify.

## Start

```bash
cd dev/test-dbs
docker compose up -d
```

First boot runs the SQL files in `postgres/` and `mysql/` automatically.

## Connection strings

Paste these into the "Add Connection" modal of the running app:

| Engine | URI |
|---|---|
| Postgres | `postgresql://test:test@localhost:5433/testdb` |
| MySQL    | `mysql://test:test@localhost:3307/testdb` |

> Ports are `5433` and `3307` (not the defaults) to avoid colliding with the
> app's own metadata Postgres on `5432` or any host-installed MySQL on `3306`.

## What's in them

Both DBs seed an identical mini-e-commerce schema:

- `users` — scalars + JSON metadata + (PG-only) text[] tags
- `orders` — FK to users, decimal totals, status enum, timestamp
- `order_items` — FK to orders, decimal price, qty
- `cart_items` — **composite PK** `(cart_id, product_sku)`

The shape is chosen to exercise:

- FK chains (ordering matters in SQL→SQL migrations)
- NULL columns (`full_name`, `metadata`)
- Decimal precision (`total_cents`, `unit_price`)
- JSON/JSONB
- `tinyint(1)` boolean convention (MySQL)
- `ENUM` (MySQL) vs `TEXT` with check constraint (PG)
- `UUID` (PG) — no native MySQL equivalent
- Composite primary keys (no clean Mongo `_id` mapping)

## Stop / reset

```bash
docker compose down          # keep data
docker compose down -v       # wipe volumes — next start re-seeds
```
