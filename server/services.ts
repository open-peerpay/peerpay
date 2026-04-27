import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createDatabase } from "./db";
import { extractMoneyFromText, formatMoney, parseMoney } from "./money";
import { DEFAULT_MAX_OFFSET_CENTS } from "../src/shared/constants";
import type {
  Account,
  AndroidNotificationInput,
  AmountOccupation,
  BulkPresetQrCodeInput,
  CallbackLog,
  CallbackStatus,
  CreateDeviceEnrollmentInput,
  CreateOrderInput,
  DashboardStats,
  Device,
  DeviceEnrollment,
  EnrollDeviceInput,
  EnrollDeviceResult,
  HeartbeatInput,
  LogLevel,
  MatchStatus,
  NotificationLog,
  Order,
  OrderStatus,
  Page,
  PayMode,
  PresetQrCode,
  SystemLog
} from "../src/shared/types";

const DEFAULT_ORDER_TTL_MINUTES = 15;
const DEVICE_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const MAX_CALLBACK_ATTEMPTS = 5;

type RowBool = 0 | 1;

interface AccountRow {
  id: number;
  code: string;
  name: string;
  enabled: RowBool;
  max_offset_cents: number;
  fallback_pay_url: string | null;
  created_at: string;
}

interface PresetQrCodeRow {
  id: number;
  account_id: number;
  account_code: string;
  amount_cents: number;
  pay_url: string;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  merchant_order_id: string | null;
  account_id: number;
  account_code: string;
  requested_amount_cents: number;
  actual_amount_cents: number;
  pay_url: string;
  pay_mode: PayMode;
  amount_input_required: RowBool;
  status: OrderStatus;
  subject: string | null;
  callback_url: string | null;
  expire_at: string;
  paid_at: string | null;
  notified_at: string | null;
  created_at: string;
  updated_at: string;
}

