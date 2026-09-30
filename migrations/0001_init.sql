-- Brytely Threads — initial schema (Cloudflare D1 / SQLite)
-- Categories are NOT hardcoded anywhere: every niche (golf, coffee, whatever
-- comes next) is just a row in `tags`, linked to products via `product_tags`.

PRAGMA foreign_keys = ON;

-- ───────────────────────── Catalog (mirrored from Printify) ─────────────────
CREATE TABLE products (
  id              TEXT PRIMARY KEY,            -- Printify product id
  handle          TEXT NOT NULL UNIQUE,        -- URL slug
  title           TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',    -- sanitized HTML
  images_json     TEXT NOT NULL DEFAULT '[]',  -- [{src, variantIds, position, isDefault}]
  options_json    TEXT NOT NULL DEFAULT '[]',  -- [{name, type, values:[{id,title,colors}]}]
  min_price       INTEGER NOT NULL DEFAULT 0,  -- cents, over enabled variants
  max_price       INTEGER NOT NULL DEFAULT 0,
  printify_visible INTEGER NOT NULL DEFAULT 1, -- Printify's own `visible` flag
  published       INTEGER NOT NULL DEFAULT 0,  -- went through Printify "Publish"
  hidden          INTEGER NOT NULL DEFAULT 0,  -- local admin override
  featured        INTEGER NOT NULL DEFAULT 0,  -- local admin flag (home page)
  sort_order      INTEGER NOT NULL DEFAULT 0,
  deleted         INTEGER NOT NULL DEFAULT 0,  -- gone from Printify; kept for order history
  printify_created_at TEXT,
  printify_updated_at TEXT,
  synced_at       TEXT NOT NULL
);

CREATE TABLE variants (
  id          INTEGER NOT NULL,              -- Printify variant id (unique per product)
  product_id  TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,                 -- e.g. "Black / L"
  sku         TEXT,
  price       INTEGER NOT NULL,              -- retail price in cents (set in Printify)
  option_ids_json TEXT NOT NULL DEFAULT '[]',-- option value ids, aligned with products.options_json
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  is_available INTEGER NOT NULL DEFAULT 1,
  is_default  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (product_id, id)
);

CREATE TABLE tags (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  slug       TEXT NOT NULL UNIQUE,
  name       TEXT NOT NULL,
  show_in_nav INTEGER NOT NULL DEFAULT 1,     -- toggle in /admin, no deploy needed
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE product_tags (
  product_id TEXT NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  tag_id     INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  PRIMARY KEY (product_id, tag_id)
);
CREATE INDEX idx_product_tags_tag ON product_tags(tag_id);

-- ───────────────────────── Orders ───────────────────────────────────────────
-- status lifecycle:
--   pending_payment → paid → submitting → submitted → in_production → shipped → delivered
--   failure branch:  submitting → submit_failed → (retried by webhook retry / cron / admin)
--   other:           expired (checkout abandoned), canceled, refunded
CREATE TABLE orders (
  id                 TEXT PRIMARY KEY,        -- internal uuid
  number             TEXT NOT NULL UNIQUE,    -- customer-facing, e.g. BT-7K2Q9M
  status             TEXT NOT NULL,
  email              TEXT,
  customer_name      TEXT,
  phone              TEXT,
  shipping_json      TEXT,                    -- normalized address
  subtotal           INTEGER NOT NULL,        -- cents
  shipping_amount    INTEGER NOT NULL DEFAULT 0,
  tax_amount         INTEGER NOT NULL DEFAULT 0,
  total              INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'usd',
  stripe_session_id  TEXT UNIQUE,
  stripe_payment_intent TEXT,
  printify_order_id  TEXT UNIQUE,
  printify_status    TEXT,
  submit_attempts    INTEGER NOT NULL DEFAULT 0,
  submit_started_at  TEXT,
  last_error         TEXT,
  tracking_json      TEXT NOT NULL DEFAULT '[]', -- [{carrier, number, url, shippedAt, deliveredAt}]
  shipped_email_sent_at TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL,
  paid_at            TEXT,
  submitted_at       TEXT
);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created ON orders(created_at);

CREATE TABLE order_items (
  order_id    TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  TEXT NOT NULL,
  variant_id  INTEGER NOT NULL,
  title       TEXT NOT NULL,       -- snapshot at purchase time
  variant_title TEXT NOT NULL,
  image       TEXT,
  unit_price  INTEGER NOT NULL,
  quantity    INTEGER NOT NULL CHECK (quantity > 0),
  PRIMARY KEY (order_id, product_id, variant_id)
);
CREATE INDEX idx_order_items_product ON order_items(product_id);

-- Append-only audit trail for every state change / external call on an order.
CREATE TABLE order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   TEXT NOT NULL,
  kind       TEXT NOT NULL,        -- e.g. stripe.completed, printify.submit.ok, printify.submit.error
  detail     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_order_events_order ON order_events(order_id);

-- Webhook de-duplication (Stripe and Printify both retry deliveries).
CREATE TABLE webhook_events (
  source      TEXT NOT NULL,       -- 'stripe' | 'printify'
  event_id    TEXT NOT NULL,
  type        TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  PRIMARY KEY (source, event_id)
);

-- ───────────────────────── Ops ──────────────────────────────────────────────
CREATE TABLE sync_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  trigger     TEXT NOT NULL,       -- 'cron' | 'admin' | 'webhook'
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  ok          INTEGER,
  products_seen INTEGER DEFAULT 0,
  products_upserted INTEGER DEFAULT 0,
  products_removed INTEGER DEFAULT 0,
  images_mirrored INTEGER DEFAULT 0,
  error       TEXT
);

CREATE TABLE kv_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
