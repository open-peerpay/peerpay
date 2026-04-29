import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DEFAULT_MAX_OFFSET_CENTS } from "../src/shared/constants";

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
  rejectLegacySchema(db);
  migrate(db);
  return db;
}

function rejectLegacySchema(db: Database) {
  const legacy = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'accounts'").get();
  const current = db.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'payment_accounts'").get();
  if (legacy && !current) {
    throw new Error("检测到旧版 accounts 数据库结构。本次重构不迁移旧开发数据，请先删除 data/peerpay.sqlite* 后重新启动。");
  }
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS payment_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      payment_channel TEXT NOT NULL CHECK (payment_channel IN ('wechat', 'alipay')),
      priority INTEGER NOT NULL DEFAULT 100,
      enabled INTEGER NOT NULL DEFAULT 1,
      max_offset_cents INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_OFFSET_CENTS},
      fallback_pay_url TEXT,
      notification_keywords TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE INDEX IF NOT EXISTS idx_payment_accounts_channel_priority
      ON payment_accounts(payment_channel, enabled, priority, id);

    CREATE TABLE IF NOT EXISTS preset_qr_codes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_account_id INTEGER NOT NULL REFERENCES payment_accounts(id),
      amount_cents INTEGER NOT NULL,
      pay_url TEXT NOT NULL,
      checked INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (payment_account_id, amount_cents)
    );

    CREATE INDEX IF NOT EXISTS idx_preset_qr_codes_payment_account
      ON preset_qr_codes(payment_account_id, amount_cents);

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      merchant_order_id TEXT,
      payment_account_id INTEGER NOT NULL REFERENCES payment_accounts(id),
      payment_channel TEXT NOT NULL CHECK (payment_channel IN ('wechat', 'alipay')),
      requested_amount_cents INTEGER NOT NULL,
      actual_amount_cents INTEGER NOT NULL,
      pay_url TEXT NOT NULL DEFAULT '',
      pay_mode TEXT NOT NULL DEFAULT 'fallback' CHECK (pay_mode IN ('preset', 'fallback')),
      amount_input_required INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'notified', 'expired')),
      subject TEXT,
      callback_url TEXT,
      callback_secret TEXT,
      redirect_url TEXT,
      expire_at TEXT NOT NULL,
      paid_at TEXT,
      notified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_orders_status_account_amount
      ON orders(payment_account_id, actual_amount_cents, status, expire_at);

    CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pending_account_amount
      ON orders(payment_account_id, actual_amount_cents)
      WHERE status = 'pending';

    CREATE INDEX IF NOT EXISTS idx_orders_channel_status_amount
      ON orders(payment_channel, actual_amount_cents, status, expire_at);

    CREATE INDEX IF NOT EXISTS idx_orders_created_at
      ON orders(created_at DESC);

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id TEXT NOT NULL UNIQUE,
      name TEXT,
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

    CREATE TABLE IF NOT EXISTS device_payment_accounts (
      device_id TEXT NOT NULL REFERENCES devices(device_id) ON DELETE CASCADE,
      payment_account_id INTEGER NOT NULL REFERENCES payment_accounts(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL,
      PRIMARY KEY (device_id, payment_account_id)
    );

    CREATE INDEX IF NOT EXISTS idx_device_payment_accounts_account
      ON device_payment_accounts(payment_account_id);

    CREATE TABLE IF NOT EXISTS device_enrollments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_account_id INTEGER NOT NULL REFERENCES payment_accounts(id),
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
      payment_account_id INTEGER REFERENCES payment_accounts(id),
      device_id TEXT,
      channel TEXT,
      payment_channel TEXT,
      package_name TEXT,
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
  ensureColumn(db, "payment_accounts", "notification_keywords", "ALTER TABLE payment_accounts ADD COLUMN notification_keywords TEXT NOT NULL DEFAULT '[]'");
  ensureColumn(db, "preset_qr_codes", "checked", "ALTER TABLE preset_qr_codes ADD COLUMN checked INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "orders", "redirect_url", "ALTER TABLE orders ADD COLUMN redirect_url TEXT");
}

function ensureColumn(db: Database, table: string, column: string, sql: string) {
  const columns = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(sql);
  }
}
