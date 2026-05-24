-- Seed data for the local Postgres test fixture.
-- Loaded automatically by the official postgres image on first boot.
--
-- Designed to exercise the things the migration engine will care about:
--   * Multiple tables with FK relationships (users → orders → order_items)
--   * NULL columns
--   * Decimal/numeric types (price)
--   * Timestamp types (created_at)
--   * JSONB column (metadata)
--   * Text array (tags)
--   * UUID column
--   * Composite PK (cart_items)

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE users (
  id          SERIAL PRIMARY KEY,
  email       TEXT NOT NULL UNIQUE,
  full_name   TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT true,
  tags        TEXT[] DEFAULT '{}',
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE orders (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_uuid   UUID NOT NULL DEFAULT gen_random_uuid(),
  total_cents  NUMERIC(12,2) NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  placed_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE order_items (
  id           SERIAL PRIMARY KEY,
  order_id     INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku          TEXT NOT NULL,
  qty          INTEGER NOT NULL CHECK (qty > 0),
  unit_price   NUMERIC(10,2) NOT NULL
);

-- Composite PK — tests an edge case for Mongo target (single _id).
CREATE TABLE cart_items (
  cart_id      INTEGER NOT NULL,
  product_sku  TEXT NOT NULL,
  qty          INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (cart_id, product_sku)
);

INSERT INTO users (email, full_name, tags, metadata) VALUES
  ('alice@example.com', 'Alice Andersson', ARRAY['vip','beta'], '{"plan":"pro","referredBy":null}'),
  ('bob@example.com',   'Bob Brown',       ARRAY['beta'],       '{"plan":"free"}'),
  ('carol@example.com', NULL,              ARRAY[]::text[],     NULL);

INSERT INTO orders (user_id, total_cents, status) VALUES
  (1, 4999.00, 'shipped'),
  (1, 1299.50, 'pending'),
  (2,  799.00, 'cancelled');

INSERT INTO order_items (order_id, sku, qty, unit_price) VALUES
  (1, 'WIDGET-001', 2, 2499.50),
  (1, 'GADGET-007', 1, 0.00),
  (2, 'WIDGET-002', 1, 1299.50),
  (3, 'GADGET-003', 1,  799.00);

INSERT INTO cart_items (cart_id, product_sku, qty) VALUES
  (10, 'WIDGET-001', 3),
  (10, 'GADGET-007', 1),
  (11, 'WIDGET-002', 5);
