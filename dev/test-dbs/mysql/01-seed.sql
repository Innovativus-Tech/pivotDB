-- Seed data for the local MySQL test fixture.
-- Loaded automatically by the official mysql image on first boot.
--
-- Mirrors the Postgres fixture so we can exercise PG↔MySQL migrations later.
-- Notable MySQL-isms exercised:
--   * tinyint(1) treated as boolean
--   * ENUM column
--   * JSON column (MySQL 5.7+)
--   * AUTO_INCREMENT
--   * Composite PK

USE testdb;

CREATE TABLE users (
  id          INT AUTO_INCREMENT PRIMARY KEY,
  email       VARCHAR(255) NOT NULL UNIQUE,
  full_name   VARCHAR(255),
  is_active   TINYINT(1) NOT NULL DEFAULT 1,
  metadata    JSON,
  created_at  TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE orders (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  user_id      INT NOT NULL,
  total_cents  DECIMAL(12,2) NOT NULL,
  status       ENUM('pending','shipped','cancelled') NOT NULL DEFAULT 'pending',
  placed_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE order_items (
  id           INT AUTO_INCREMENT PRIMARY KEY,
  order_id     INT NOT NULL,
  sku          VARCHAR(64) NOT NULL,
  qty          INT NOT NULL,
  unit_price   DECIMAL(10,2) NOT NULL,
  FOREIGN KEY (order_id) REFERENCES orders(id) ON DELETE CASCADE
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE cart_items (
  cart_id      INT NOT NULL,
  product_sku  VARCHAR(64) NOT NULL,
  qty          INT NOT NULL DEFAULT 1,
  PRIMARY KEY (cart_id, product_sku)
) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO users (email, full_name, is_active, metadata) VALUES
  ('alice@example.com', 'Alice Andersson', 1, '{"plan":"pro","referredBy":null}'),
  ('bob@example.com',   'Bob Brown',       1, '{"plan":"free"}'),
  ('carol@example.com', NULL,              0, NULL);

INSERT INTO orders (user_id, total_cents, status) VALUES
  (1, 4999.00, 'shipped'),
  (1, 1299.50, 'pending'),
  (2,  799.00, 'cancelled');

INSERT INTO order_items (order_id, sku, qty, unit_price) VALUES
  (1, 'WIDGET-001', 2, 2499.50),
  (1, 'GADGET-007', 1,    0.00),
  (2, 'WIDGET-002', 1, 1299.50),
  (3, 'GADGET-003', 1,  799.00);

INSERT INTO cart_items (cart_id, product_sku, qty) VALUES
  (10, 'WIDGET-001', 3),
  (10, 'GADGET-007', 1),
  (11, 'WIDGET-002', 5);
