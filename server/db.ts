import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function createDatabase(databaseUrl = Bun.env.DATABASE_URL ?? "./data/peerpay.sqlite") {
  if (databaseUrl !== ":memory:") {
    mkdirSync(dirname(databaseUrl), { recursive: true });
  }

  const db = new Database(databaseUrl);
  db.exec("PRAGMA foreign_keys = ON;");
  if (databaseUrl !== ":memory:") {
    db.exec("PRAGMA journal_mode = WAL;");
  }
  db.exec("PRAGMA busy_timeout = 5000;");
  migrate(db);
  seed(db);
  return db;
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_offset_cents INTEGER NOT NULL DEFAULT 99,
      fallback_pay_url TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS preset_qr_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      amount_cents INTEGER NOT NULL,
      pay_url TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (account_id, amount_cents)
    );

    CREATE INDEX IF NOT EXISTS idx_preset_qr_codes_account
      ON preset_qr_codes(account_id, amount_cents);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      merchant_order_id TEXT,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      requested_amount_cents INTEGER NOT NULL,
      actual_amount_cents INTEGER NOT NULL,
      pay_url TEXT NOT NULL DEFAULT '',
      pay_mode TEXT NOT NULL DEFAULT 'fallback' CHECK (pay_mode IN ('preset', 'fallback')),
      amount_input_required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'notified', 'expired')),
      subject TEXT,
      callback_url TEXT,
      callback_secret TEXT,
      expire_at TEXT NOT NULL,
      paid_at TEXT,
      notified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status_amount
      ON orders(account_id, actual_amount_cents, status, expire_at);

    CREATE INDEX IF NOT EXISTS idx_orders_created_at
      ON orders(created_at DESC);

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      name TEXT,
      account_id INTEGER REFERENCES accounts(id),
      device_secret TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      paired_at TEXT,
      last_seen_at TEXT,
      app_version TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_devices_last_seen
      ON devices(last_seen_at DESC);

    CREATE TABLE IF NOT EXISTS device_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      name TEXT,
      token_hash TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_device_enrollments_expires
      ON device_enrollments(expires_at, used_at);

    CREATE TABLE IF NOT EXISTS device_nonces (
      device_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (device_id, nonce)
    );

    CREATE TABLE IF NOT EXISTS payment_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL REFERENCES accounts(id),
      device_id TEXT,
      channel TEXT,
      actual_amount_cents INTEGER,
      raw_text TEXT NOT NULL,
      matched_order_id TEXT REFERENCES orders(id),
      status TEXT NOT NULL CHECK (status IN ('matched', 'unmatched', 'parse_failed')),
      received_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notifications_received
      ON payment_notifications(received_at DESC);

    CREATE TABLE IF NOT EXISTS callback_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      order_id TEXT NOT NULL REFERENCES orders(id),
      url TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'success', 'failed')),
      http_status INTEGER,
      request_body TEXT NOT NULL,
      response_body TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_callbacks_due
      ON callback_logs(status, next_retry_at);

    CREATE TABLE IF NOT EXISTS system_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      level TEXT NOT NULL CHECK (level IN ('info', 'warn', 'error')),
      action TEXT NOT NULL,
      message TEXT NOT NULL,
      context TEXT,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_system_logs_created
      ON system_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  ensureColumn(db, "accounts", "max_offset_cents", "INTEGER NOT NULL DEFAULT 99");
  ensureColumn(db, "accounts", "fallback_pay_url", "TEXT");
  ensureColumn(db, "orders", "pay_url", "TEXT NOT NULL DEFAULT ''");
  ensureColumn(db, "orders", "pay_mode", "TEXT NOT NULL DEFAULT 'fallback'");
  ensureColumn(db, "orders", "amount_input_required", "INTEGER NOT NULL DEFAULT 1");
  ensureColumn(db, "devices", "device_secret", "TEXT");
  ensureColumn(db, "devices", "paired_at", "TEXT");
}

function seed(db: Database) {
  db.query("INSERT OR IGNORE INTO accounts(code, name) VALUES (?, ?)")
    .run("default", "默认账户");
}

function ensureColumn(db: Database, table: string, column: string, definition: string) {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((item) => item.name === column)) {
    return;
  }
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
}