interface DeviceRow {
  id: number;
  device_id: string;
  name: string | null;
  account_id: number | null;
  account_code: string | null;
  device_secret: string | null;
  enabled: RowBool;
  paired_at: string | null;
  last_seen_at: string | null;
  app_version: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

interface DeviceEnrollmentRow {
  id: number;
  account_id: number;
  account_code: string;
  name: string | null;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

interface NotificationRow {
  id: number;
  account_id: number;
  account_code: string;
  device_id: string | null;
  channel: string | null;
  actual_amount_cents: number | null;
  raw_text: string;
  matched_order_id: string | null;
  status: MatchStatus;
  received_at: string;
}

interface CallbackRow {
  id: number;
  order_id: string;
  url: string;
  status: CallbackStatus;
  http_status: number | null;
  attempts: number;
  next_retry_at: string | null;
  error: string | null;
  response_body: string | null;
  created_at: string;
  updated_at: string;
}

interface SystemLogRow {
  id: number;
  level: LogLevel;
  action: string;
  message: string;
  context: string | null;
  created_at: string;
}

export interface AppContext {
  db: Database;
  runCallbacks: boolean;
  callbackMaxAttempts: number;
}

export function createAppContext(options: {
  databaseUrl?: string;
  runCallbacks?: boolean;
  callbackMaxAttempts?: number;
} = {}): AppContext {
  return {
    db: createDatabase(options.databaseUrl),
    runCallbacks: options.runCallbacks ?? Bun.env.NODE_ENV !== "test",
    callbackMaxAttempts: options.callbackMaxAttempts ?? MAX_CALLBACK_ATTEMPTS
  };
}

export function closeAppContext(ctx: AppContext) {
  ctx.db.close();
}

export function nowIso() {
  return new Date().toISOString();
}

function addMinutes(minutes: number) {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

function addSeconds(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function createOrderId() {
  return `ord_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

function createSecret(bytes = 32) {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function scalar(ctx: AppContext, sql: string, ...params: SQLQueryBindings[]) {
  const row = ctx.db.query(sql).get(...params) as { value: number } | null;
  return row?.value ?? 0;
}

function mapAccount(row: AccountRow): Account {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    enabled: row.enabled === 1,
    maxOffsetCents: row.max_offset_cents,
    maxOffset: formatMoney(row.max_offset_cents) ?? "0.00",
    fallbackPayUrl: row.fallback_pay_url,
    createdAt: row.created_at
  };
}

function mapPresetQrCode(row: PresetQrCodeRow): PresetQrCode {
  return {
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    amount: formatMoney(row.amount_cents) ?? "0.00",
    amountCents: row.amount_cents,
    payUrl: row.pay_url,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapOrder(row: OrderRow): Order {
  return {
    id: row.id,
    merchantOrderId: row.merchant_order_id,
    accountId: row.account_id,
    accountCode: row.account_code,
    requestedAmount: formatMoney(row.requested_amount_cents) ?? "0.00",
    requestedAmountCents: row.requested_amount_cents,
    actualAmount: formatMoney(row.actual_amount_cents) ?? "0.00",
    actualAmountCents: row.actual_amount_cents,
    payUrl: row.pay_url,
    payMode: row.pay_mode,
    amountInputRequired: row.amount_input_required === 1,
    status: row.status,
    subject: row.subject,
    callbackUrl: row.callback_url,
    expireAt: row.expire_at,
    paidAt: row.paid_at,
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDevice(row: DeviceRow): Device {
  const threshold = Date.now() - DEVICE_ONLINE_WINDOW_MS;
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;

  return {
    id: row.id,
    deviceId: row.device_id,
    name: row.name,
    accountId: row.account_id,
    accountCode: row.account_code,
    enabled: row.enabled === 1,
    online: row.enabled === 1 && lastSeen >= threshold,
    pairedAt: row.paired_at,
    lastSeenAt: row.last_seen_at,
    appVersion: row.app_version,
    metadata: parseJson(row.metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDeviceEnrollment(row: DeviceEnrollmentRow, token: string): DeviceEnrollment {
  return {
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    name: row.name,
    token,
    pairingUrl: "",
    expiresAt: row.expires_at,
    createdAt: row.created_at
  };
}

function mapNotification(row: NotificationRow): NotificationLog {
  return {
    id: row.id,
    accountId: row.account_id,
    accountCode: row.account_code,
    deviceId: row.device_id,
    channel: row.channel,
    actualAmount: formatMoney(row.actual_amount_cents),
    actualAmountCents: row.actual_amount_cents,
    rawText: row.raw_text,
    matchedOrderId: row.matched_order_id,
    status: row.status,
    receivedAt: row.received_at
  };
}

function mapCallback(row: CallbackRow): CallbackLog {
  return {
    id: row.id,
    orderId: row.order_id,
    url: row.url,
    status: row.status,
    httpStatus: row.http_status,
    attempts: row.attempts,
    nextRetryAt: row.next_retry_at,
    error: row.error,
    responseBody: row.response_body,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapSystemLog(row: SystemLogRow): SystemLog {
  return {
    id: row.id,
    level: row.level,
    action: row.action,
    message: row.message,
    context: parseJson(row.context),
    createdAt: row.created_at
  };
}

function parseJson(value: string | null): unknown {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function logSystem(
  ctx: AppContext,
  level: LogLevel,
  action: string,
  message: string,
  context: unknown = null
) {
  ctx.db.query(
    "INSERT INTO system_logs(level, action, message, context, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(level, action, message, context == null ? null : JSON.stringify(context), nowIso());
}

function accountById(ctx: AppContext, id: number) {
  const row = ctx.db.query("SELECT * FROM accounts WHERE id = ?").get(id) as AccountRow | null;
  return row ? mapAccount(row) : null;
}

function accountByCode(ctx: AppContext, code: string) {
  const row = ctx.db.query("SELECT * FROM accounts WHERE code = ?").get(code) as AccountRow | null;
  return row ? mapAccount(row) : null;
}

function defaultAccount(ctx: AppContext) {
  const row = ctx.db.query("SELECT * FROM accounts WHERE code = ?").get("default") as AccountRow | null;
  if (!row) {
    throw apiError(500, "默认账户不存在");
  }
  return mapAccount(row);
}

function resolveAccount(
  ctx: AppContext,
  input: { accountId?: number; accountCode?: string; deviceId?: string },
  requireEnabled = false
) {
  let account: Account | null = null;

  if (input.accountId != null) {
    account = accountById(ctx, input.accountId);
  } else if (input.accountCode) {
    account = accountByCode(ctx, input.accountCode);
  } else if (input.deviceId) {
    const row = ctx.db.query(`
      SELECT a.*
      FROM devices d
      JOIN accounts a ON a.id = d.account_id
      WHERE d.device_id = ?
    `).get(input.deviceId) as AccountRow | null;
    account = row ? mapAccount(row) : null;
  }

  account ??= defaultAccount(ctx);

  if (!account) {
    throw apiError(404, "账户不存在");
  }

  if (requireEnabled && !account.enabled) {
    throw apiError(409, "账户已禁用");
  }

  return account;
}

export function apiError(status: number, message: string, details?: unknown) {
  return Object.assign(new Error(message), { status, details });
}

function normalizeMaxOffset(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 9999) {
    throw apiError(400, "最大偏移必须是 0 到 9999 之间的整数分");
  }
  return value;
}

function normalizePayUrl(value: string | null | undefined, optional = false) {
  const text = value?.trim() ?? "";
  if (!text) {
    if (optional) {
      return null;
    }
    throw apiError(400, "付款 URL 不能为空");
  }

  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
    return url.toString();
  } catch {
    throw apiError(400, "付款 URL 必须是有效的 http/https 地址");
  }
}

export function releaseExpiredLocks(ctx: AppContext) {
  const now = nowIso();
  const expiredOrders = ctx.db.query(`
    SELECT o.*, a.code AS account_code
    FROM orders o
    JOIN accounts a ON a.id = o.account_id
    WHERE o.status = 'pending' AND o.expire_at <= ?
  `).all(now) as OrderRow[];

  if (expiredOrders.length === 0) {
    return 0;
  }

  const transaction = ctx.db.transaction(() => {
    for (const order of expiredOrders) {
      ctx.db.query("UPDATE orders SET status = 'expired', updated_at = ? WHERE id = ?")
        .run(now, order.id);
    }
  });

  transaction();
  logSystem(ctx, "info", "orders.expired", "过期订单已自动释放", {
    count: expiredOrders.length,
    orderIds: expiredOrders.map((order) => order.id)
  });
  return expiredOrders.length;
}

export function listAccounts(ctx: AppContext) {
  const rows = ctx.db.query("SELECT * FROM accounts ORDER BY id ASC").all() as AccountRow[];
  return rows.map(mapAccount);
}

export function createAccount(
  ctx: AppContext,
  input: { code: string; name: string; maxOffsetCents?: number; fallbackPayUrl?: string | null }
) {
  const code = input.code.trim();
  const name = input.name.trim();
  const maxOffsetCents = normalizeMaxOffset(input.maxOffsetCents ?? DEFAULT_MAX_OFFSET_CENTS);
  const fallbackPayUrl = normalizePayUrl(input.fallbackPayUrl ?? null, true);
  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(code)) {
    throw apiError(400, "账户编码仅支持 2-32 位字母、数字、下划线或短横线");
  }
  if (!name) {
    throw apiError(400, "账户名称不能为空");
  }

  try {
    ctx.db.query("INSERT INTO accounts(code, name, max_offset_cents, fallback_pay_url) VALUES (?, ?, ?, ?)")
      .run(code, name, maxOffsetCents, fallbackPayUrl);
  } catch {
    throw apiError(409, "账户编码已存在");
  }

  const account = accountByCode(ctx, code);
  if (!account) {
    throw apiError(500, "账户创建失败");
  }
  logSystem(ctx, "info", "accounts.created", "账户已创建", { accountId: account.id, code });
  return account;
}

export function setAccountEnabled(ctx: AppContext, id: number, enabled: boolean) {
  const account = accountById(ctx, id);
  if (!account) {
    throw apiError(404, "账户不存在");
  }

  ctx.db.query("UPDATE accounts SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  logSystem(ctx, "info", "accounts.enabled", "账户状态已更新", { accountId: id, enabled });
  return accountById(ctx, id);
}

export function updateAccountSettings(
  ctx: AppContext,
  id: number,
  input: { maxOffsetCents?: number; fallbackPayUrl?: string | null }
) {
  const account = accountById(ctx, id);
  if (!account) {
    throw apiError(404, "账户不存在");
  }

  const maxOffsetCents = normalizeMaxOffset(input.maxOffsetCents ?? account.maxOffsetCents);
  const fallbackPayUrl = normalizePayUrl(
    input.fallbackPayUrl === undefined ? account.fallbackPayUrl : input.fallbackPayUrl,
    true
  );

  ctx.db.query("UPDATE accounts SET max_offset_cents = ?, fallback_pay_url = ? WHERE id = ?")
    .run(maxOffsetCents, fallbackPayUrl, id);
  logSystem(ctx, "info", "accounts.settings_updated", "账户收款设置已更新", {
    accountId: id,
    maxOffsetCents,
    hasFallbackPayUrl: Boolean(fallbackPayUrl)
  });
  return accountById(ctx, id);
}

export function upsertPresetQrCodes(ctx: AppContext, input: BulkPresetQrCodeInput) {
  const account = resolveAccount(ctx, input, true);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw apiError(400, "请提供至少一个二维码配置");
  }
  if (input.items.length > 5000) {
    throw apiError(400, "单次导入二维码不能超过 5000 条");
  }

  const now = nowIso();
  const upsert = ctx.db.query(`
    INSERT INTO preset_qr_codes(account_id, amount_cents, pay_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(account_id, amount_cents) DO UPDATE SET
      pay_url = excluded.pay_url,
      updated_at = excluded.updated_at
  `);

  let saved = 0;
  const transaction = ctx.db.transaction(() => {
    for (const item of input.items) {
      const amountCents = parseMoney(item.amount);
      const payUrl = normalizePayUrl(item.payUrl);
      upsert.run(account.id, amountCents, payUrl, now, now);
      saved += 1;
    }
  });
  transaction();

  logSystem(ctx, "info", "preset_qr_codes.upserted", "定额二维码已保存", {
    accountId: account.id,
    saved
  });
  return { account, saved };
}

export function listPresetQrCodes(
  ctx: AppContext,
  options: { accountId?: number; accountCode?: string; limit?: number; offset?: number } = {}
): Page<PresetQrCode> {
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (options.accountId != null) {
    filters.push("q.account_id = ?");
    params.push(options.accountId);
  }
  if (options.accountCode) {
    filters.push("a.code = ?");
    params.push(options.accountCode);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = ctx.db.query(`
    SELECT q.*, a.code AS account_code
    FROM preset_qr_codes q
    JOIN accounts a ON a.id = q.account_id
    ${where}
    ORDER BY q.account_id ASC, q.amount_cents ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as PresetQrCodeRow[];
  const total = scalar(ctx, `
    SELECT COUNT(*) AS value
    FROM preset_qr_codes q
    JOIN accounts a ON a.id = q.account_id
    ${where}
  `, ...params);

  return { items: rows.map(mapPresetQrCode), total, limit, offset };
}

export function deletePresetQrCode(ctx: AppContext, id: number) {
  const row = ctx.db.query(`
    SELECT q.*, a.code AS account_code
    FROM preset_qr_codes q
    JOIN accounts a ON a.id = q.account_id
    WHERE q.id = ?
  `).get(id) as PresetQrCodeRow | null;

  if (!row) {
    throw apiError(404, "定额二维码不存在");
  }

  ctx.db.query("DELETE FROM preset_qr_codes WHERE id = ?").run(id);
  logSystem(ctx, "warn", "preset_qr_codes.deleted", "定额二维码已删除", {
    qrCodeId: id,
    accountId: row.account_id,
    amount: formatMoney(row.amount_cents)
  });

  return mapPresetQrCode(row);
}

function allocateActualAmount(
  ctx: AppContext,
  accountId: number,
  requestedAmount: number,
  maxOffsetCents: number,
  now: string
) {
  const effectiveMaxOffsetCents = requestedAmount % 100 === 0 ? maxOffsetCents : 0;
  const rows = ctx.db.query(`
    SELECT actual_amount_cents AS amount
    FROM orders
    WHERE account_id = ?
      AND status = 'pending'
      AND expire_at > ?
      AND actual_amount_cents BETWEEN ? AND ?
  `).all(accountId, now, requestedAmount, requestedAmount + effectiveMaxOffsetCents) as Array<{ amount: number }>;
  const occupied = new Set(rows.map((row) => row.amount));

  for (let offset = 0; offset <= effectiveMaxOffsetCents; offset += 1) {
    const candidate = requestedAmount + offset;
    if (!occupied.has(candidate)) {
      return candidate;
    }
  }

  throw apiError(409, `订单金额 ${formatMoney(requestedAmount)} 在最大偏移 ${formatMoney(effectiveMaxOffsetCents)} 内已被占满`);
}

function findPresetQrCode(ctx: AppContext, accountId: number, amountCents: number) {
  const row = ctx.db.query(`
    SELECT q.*, a.code AS account_code
    FROM preset_qr_codes q
    JOIN accounts a ON a.id = q.account_id
    WHERE q.account_id = ? AND q.amount_cents = ?
  `).get(accountId, amountCents) as PresetQrCodeRow | null;

  return row ? mapPresetQrCode(row) : null;
}

export function createOrder(ctx: AppContext, input: CreateOrderInput) {
  releaseExpiredLocks(ctx);
  const account = resolveAccount(ctx, input, true);
  const requestedAmount = parseMoney(input.amount);
  const ttlMinutes = Math.min(Math.max(input.ttlMinutes ?? DEFAULT_ORDER_TTL_MINUTES, 1), 1440);
  const now = nowIso();
  const expireAt = addMinutes(ttlMinutes);
  const id = createOrderId();

  const createTransaction = ctx.db.transaction(() => {
    const actualAmount = allocateActualAmount(ctx, account.id, requestedAmount, account.maxOffsetCents, now);
    const preset = findPresetQrCode(ctx, account.id, actualAmount);
    const payUrl = preset?.payUrl ?? account.fallbackPayUrl;
    const payMode: PayMode = preset ? "preset" : "fallback";

    if (!payUrl) {
      throw apiError(409, "该金额没有定额二维码，账户也没有兜底通用收款码");
    }

    ctx.db.query(`
      INSERT INTO orders(
        id, merchant_order_id, account_id, requested_amount_cents, actual_amount_cents, pay_url, pay_mode, amount_input_required,
        status, subject, callback_url, callback_secret, expire_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.merchantOrderId?.trim() || null,
      account.id,
      requestedAmount,
      actualAmount,
      payUrl,
      payMode,
      payMode === "fallback" ? 1 : 0,
      input.subject?.trim() || null,
      input.callbackUrl?.trim() || null,
      input.callbackSecret?.trim() || null,
      expireAt,
      now,
      now
    );
  });

  createTransaction();
  const order = getOrder(ctx, id);
  if (!order) {
    throw apiError(500, "订单创建后读取失败");
  }
  logSystem(ctx, "info", "orders.created", "订单已创建并分配金额", {
    orderId: id,
    accountId: account.id,
    requestedAmount: formatMoney(requestedAmount),
    actualAmount: order.actualAmount,
    payMode: order.payMode
  });
  return order;
}

export function getOrder(ctx: AppContext, id: string) {
  const row = ctx.db.query(`
    SELECT o.*, a.code AS account_code
    FROM orders o
    JOIN accounts a ON a.id = o.account_id
    WHERE o.id = ?
  `).get(id) as OrderRow | null;

  return row ? mapOrder(row) : null;
}

export function listOrders(
  ctx: AppContext,
  options: { status?: string; accountId?: number; accountCode?: string; limit?: number; offset?: number } = {}
): Page<Order> {
  releaseExpiredLocks(ctx);
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];

  const status = options.status;
  if (status && ["pending", "paid", "notified", "expired"].includes(status)) {
    filters.push("o.status = ?");
    params.push(status);
  }
  if (options.accountId != null) {
    filters.push("o.account_id = ?");
    params.push(options.accountId);
  }
  if (options.accountCode) {
    filters.push("a.code = ?");
    params.push(options.accountCode);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = ctx.db.query(`
    SELECT o.*, a.code AS account_code
    FROM orders o
    JOIN accounts a ON a.id = o.account_id
    ${where}
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as OrderRow[];
  const total = scalar(ctx, `
    SELECT COUNT(*) AS value
    FROM orders o
    JOIN accounts a ON a.id = o.account_id
    ${where}
  `, ...params);

  return { items: rows.map(mapOrder), total, limit, offset };
}

export function updateOrderStatus(ctx: AppContext, id: string, status: OrderStatus) {
  const order = getOrder(ctx, id);
  if (!order) {
    throw apiError(404, "订单不存在");
  }

  const now = nowIso();
  const transaction = ctx.db.transaction(() => {
    ctx.db.query(`
      UPDATE orders
      SET status = ?, paid_at = COALESCE(paid_at, ?), notified_at = CASE WHEN ? = 'notified' THEN ? ELSE notified_at END,
          updated_at = ?
      WHERE id = ?
    `).run(status, status === "paid" || status === "notified" ? now : null, status, now, now, id);

  });
  transaction();

  const updated = getOrder(ctx, id);
  if (!updated) {
    throw apiError(500, "订单状态更新失败");
  }
  logSystem(ctx, "warn", "orders.status_updated", "订单状态已手动更新", { orderId: id, status });
  if (status === "paid") {
    queueCallback(ctx, updated);
  }
  return updated;
}

export function createDeviceEnrollment(ctx: AppContext, input: CreateDeviceEnrollmentInput): DeviceEnrollment {
  const account = resolveAccount(ctx, input, true);
  const ttlMinutes = Math.min(Math.max(input.ttlMinutes ?? 30, 1), 1440);
  const now = nowIso();
  const token = createSecret(18);
  const expiresAt = addMinutes(ttlMinutes);

  ctx.db.query(`
    INSERT INTO device_enrollments(account_id, name, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(account.id, input.name?.trim() || null, sha256(token), expiresAt, now);

  const id = (ctx.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  const row = ctx.db.query(`
    SELECT e.*, a.code AS account_code
    FROM device_enrollments e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.id = ?
  `).get(id) as DeviceEnrollmentRow | null;

  if (!row) {
    throw apiError(500, "设备配对码创建失败");
  }

  logSystem(ctx, "info", "devices.enrollment_created", "设备配对码已创建", {
    enrollmentId: id,
    accountId: account.id,
    expiresAt
  });
  return mapDeviceEnrollment(row, token);
}

export function enrollAndroidDevice(ctx: AppContext, input: EnrollDeviceInput): EnrollDeviceResult {
  const token = input.enrollmentToken?.trim();
  const deviceId = input.deviceId?.trim();
  if (!token || !deviceId) {
    throw apiError(400, "配对码和设备 ID 不能为空");
  }

  const now = nowIso();
  const row = ctx.db.query(`
    SELECT e.*, a.code AS account_code
    FROM device_enrollments e
    JOIN accounts a ON a.id = e.account_id
    WHERE e.token_hash = ? AND e.used_at IS NULL AND e.expires_at > ?
  `).get(sha256(token), now) as DeviceEnrollmentRow | null;

  if (!row) {
    throw apiError(401, "设备配对码无效或已过期");
  }

  const deviceSecret = createSecret();
  const metadata = input.metadata == null ? null : JSON.stringify(input.metadata);
  const name = input.name?.trim() || row.name;
  const transaction = ctx.db.transaction(() => {
    const consumed = ctx.db.query("UPDATE device_enrollments SET used_at = ? WHERE id = ? AND used_at IS NULL").run(now, row.id);
    if (consumed.changes !== 1) {
      throw apiError(401, "设备配对码已被使用");
    }

    ctx.db.query(`
      INSERT INTO devices(device_id, name, account_id, device_secret, enabled, paired_at, last_seen_at, app_version, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        name = COALESCE(excluded.name, devices.name),
        account_id = excluded.account_id,
        device_secret = excluded.device_secret,
        enabled = 1,
        paired_at = excluded.paired_at,
        last_seen_at = excluded.last_seen_at,
        app_version = COALESCE(excluded.app_version, devices.app_version),
        metadata = COALESCE(excluded.metadata, devices.metadata),
        updated_at = excluded.updated_at
    `).run(
      deviceId,
      name,
      row.account_id,
      deviceSecret,
      now,
      now,
      input.appVersion?.trim() || null,
      metadata,
      now,
      now
    );
  });
  transaction();

  const device = getDeviceByDeviceId(ctx, deviceId);
  if (!device) {
    throw apiError(500, "设备配对失败");
  }

  logSystem(ctx, "info", "devices.enrolled", "安卓设备已加入系统", {
    deviceId,
    accountId: row.account_id
  });
  return { device: mapDevice(device), deviceSecret };
}

export function touchDevice(ctx: AppContext, input: HeartbeatInput, verifiedDevice: Device) {
  const now = nowIso();
  const metadata = input.metadata == null ? null : JSON.stringify(input.metadata);

  ctx.db.query(`
    UPDATE devices
    SET name = COALESCE(?, name),
        last_seen_at = ?,
        app_version = COALESCE(?, app_version),
        metadata = COALESCE(?, metadata),
        updated_at = ?
    WHERE device_id = ?
  `).run(
    input.name?.trim() || null,
    now,
    input.appVersion?.trim() || null,
    metadata,
    now,
    verifiedDevice.deviceId
  );

  const device = getDeviceByDeviceId(ctx, verifiedDevice.deviceId);
  if (!device) {
    throw apiError(500, "设备心跳更新失败");
  }

  return mapDevice(device);
}

function getDeviceByDeviceId(ctx: AppContext, deviceId: string) {
  return ctx.db.query(`
    SELECT d.*, a.code AS account_code
    FROM devices d
    LEFT JOIN accounts a ON a.id = d.account_id
    WHERE d.device_id = ?
  `).get(deviceId) as DeviceRow | null;
}

export function listDevices(ctx: AppContext) {
  const rows = ctx.db.query(`
    SELECT d.*, a.code AS account_code
    FROM devices d
    LEFT JOIN accounts a ON a.id = d.account_id
    ORDER BY d.last_seen_at DESC NULLS LAST, d.id DESC
  `).all() as DeviceRow[];
  return rows.map(mapDevice);
}

export function setDeviceEnabled(ctx: AppContext, id: number, enabled: boolean) {
  const now = nowIso();
  ctx.db.query("UPDATE devices SET enabled = ?, updated_at = ? WHERE id = ?")
    .run(enabled ? 1 : 0, now, id);
  logSystem(ctx, "info", "devices.enabled", "设备状态已更新", { deviceRowId: id, enabled });
  return listDevices(ctx).find((device) => device.id === id) ?? null;
}

export function verifyAndroidRequest(ctx: AppContext, req: Request, bodyText: string) {
  const deviceId = req.headers.get("x-peerpay-device-id")?.trim();
  const timestamp = req.headers.get("x-peerpay-timestamp")?.trim();
  const nonce = req.headers.get("x-peerpay-nonce")?.trim();
  const signature = req.headers.get("x-peerpay-signature")?.trim();
  if (!deviceId || !timestamp || !nonce || !signature) {
    throw apiError(401, "缺少设备签名头");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds) || Math.abs(Date.now() / 1000 - timestampSeconds) > 300) {
    throw apiError(401, "设备签名时间戳无效");
  }

  const row = getDeviceByDeviceId(ctx, deviceId);
  if (!row || row.enabled !== 1 || !row.device_secret || !row.account_id) {
    throw apiError(401, "设备不存在、未配对或已禁用");
  }

  const url = new URL(req.url);
  const expected = signAndroidRequest({
    method: req.method,
    path: url.pathname,
    timestamp,
    nonce,
    bodyText,
    deviceSecret: row.device_secret
  });

  if (!safeEqual(signature, expected)) {
    throw apiError(401, "设备签名无效");
  }

  rememberDeviceNonce(ctx, deviceId, nonce);
  const now = nowIso();
  ctx.db.query("UPDATE devices SET last_seen_at = ?, updated_at = ? WHERE device_id = ?").run(now, now, deviceId);
  return mapDevice({ ...row, last_seen_at: now, updated_at: now });
}

export function signAndroidRequest(input: {
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyText: string;
  deviceSecret: string;
}) {
  const canonical = [
    input.method.toUpperCase(),
    input.path,
    input.timestamp,
    input.nonce,
    sha256(input.bodyText)
  ].join("\n");
  return createHmac("sha256", input.deviceSecret).update(canonical).digest("hex");
}

function rememberDeviceNonce(ctx: AppContext, deviceId: string, nonce: string) {
  const now = nowIso();
  const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  ctx.db.query("DELETE FROM device_nonces WHERE expires_at <= ?").run(now);
  try {
    ctx.db.query("INSERT INTO device_nonces(device_id, nonce, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .run(deviceId, nonce, expiresAt, now);
  } catch {
    throw apiError(401, "设备签名 nonce 已使用");
  }
}

function safeEqual(leftText: string, rightText: string) {
  const left = Buffer.from(leftText);
  const right = Buffer.from(rightText);
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return timingSafeEqual(left, right);
}

export interface NotificationMatchResult {
  matched: boolean;
  order: Order | null;
  log: NotificationLog;
}

export function handleAndroidNotification(
  ctx: AppContext,
  input: AndroidNotificationInput,
  verifiedDevice: Device
): NotificationMatchResult {
  releaseExpiredLocks(ctx);
  const deviceId = verifiedDevice.deviceId;
  if (!verifiedDevice.accountId) {
    throw apiError(401, "设备未绑定账户");
  }
  const account = resolveAccount(ctx, { accountId: verifiedDevice.accountId }, true);
  const rawText = input.rawText?.trim() || input.text?.trim() || "";
  const amountCents = input.actualAmount != null
    ? parseMoney(input.actualAmount)
    : input.amount != null
      ? parseMoney(input.amount)
      : rawText
        ? extractMoneyFromText(rawText)
        : null;

  const now = nowIso();
  if (amountCents == null) {
    const log = insertNotificationLog(ctx, {
      accountId: account.id,
      deviceId,
      channel: input.channel,
      amountCents: null,
      rawText,
      matchedOrderId: null,
      status: "parse_failed",
      receivedAt: now
    });
    logSystem(ctx, "warn", "notifications.parse_failed", "到账通知金额解析失败", { logId: log.id, rawText });
    return { matched: false, order: null, log };
  }

  const transaction = ctx.db.transaction((): NotificationMatchResult => {
    let matchedOrder: Order | null = null;
    const orderRow = ctx.db.query(`
      SELECT o.*, a.code AS account_code
      FROM orders o
      JOIN accounts a ON a.id = o.account_id
      WHERE o.account_id = ?
        AND o.actual_amount_cents = ?
        AND o.status = 'pending'
        AND o.expire_at > ?
      ORDER BY o.created_at ASC
      LIMIT 1
    `).get(account.id, amountCents, now) as OrderRow | null;

    if (orderRow) {
      ctx.db.query(`
        UPDATE orders
        SET status = 'paid', paid_at = ?, updated_at = ?
        WHERE id = ?
      `).run(now, now, orderRow.id);
      matchedOrder = getOrder(ctx, orderRow.id);
    }

    const log = insertNotificationLog(ctx, {
      accountId: account.id,
      deviceId,
      channel: input.channel,
      amountCents,
      rawText,
      matchedOrderId: matchedOrder?.id ?? null,
      status: matchedOrder ? "matched" : "unmatched",
      receivedAt: now
    });

    return { matched: Boolean(matchedOrder), order: matchedOrder, log };
  });

  const result = transaction();
  const { matched, order: matchedOrder, log } = result;

  if (matchedOrder) {
    logSystem(ctx, "info", "notifications.matched", "到账通知已匹配订单", {
      orderId: matchedOrder.id,
      amount: matchedOrder.actualAmount
    });
    queueCallback(ctx, matchedOrder);
  } else {
    logSystem(ctx, "warn", "notifications.unmatched", "到账通知未匹配订单", {
      accountId: account.id,
      amount: formatMoney(amountCents)
    });
  }

  return { matched, order: matchedOrder, log };
}

function insertNotificationLog(
  ctx: AppContext,
  input: {
    accountId: number;
    deviceId?: string;
    channel?: string;
    amountCents: number | null;
    rawText: string;
    matchedOrderId: string | null;
    status: MatchStatus;
    receivedAt: string;
  }
) {
  ctx.db.query(`
    INSERT INTO payment_notifications(
      account_id, device_id, channel, actual_amount_cents, raw_text,
      matched_order_id, status, received_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.accountId,
    input.deviceId ?? null,
    input.channel?.trim() || null,
    input.amountCents,
    input.rawText,
    input.matchedOrderId,
    input.status,
    input.receivedAt
  );

  const id = (ctx.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  return getNotificationLog(ctx, id);
}

function getNotificationLog(ctx: AppContext, id: number) {
  const row = ctx.db.query(`
    SELECT n.*, a.code AS account_code
    FROM payment_notifications n
    JOIN accounts a ON a.id = n.account_id
    WHERE n.id = ?
  `).get(id) as NotificationRow | null;

  if (!row) {
    throw apiError(500, "通知日志读取失败");
  }
  return mapNotification(row);
}

export function listNotificationLogs(
  ctx: AppContext,
  options: { status?: string; limit?: number; offset?: number } = {}
): Page<NotificationLog> {
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];

  const status = options.status;
  if (status && ["matched", "unmatched", "parse_failed"].includes(status)) {
    filters.push("n.status = ?");
    params.push(status);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = ctx.db.query(`
    SELECT n.*, a.code AS account_code
    FROM payment_notifications n
    JOIN accounts a ON a.id = n.account_id
    ${where}
    ORDER BY n.received_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as NotificationRow[];
  const total = scalar(ctx, `
    SELECT COUNT(*) AS value
    FROM payment_notifications n
    JOIN accounts a ON a.id = n.account_id
    ${where}
  `, ...params);

  return { items: rows.map(mapNotification), total, limit, offset };
}

export function listSystemLogs(
  ctx: AppContext,
  options: { level?: string; limit?: number; offset?: number } = {}
): Page<SystemLog> {
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];
  const level = options.level;
  if (level && ["info", "warn", "error"].includes(level)) {
    filters.push("level = ?");
    params.push(level);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = ctx.db.query(`
    SELECT *
    FROM system_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as SystemLogRow[];
  const total = scalar(ctx, `SELECT COUNT(*) AS value FROM system_logs ${where}`, ...params);

  return { items: rows.map(mapSystemLog), total, limit, offset };
}

function callbackPayload(ctx: AppContext, order: Order) {
  const secretRow = ctx.db.query("SELECT callback_secret FROM orders WHERE id = ?")
    .get(order.id) as { callback_secret: string | null } | null;
  const secret = secretRow?.callback_secret || Bun.env.PEERPAY_WEBHOOK_SECRET || "";
  const payload = {
    orderId: order.id,
    merchantOrderId: order.merchantOrderId,
    accountCode: order.accountCode,
    status: "paid",
    requestedAmount: order.requestedAmount,
    actualAmount: order.actualAmount,
    paidAt: order.paidAt
  };
  const sign = signPayload(payload, secret);
  return { ...payload, sign };
}

export function signPayload(payload: Record<string, unknown>, secret: string) {
  const canonical = Object.keys(payload)
    .sort()
    .map((key) => `${key}=${payload[key] ?? ""}`)
    .join("&");
  return createHmac("sha256", secret).update(canonical).digest("hex");
}

export function queueCallback(ctx: AppContext, order: Order) {
  if (!order.callbackUrl) {
    return null;
  }

  const now = nowIso();
  const payload = callbackPayload(ctx, order);
  ctx.db.query(`
    INSERT INTO callback_logs(order_id, url, status, request_body, attempts, next_retry_at, created_at, updated_at)
    VALUES (?, ?, 'pending', ?, 0, ?, ?, ?)
  `).run(order.id, order.callbackUrl, JSON.stringify(payload), now, now, now);
  const id = (ctx.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  if (ctx.runCallbacks) {
    void dispatchCallback(ctx, id);
  }

  return getCallbackLog(ctx, id);
}

export function getCallbackLog(ctx: AppContext, id: number) {
  const row = ctx.db.query("SELECT * FROM callback_logs WHERE id = ?").get(id) as CallbackRow | null;
  return row ? mapCallback(row) : null;
}

export async function dispatchCallback(ctx: AppContext, id: number) {
  const row = ctx.db.query("SELECT * FROM callback_logs WHERE id = ?").get(id) as
    | (CallbackRow & { request_body: string })
    | null;
  if (!row) {
    throw apiError(404, "回调记录不存在");
  }
  if (row.attempts >= ctx.callbackMaxAttempts) {
    throw apiError(409, "回调已达到最大重试次数");
  }

  const attempts = row.attempts + 1;
  const now = nowIso();
  try {
    const body = JSON.parse(row.request_body) as { sign?: string };
    const response = await fetch(row.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-peerpay-signature": body.sign ?? ""
      },
      body: row.request_body,
      signal: AbortSignal.timeout(10_000)
    });
    const responseBody = (await response.text()).slice(0, 2000);
    const ok = response.ok;
    ctx.db.query(`
      UPDATE callback_logs
      SET status = ?, http_status = ?, response_body = ?, error = NULL, attempts = ?,
          next_retry_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      ok ? "success" : "failed",
      response.status,
      responseBody,
      attempts,
      ok || attempts >= ctx.callbackMaxAttempts ? null : addSeconds(30 * attempts),
      now,
      id
    );

    if (ok) {
      ctx.db.query(`
        UPDATE orders
        SET status = 'notified', notified_at = ?, updated_at = ?
        WHERE id = ? AND status = 'paid'
      `).run(now, now, row.order_id);
      logSystem(ctx, "info", "callbacks.success", "订单回调发送成功", { callbackId: id, orderId: row.order_id });
    } else {
      logSystem(ctx, "warn", "callbacks.failed", "订单回调响应失败", {
        callbackId: id,
        orderId: row.order_id,
        httpStatus: response.status
      });
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.db.query(`
      UPDATE callback_logs
      SET status = 'failed', error = ?, attempts = ?, next_retry_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      message.slice(0, 1000),
      attempts,
      attempts >= ctx.callbackMaxAttempts ? null : addSeconds(30 * attempts),
      now,
      id
    );
    logSystem(ctx, "warn", "callbacks.error", "订单回调请求异常", {
      callbackId: id,
      orderId: row.order_id,
      error: message
    });
  }

  return getCallbackLog(ctx, id);
}

export async function retryDueCallbacks(ctx: AppContext) {
  const now = nowIso();
  const rows = ctx.db.query(`
    SELECT *
    FROM callback_logs
    WHERE status != 'success'
      AND attempts < ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC
    LIMIT 20
  `).all(ctx.callbackMaxAttempts, now) as CallbackRow[];

  await Promise.all(rows.map((row) => dispatchCallback(ctx, row.id)));
  return rows.length;
}

export function listCallbackLogs(
  ctx: AppContext,
  options: { status?: string; limit?: number; offset?: number } = {}
): Page<CallbackLog> {
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];
  const status = options.status;
  if (status && ["pending", "success", "failed"].includes(status)) {
    filters.push("status = ?");
    params.push(status);
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = ctx.db.query(`
    SELECT *
    FROM callback_logs
    ${where}
    ORDER BY created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as CallbackRow[];
  const total = scalar(ctx, `SELECT COUNT(*) AS value FROM callback_logs ${where}`, ...params);

  return { items: rows.map(mapCallback), total, limit, offset };
}

export function listAmountOccupations(
  ctx: AppContext,
  options: { accountId?: number; accountCode?: string; limit?: number; offset?: number } = {}
): Page<AmountOccupation> {
  releaseExpiredLocks(ctx);
  const filters = ["o.status = 'pending'"];
  const params: SQLQueryBindings[] = [];

  if (options.accountId != null) {
    filters.push("o.account_id = ?");
    params.push(options.accountId);
  }
  if (options.accountCode) {
    filters.push("a.code = ?");
    params.push(options.accountCode);
  }

  const where = `WHERE ${filters.join(" AND ")}`;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = ctx.db.query(`
    SELECT o.*, a.code AS account_code
    FROM orders o
    JOIN accounts a ON a.id = o.account_id
    ${where}
    ORDER BY o.expire_at ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as OrderRow[];
  const total = scalar(ctx, `
    SELECT COUNT(*) AS value
    FROM orders o
    JOIN accounts a ON a.id = o.account_id
    ${where}
  `, ...params);

  return {
    items: rows.map((row) => ({
      orderId: row.id,
      accountId: row.account_id,
      accountCode: row.account_code,
      actualAmount: formatMoney(row.actual_amount_cents) ?? "0.00",
      actualAmountCents: row.actual_amount_cents,
      requestedAmount: formatMoney(row.requested_amount_cents) ?? "0.00",
      status: row.status,
      expireAt: row.expire_at,
      payMode: row.pay_mode
    })),
    total,
    limit,
    offset
  };
}

export function dashboardStats(ctx: AppContext): DashboardStats {
  releaseExpiredLocks(ctx);
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const total = scalar(ctx, "SELECT COUNT(*) AS value FROM orders");
  const pending = scalar(ctx, "SELECT COUNT(*) AS value FROM orders WHERE status = 'pending'");
  const paid = scalar(ctx, "SELECT COUNT(*) AS value FROM orders WHERE status = 'paid'");
  const notified = scalar(ctx, "SELECT COUNT(*) AS value FROM orders WHERE status = 'notified'");
  const expired = scalar(ctx, "SELECT COUNT(*) AS value FROM orders WHERE status = 'expired'");
  const paidToday = scalar(ctx, "SELECT COUNT(*) AS value FROM orders WHERE paid_at >= ?", today.toISOString());
  const settled = paid + notified + expired;
  const successRate = settled === 0 ? 0 : Math.round(((paid + notified) / settled) * 10000) / 100;
  const onlineThreshold = new Date(Date.now() - DEVICE_ONLINE_WINDOW_MS).toISOString();

  return {
    orders: { total, pending, paid, notified, expired, paidToday, successRate },
    devices: {
      total: scalar(ctx, "SELECT COUNT(*) AS value FROM devices"),
      online: scalar(ctx, "SELECT COUNT(*) AS value FROM devices WHERE enabled = 1 AND last_seen_at >= ?", onlineThreshold)
    },
    amountPool: {
      occupied: scalar(ctx, "SELECT COUNT(*) AS value FROM orders WHERE status = 'pending'"),
      presetQrCodes: scalar(ctx, "SELECT COUNT(*) AS value FROM preset_qr_codes"),
      fallbackAccounts: scalar(ctx, "SELECT COUNT(*) AS value FROM accounts WHERE enabled = 1 AND fallback_pay_url IS NOT NULL AND fallback_pay_url != ''")
    },
    callbacks: {
      pending: scalar(ctx, "SELECT COUNT(*) AS value FROM callback_logs WHERE status = 'pending'"),
      failed: scalar(ctx, "SELECT COUNT(*) AS value FROM callback_logs WHERE status = 'failed'")
    }
  };
}
