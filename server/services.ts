import type { Database, SQLQueryBindings } from "bun:sqlite";
import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createDatabase } from "./db";
import { extractMoneyFromText, formatMoney, parseMoney } from "./money";
import { DEFAULT_MAX_OFFSET_CENTS, DEFAULT_PAYMENT_CHANNEL, NOTIFICATION_KEYWORD_MAX_COUNT, NOTIFICATION_KEYWORD_MAX_LENGTH } from "../src/shared/constants";
import type {
  AndroidNotificationInput,
  AmountOccupation,
  BulkPresetQrCodeInput,
  CallbackLog,
  CallbackStatus,
  CreateDeviceEnrollmentInput,
  CreateOrderInput,
  CreatePaymentAccountInput,
  DashboardStats,
  Device,
  DeviceEnrollment,
  DevicePaymentAccount,
  EnrollDeviceInput,
  EnrollDeviceResult,
  HeartbeatInput,
  LogLevel,
  MatchStatus,
  NotificationLog,
  Order,
  OrderStatus,
  Page,
  PaymentPageData,
  PaymentPageSettings,
  PayMode,
  PaymentAccount,
  PaymentChannel,
  PresetQrCode,
  SystemLog,
  UpdatePaymentAccountInput,
  UpdatePaymentPageSettingsInput
} from "../src/shared/types";

const DEFAULT_ORDER_TTL_MINUTES = 15;
const DEVICE_ONLINE_WINDOW_MS = 2 * 60 * 1000;
const MAX_CALLBACK_ATTEMPTS = 5;
const PAYMENT_PAGE_SETTINGS_KEY = "payment_page_settings";
const PAYMENT_CHANNEL_ALIASES: Record<string, PaymentChannel> = {
  alipay: "alipay",
  ali: "alipay",
  "支付宝": "alipay",
  "com.eg.android.alipaygphone": "alipay",
  wechat: "wechat",
  weixin: "wechat",
  wx: "wechat",
  "微信": "wechat",
  "com.tencent.mm": "wechat"
};

const DEFAULT_PAYMENT_PAGE_SETTINGS: PaymentPageSettings = {
  noticeEnabled: false,
  noticeTitle: "",
  noticeBody: "",
  noticeLinkText: "",
  noticeLinkUrl: null
};

type RowBool = 0 | 1;

interface PaymentAccountRow {
  id: number;
  code: string;
  name: string;
  payment_channel: PaymentChannel;
  priority: number;
  enabled: RowBool;
  max_offset_cents: number;
  fallback_pay_url: string | null;
  notification_keywords: string | null;
  created_at: string;
}

interface PresetQrCodeRow {
  id: number;
  payment_account_id: number;
  payment_account_code: string;
  payment_account_name: string;
  payment_channel: PaymentChannel;
  amount_cents: number;
  pay_url: string;
  checked: RowBool;
  created_at: string;
  updated_at: string;
}

interface OrderRow {
  id: string;
  merchant_order_id: string | null;
  payment_account_id: number;
  payment_account_code: string;
  payment_account_name: string;
  payment_channel: PaymentChannel;
  requested_amount_cents: number;
  actual_amount_cents: number;
  pay_url: string;
  pay_mode: PayMode;
  amount_input_required: RowBool;
  status: OrderStatus;
  subject: string | null;
  callback_url: string | null;
  redirect_url: string | null;
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
  payment_account_id: number;
  payment_account_code: string;
  payment_account_name: string;
  payment_channel: PaymentChannel;
  name: string | null;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
  created_at: string;
}

interface NotificationRow {
  id: number;
  payment_account_id: number | null;
  payment_account_code: string | null;
  payment_account_name: string | null;
  payment_channel: PaymentChannel | null;
  device_id: string | null;
  channel: string | null;
  package_name: string | null;
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

export function paymentPagePath(orderId: string) {
  return `/pay/${encodeURIComponent(orderId)}`;
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

function mapPaymentAccount(row: PaymentAccountRow): PaymentAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    paymentChannel: row.payment_channel,
    priority: row.priority,
    enabled: row.enabled === 1,
    maxOffsetCents: row.max_offset_cents,
    maxOffset: formatMoney(row.max_offset_cents) ?? "0.00",
    fallbackPayUrl: row.fallback_pay_url,
    notificationKeywords: parseNotificationKeywords(row.notification_keywords),
    createdAt: row.created_at
  };
}

function mapPresetQrCode(row: PresetQrCodeRow): PresetQrCode {
  return {
    id: row.id,
    paymentAccountId: row.payment_account_id,
    paymentAccountCode: row.payment_account_code,
    paymentAccountName: row.payment_account_name,
    paymentChannel: row.payment_channel,
    amount: formatMoney(row.amount_cents) ?? "0.00",
    amountCents: row.amount_cents,
    payUrl: row.pay_url,
    checked: row.checked === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapOrder(row: OrderRow): Order {
  return {
    id: row.id,
    merchantOrderId: row.merchant_order_id,
    paymentAccountId: row.payment_account_id,
    paymentAccountCode: row.payment_account_code,
    paymentAccountName: row.payment_account_name,
    paymentChannel: row.payment_channel,
    requestedAmount: formatMoney(row.requested_amount_cents) ?? "0.00",
    requestedAmountCents: row.requested_amount_cents,
    actualAmount: formatMoney(row.actual_amount_cents) ?? "0.00",
    actualAmountCents: row.actual_amount_cents,
    payUrl: paymentPagePath(row.id),
    payMode: row.pay_mode,
    amountInputRequired: row.amount_input_required === 1,
    status: row.status,
    subject: row.subject,
    callbackUrl: row.callback_url,
    redirectUrl: row.redirect_url,
    expireAt: row.expire_at,
    paidAt: row.paid_at,
    notifiedAt: row.notified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapDevicePaymentAccount(row: PaymentAccountRow): DevicePaymentAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    paymentChannel: row.payment_channel
  };
}

function mapDevice(ctx: AppContext, row: DeviceRow): Device {
  const threshold = Date.now() - DEVICE_ONLINE_WINDOW_MS;
  const lastSeen = row.last_seen_at ? Date.parse(row.last_seen_at) : 0;

  return {
    id: row.id,
    deviceId: row.device_id,
    name: row.name,
    paymentAccounts: listDevicePaymentAccounts(ctx, row.device_id).map(mapDevicePaymentAccount),
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
    paymentAccountId: row.payment_account_id,
    paymentAccountCode: row.payment_account_code,
    paymentAccountName: row.payment_account_name,
    paymentChannel: row.payment_channel,
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
    paymentAccountId: row.payment_account_id,
    paymentAccountCode: row.payment_account_code,
    paymentAccountName: row.payment_account_name,
    paymentChannel: row.payment_channel,
    deviceId: row.device_id,
    packageName: row.package_name,
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

function parseNotificationKeywords(value: string | null) {
  if (!value) {
    return [];
  }

  try {
    return normalizeKeywordList(JSON.parse(value), "到账通知关键词");
  } catch {
    return [];
  }
}

function paymentAccountById(ctx: AppContext, id: number) {
  const row = ctx.db.query("SELECT * FROM payment_accounts WHERE id = ?").get(id) as PaymentAccountRow | null;
  return row ? mapPaymentAccount(row) : null;
}

function paymentAccountByCode(ctx: AppContext, code: string) {
  const row = ctx.db.query("SELECT * FROM payment_accounts WHERE code = ?").get(code) as PaymentAccountRow | null;
  return row ? mapPaymentAccount(row) : null;
}

function resolvePaymentAccount(
  ctx: AppContext,
  input: { paymentAccountId?: number; paymentAccountCode?: string },
  requireEnabled = false
) {
  let account: PaymentAccount | null = null;

  if (input.paymentAccountId != null) {
    account = paymentAccountById(ctx, input.paymentAccountId);
  } else if (input.paymentAccountCode) {
    account = paymentAccountByCode(ctx, input.paymentAccountCode);
  }

  if (!account) {
    throw apiError(404, "收款账号不存在");
  }

  if (requireEnabled && !account.enabled) {
    throw apiError(409, "收款账号已禁用");
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

function normalizePriority(value: number) {
  if (!Number.isInteger(value) || value < 0 || value > 999999) {
    throw apiError(400, "优先级必须是 0 到 999999 之间的整数");
  }
  return value;
}

function normalizePaymentChannel(value: unknown, fallback: PaymentChannel = DEFAULT_PAYMENT_CHANNEL): PaymentChannel {
  const text = String(value ?? "").trim();
  if (!text) {
    return fallback;
  }

  const channel = PAYMENT_CHANNEL_ALIASES[text.toLowerCase()] ?? PAYMENT_CHANNEL_ALIASES[text];
  if (!channel) {
    throw apiError(400, "付款方式仅支持微信或支付宝");
  }
  return channel;
}

function packageNameFromNotification(input: AndroidNotificationInput) {
  return (input.packageName ?? input.appPackageName ?? input.appPackage ?? input.package ?? "").trim();
}

function inferPaymentChannel(input: AndroidNotificationInput, rawText: string) {
  const packageName = packageNameFromNotification(input);
  if (input.paymentChannel || input.channel) {
    return normalizePaymentChannel(input.paymentChannel ?? input.channel);
  }
  if (packageName) {
    return normalizePaymentChannel(packageName);
  }
  if (/微信|wechat/i.test(rawText)) {
    return "wechat";
  }
  if (/支付宝|alipay/i.test(rawText)) {
    return "alipay";
  }
  return DEFAULT_PAYMENT_CHANNEL;
}

function accountPassesKeywordFilter(account: PaymentAccountRow, rawText: string) {
  const keywords = parseNotificationKeywords(account.notification_keywords);
  if (keywords.length === 0) {
    return true;
  }

  const text = rawText.toLowerCase();
  return keywords.some((keyword) => text.includes(keyword.toLowerCase()));
}

const ALLOWED_PAY_URL_PROTOCOLS = new Set(["http:", "https:", "wxp:"]);

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
    if (!ALLOWED_PAY_URL_PROTOCOLS.has(url.protocol)) {
      throw new Error("invalid protocol");
    }
    return url.toString();
  } catch {
    throw apiError(400, "付款 URL 必须是有效的 http/https/wxp 地址");
  }
}

function normalizeOptionalHttpUrl(value: unknown, label = "公告链接") {
  const text = String(value ?? "").trim();
  if (!text) {
    return null;
  }

  try {
    const url = new URL(text);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
    return url.toString();
  } catch {
    throw apiError(400, `${label}必须是有效的 http/https 地址`);
  }
}

function firstNonEmptyValue(...values: unknown[]) {
  return values.find((value) => String(value ?? "").trim()) ?? null;
}

function textWithin(value: string | null | undefined, label: string, maxLength: number) {
  const text = `${value ?? ""}`.trim();
  if (text.length > maxLength) {
    throw apiError(400, `${label}不能超过 ${maxLength} 个字符`);
  }
  return text;
}

function appSetting(ctx: AppContext, key: string) {
  const row = ctx.db.query("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

function setAppSetting(ctx: AppContext, key: string, value: string) {
  ctx.db.query(`
    INSERT INTO app_settings(key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, nowIso());
}

function normalizeKeywordList(value: unknown, label: string) {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\r\n,，;；]+/)
      : [];
  const keywords: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const keyword = String(item ?? "").trim();
    if (!keyword) {
      continue;
    }
    if (keyword.length > NOTIFICATION_KEYWORD_MAX_LENGTH) {
      throw apiError(400, `${label}不能超过 ${NOTIFICATION_KEYWORD_MAX_LENGTH} 个字符`);
    }

    const key = keyword.toLowerCase();
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    keywords.push(keyword);
  }

  if (keywords.length > NOTIFICATION_KEYWORD_MAX_COUNT) {
    throw apiError(400, `${label}不能超过 ${NOTIFICATION_KEYWORD_MAX_COUNT} 个`);
  }

  return keywords;
}

function normalizePaymentPageSettingsInput(
  input: UpdatePaymentPageSettingsInput = {},
  fallback: PaymentPageSettings = DEFAULT_PAYMENT_PAGE_SETTINGS
): PaymentPageSettings {
  const source = { ...fallback, ...input };
  const noticeTitle = textWithin(source.noticeTitle, "公告标题", 80);
  const noticeBody = textWithin(source.noticeBody, "公告内容", 500);
  const noticeLinkUrl = normalizeOptionalHttpUrl(source.noticeLinkUrl);
  const noticeLinkText = noticeLinkUrl ? textWithin(source.noticeLinkText || "查看详情", "公告链接文案", 40) : "";
  const noticeEnabled = Boolean(source.noticeEnabled);

  if (noticeEnabled && !noticeTitle && !noticeBody) {
    throw apiError(400, "启用公告位时请填写公告标题或内容");
  }

  return {
    noticeEnabled,
    noticeTitle,
    noticeBody,
    noticeLinkText,
    noticeLinkUrl
  };
}

export function getPaymentPageSettings(ctx: AppContext): PaymentPageSettings {
  const value = appSetting(ctx, PAYMENT_PAGE_SETTINGS_KEY);
  if (!value) {
    return { ...DEFAULT_PAYMENT_PAGE_SETTINGS };
  }

  try {
    return normalizePaymentPageSettingsInput(JSON.parse(value) as UpdatePaymentPageSettingsInput);
  } catch {
    return { ...DEFAULT_PAYMENT_PAGE_SETTINGS };
  }
}

export function updatePaymentPageSettings(ctx: AppContext, input: UpdatePaymentPageSettingsInput = {}) {
  const settings = normalizePaymentPageSettingsInput(input, getPaymentPageSettings(ctx));
  setAppSetting(ctx, PAYMENT_PAGE_SETTINGS_KEY, JSON.stringify(settings));
  logSystem(ctx, "info", "payment_page.settings_updated", "付款页配置已更新", {
    noticeEnabled: settings.noticeEnabled
  });
  return settings;
}

export function getPublicPaymentPage(ctx: AppContext, id: string): PaymentPageData {
  releaseExpiredLocks(ctx);
  const row = ctx.db.query(orderSelectSql("WHERE o.id = ?")).get(id) as OrderRow | null;
  if (!row) {
    throw apiError(404, "订单不存在");
  }

  const settings = getPaymentPageSettings(ctx);
  const notice = settings.noticeEnabled && (settings.noticeTitle || settings.noticeBody)
    ? {
        title: settings.noticeTitle,
        body: settings.noticeBody,
        linkText: settings.noticeLinkText,
        linkUrl: settings.noticeLinkUrl
      }
    : null;

  return {
    orderId: row.id,
    merchantOrderId: row.merchant_order_id,
    paymentAccountName: row.payment_account_name,
    paymentAccountCode: row.payment_account_code,
    paymentChannel: row.payment_channel,
    requestedAmount: formatMoney(row.requested_amount_cents) ?? "0.00",
    actualAmount: formatMoney(row.actual_amount_cents) ?? "0.00",
    targetPayUrl: row.pay_url,
    payMode: row.pay_mode,
    amountInputRequired: row.amount_input_required === 1,
    status: row.status,
    subject: row.subject,
    redirectUrl: row.redirect_url,
    expireAt: row.expire_at,
    notice
  };
}

function orderSelectSql(where: string) {
  return `
    SELECT o.*, pa.code AS payment_account_code, pa.name AS payment_account_name
    FROM orders o
    JOIN payment_accounts pa ON pa.id = o.payment_account_id
    ${where}
  `;
}

function presetSelectSql(where: string) {
  return `
    SELECT q.*, pa.code AS payment_account_code, pa.name AS payment_account_name, pa.payment_channel
    FROM preset_qr_codes q
    JOIN payment_accounts pa ON pa.id = q.payment_account_id
    ${where}
  `;
}

export function releaseExpiredLocks(ctx: AppContext) {
  const now = nowIso();
  const expiredOrders = ctx.db.query(orderSelectSql("WHERE o.status = 'pending' AND o.expire_at <= ?"))
    .all(now) as OrderRow[];

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

export function listPaymentAccounts(ctx: AppContext) {
  const rows = ctx.db.query("SELECT * FROM payment_accounts ORDER BY payment_channel ASC, priority ASC, id ASC").all() as PaymentAccountRow[];
  return rows.map(mapPaymentAccount);
}

export function createPaymentAccount(ctx: AppContext, input: CreatePaymentAccountInput) {
  const code = input.code.trim();
  const name = input.name.trim();
  const paymentChannel = normalizePaymentChannel(input.paymentChannel);
  const priority = normalizePriority(input.priority ?? 100);
  const maxOffsetCents = normalizeMaxOffset(input.maxOffsetCents ?? DEFAULT_MAX_OFFSET_CENTS);
  const fallbackPayUrl = normalizePayUrl(input.fallbackPayUrl ?? null, true);
  const notificationKeywords = normalizeKeywordList(input.notificationKeywords, "到账通知关键词");

  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(code)) {
    throw apiError(400, "收款账号编码仅支持 2-32 位字母、数字、下划线或短横线");
  }
  if (!name) {
    throw apiError(400, "收款账号名称不能为空");
  }

  try {
    ctx.db.query(`
      INSERT INTO payment_accounts(code, name, payment_channel, priority, max_offset_cents, fallback_pay_url, notification_keywords)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(code, name, paymentChannel, priority, maxOffsetCents, fallbackPayUrl, JSON.stringify(notificationKeywords));
  } catch {
    throw apiError(409, "收款账号编码已存在");
  }

  const account = paymentAccountByCode(ctx, code);
  if (!account) {
    throw apiError(500, "收款账号创建失败");
  }
  logSystem(ctx, "info", "payment_accounts.created", "收款账号已创建", { paymentAccountId: account.id, code });
  return account;
}

export function setPaymentAccountEnabled(ctx: AppContext, id: number, enabled: boolean) {
  const account = paymentAccountById(ctx, id);
  if (!account) {
    throw apiError(404, "收款账号不存在");
  }

  ctx.db.query("UPDATE payment_accounts SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  logSystem(ctx, "info", "payment_accounts.enabled", "收款账号状态已更新", { paymentAccountId: id, enabled });
  return paymentAccountById(ctx, id);
}

export function updatePaymentAccountSettings(ctx: AppContext, id: number, input: UpdatePaymentAccountInput) {
  const account = paymentAccountById(ctx, id);
  if (!account) {
    throw apiError(404, "收款账号不存在");
  }

  const code = input.code === undefined ? account.code : input.code.trim();
  const name = input.name === undefined ? account.name : input.name.trim();
  const paymentChannel = normalizePaymentChannel(input.paymentChannel, account.paymentChannel);
  const priority = normalizePriority(input.priority ?? account.priority);
  const maxOffsetCents = normalizeMaxOffset(input.maxOffsetCents ?? account.maxOffsetCents);
  const fallbackPayUrl = normalizePayUrl(
    input.fallbackPayUrl === undefined ? account.fallbackPayUrl : input.fallbackPayUrl,
    true
  );
  const notificationKeywords = normalizeKeywordList(
    input.notificationKeywords === undefined ? account.notificationKeywords : input.notificationKeywords,
    "到账通知关键词"
  );

  if (!/^[a-zA-Z0-9_-]{2,32}$/.test(code)) {
    throw apiError(400, "收款账号编码仅支持 2-32 位字母、数字、下划线或短横线");
  }
  if (!name) {
    throw apiError(400, "收款账号名称不能为空");
  }

  try {
    ctx.db.query(`
      UPDATE payment_accounts
      SET code = ?, name = ?, payment_channel = ?, priority = ?, max_offset_cents = ?, fallback_pay_url = ?, notification_keywords = ?
      WHERE id = ?
    `).run(code, name, paymentChannel, priority, maxOffsetCents, fallbackPayUrl, JSON.stringify(notificationKeywords), id);
  } catch {
    throw apiError(409, "收款账号编码已存在");
  }
  logSystem(ctx, "info", "payment_accounts.settings_updated", "收款账号配置已更新", {
    paymentAccountId: id,
    paymentChannel,
    priority,
    maxOffsetCents,
    hasFallbackPayUrl: Boolean(fallbackPayUrl),
    notificationKeywords: notificationKeywords.length
  });
  return paymentAccountById(ctx, id);
}

export function upsertPresetQrCodes(ctx: AppContext, input: BulkPresetQrCodeInput) {
  const account = resolvePaymentAccount(ctx, input, true);
  if (!Array.isArray(input.items) || input.items.length === 0) {
    throw apiError(400, "请提供至少一个二维码配置");
  }
  if (input.items.length > 5000) {
    throw apiError(400, "单次导入二维码不能超过 5000 条");
  }

  const now = nowIso();
  const upsert = ctx.db.query(`
    INSERT INTO preset_qr_codes(payment_account_id, amount_cents, pay_url, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(payment_account_id, amount_cents) DO UPDATE SET
      pay_url = excluded.pay_url,
      checked = CASE WHEN preset_qr_codes.pay_url = excluded.pay_url THEN preset_qr_codes.checked ELSE 0 END,
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
    paymentAccountId: account.id,
    saved
  });
  return { paymentAccount: account, saved };
}

export function listPresetQrCodes(
  ctx: AppContext,
  options: { paymentAccountId?: number; paymentAccountCode?: string; paymentChannel?: string; limit?: number; offset?: number } = {}
): Page<PresetQrCode> {
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];

  if (options.paymentAccountId != null) {
    filters.push("q.payment_account_id = ?");
    params.push(options.paymentAccountId);
  }
  if (options.paymentAccountCode) {
    filters.push("pa.code = ?");
    params.push(options.paymentAccountCode);
  }
  if (options.paymentChannel) {
    filters.push("pa.payment_channel = ?");
    params.push(normalizePaymentChannel(options.paymentChannel));
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = ctx.db.query(`
    ${presetSelectSql(where)}
    ORDER BY pa.payment_channel ASC, pa.priority ASC, pa.id ASC, q.amount_cents ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as PresetQrCodeRow[];
  const total = scalar(ctx, `
    SELECT COUNT(*) AS value
    FROM preset_qr_codes q
    JOIN payment_accounts pa ON pa.id = q.payment_account_id
    ${where}
  `, ...params);

  return { items: rows.map(mapPresetQrCode), total, limit, offset };
}

export function setPresetQrCodeChecked(ctx: AppContext, id: number, checked: boolean) {
  const row = ctx.db.query(presetSelectSql("WHERE q.id = ?")).get(id) as PresetQrCodeRow | null;

  if (!row) {
    throw apiError(404, "定额二维码不存在");
  }

  const now = nowIso();
  ctx.db.query("UPDATE preset_qr_codes SET checked = ?, updated_at = ? WHERE id = ?")
    .run(checked ? 1 : 0, now, id);

  logSystem(ctx, "info", "preset_qr_codes.checked_updated", "定额二维码检查状态已更新", {
    qrCodeId: id,
    paymentAccountId: row.payment_account_id,
    checked
  });

  const updated = ctx.db.query(presetSelectSql("WHERE q.id = ?")).get(id) as PresetQrCodeRow | null;
  if (!updated) {
    throw apiError(500, "定额二维码检查状态更新失败");
  }
  return mapPresetQrCode(updated);
}

export function deletePresetQrCode(ctx: AppContext, id: number) {
  const row = ctx.db.query(presetSelectSql("WHERE q.id = ?")).get(id) as PresetQrCodeRow | null;

  if (!row) {
    throw apiError(404, "定额二维码不存在");
  }

  ctx.db.query("DELETE FROM preset_qr_codes WHERE id = ?").run(id);
  logSystem(ctx, "warn", "preset_qr_codes.deleted", "定额二维码已删除", {
    qrCodeId: id,
    paymentAccountId: row.payment_account_id,
    amount: formatMoney(row.amount_cents)
  });

  return mapPresetQrCode(row);
}

function enabledPaymentAccountRows(ctx: AppContext, paymentChannel: PaymentChannel) {
  return ctx.db.query(`
    SELECT *
    FROM payment_accounts
    WHERE payment_channel = ? AND enabled = 1
    ORDER BY priority ASC, id ASC
  `).all(paymentChannel) as PaymentAccountRow[];
}

function findPresetQrCode(ctx: AppContext, paymentAccountId: number, amountCents: number) {
  const row = ctx.db.query(presetSelectSql("WHERE q.payment_account_id = ? AND q.amount_cents = ?"))
    .get(paymentAccountId, amountCents) as PresetQrCodeRow | null;

  return row ? mapPresetQrCode(row) : null;
}

function allocateActualAmount(
  ctx: AppContext,
  paymentChannel: PaymentChannel,
  requestedAmount: number,
  now: string
) {
  const accounts = enabledPaymentAccountRows(ctx, paymentChannel);
  if (accounts.length === 0) {
    throw apiError(409, "没有可用收款账号");
  }

  const maxOffsetCents = requestedAmount % 100 === 0
    ? Math.max(...accounts.map((account) => account.max_offset_cents))
    : 0;
  const accountIds = accounts.map((account) => account.id);
  const placeholders = accountIds.map(() => "?").join(", ");
  const rows = ctx.db.query(`
    SELECT payment_account_id AS paymentAccountId, actual_amount_cents AS amount
    FROM orders
    WHERE payment_account_id IN (${placeholders})
      AND status = 'pending'
      AND expire_at > ?
      AND actual_amount_cents BETWEEN ? AND ?
  `).all(...accountIds, now, requestedAmount, requestedAmount + maxOffsetCents) as Array<{ paymentAccountId: number; amount: number }>;
  const occupied = new Map<number, Set<number>>();
  for (const row of rows) {
    const set = occupied.get(row.paymentAccountId) ?? new Set<number>();
    set.add(row.amount);
    occupied.set(row.paymentAccountId, set);
  }

  for (let offset = 0; offset <= maxOffsetCents; offset += 1) {
    for (const account of accounts) {
      if (offset > account.max_offset_cents) {
        continue;
      }
      const candidate = requestedAmount + offset;
      if (occupied.get(account.id)?.has(candidate)) {
        continue;
      }

      const preset = findPresetQrCode(ctx, account.id, candidate);
      const payUrl = preset?.payUrl ?? account.fallback_pay_url;
      if (!payUrl) {
        continue;
      }

      return {
        account,
        actualAmount: candidate,
        payUrl,
        payMode: (preset ? "preset" : "fallback") as PayMode
      };
    }
  }

  throw apiError(409, `付款方式 ${paymentChannel} 的订单金额 ${formatMoney(requestedAmount)} 在账号池最大偏移 ${formatMoney(maxOffsetCents)} 内已无可用收款账号`);
}

export function createOrder(ctx: AppContext, input: CreateOrderInput) {
  releaseExpiredLocks(ctx);
  const paymentChannel = normalizePaymentChannel(input.paymentChannel ?? input.channel);
  const requestedAmount = parseMoney(input.amount);
  const ttlMinutes = Math.min(Math.max(input.ttlMinutes ?? DEFAULT_ORDER_TTL_MINUTES, 1), 1440);
  const now = nowIso();
  const expireAt = addMinutes(ttlMinutes);
  const id = createOrderId();
  const callbackUrl = input.callbackUrl?.trim() || null;
  const callbackSecret = input.callbackSecret?.trim() || null;
  const redirectUrl = normalizeOptionalHttpUrl(
    firstNonEmptyValue(input.redirectUrl, input.redirect_url, input.returnUrl, input.return_url),
    "重定向地址"
  );

  if (callbackUrl && !callbackSecret) {
    throw apiError(400, "设置回调地址时必须提供 callbackSecret");
  }

  const createTransaction = ctx.db.transaction(() => {
    const allocation = allocateActualAmount(ctx, paymentChannel, requestedAmount, now);

    ctx.db.query(`
      INSERT INTO orders(
        id, merchant_order_id, payment_account_id, payment_channel, requested_amount_cents, actual_amount_cents,
        pay_url, pay_mode, amount_input_required, status, subject, callback_url, callback_secret, redirect_url, expire_at, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.merchantOrderId?.trim() || null,
      allocation.account.id,
      paymentChannel,
      requestedAmount,
      allocation.actualAmount,
      allocation.payUrl,
      allocation.payMode,
      allocation.payMode === "fallback" ? 1 : 0,
      input.subject?.trim() || null,
      callbackUrl,
      callbackSecret,
      redirectUrl,
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
    paymentAccountId: order.paymentAccountId,
    paymentAccountCode: order.paymentAccountCode,
    paymentChannel: order.paymentChannel,
    requestedAmount: formatMoney(requestedAmount),
    actualAmount: order.actualAmount,
    payMode: order.payMode
  });
  return order;
}

export function getOrder(ctx: AppContext, id: string) {
  const row = ctx.db.query(orderSelectSql("WHERE o.id = ?")).get(id) as OrderRow | null;
  return row ? mapOrder(row) : null;
}

export function listOrders(
  ctx: AppContext,
  options: { status?: string; paymentAccountId?: number; paymentAccountCode?: string; paymentChannel?: string; limit?: number; offset?: number } = {}
): Page<Order> {
  releaseExpiredLocks(ctx);
  const filters: string[] = [];
  const params: SQLQueryBindings[] = [];

  const status = options.status;
  if (status && ["pending", "paid", "notified", "expired"].includes(status)) {
    filters.push("o.status = ?");
    params.push(status);
  }
  if (options.paymentAccountId != null) {
    filters.push("o.payment_account_id = ?");
    params.push(options.paymentAccountId);
  }
  if (options.paymentAccountCode) {
    filters.push("pa.code = ?");
    params.push(options.paymentAccountCode);
  }
  if (options.paymentChannel) {
    filters.push("o.payment_channel = ?");
    params.push(normalizePaymentChannel(options.paymentChannel));
  }

  const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = ctx.db.query(`
    ${orderSelectSql(where)}
    ORDER BY o.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as OrderRow[];
  const total = scalar(ctx, `
    SELECT COUNT(*) AS value
    FROM orders o
    JOIN payment_accounts pa ON pa.id = o.payment_account_id
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
  const account = resolvePaymentAccount(ctx, input, true);
  const ttlMinutes = Math.min(Math.max(input.ttlMinutes ?? 30, 1), 1440);
  const now = nowIso();
  const token = createSecret(18);
  const expiresAt = addMinutes(ttlMinutes);

  ctx.db.query(`
    INSERT INTO device_enrollments(payment_account_id, name, token_hash, expires_at, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(account.id, input.name?.trim() || null, sha256(token), expiresAt, now);

  const id = (ctx.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  const row = ctx.db.query(`
    SELECT e.*, pa.code AS payment_account_code, pa.name AS payment_account_name, pa.payment_channel
    FROM device_enrollments e
    JOIN payment_accounts pa ON pa.id = e.payment_account_id
    WHERE e.id = ?
  `).get(id) as DeviceEnrollmentRow | null;

  if (!row) {
    throw apiError(500, "设备配对码创建失败");
  }

  logSystem(ctx, "info", "devices.enrollment_created", "设备配对码已创建", {
    enrollmentId: id,
    paymentAccountId: account.id,
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
    SELECT e.*, pa.code AS payment_account_code, pa.name AS payment_account_name, pa.payment_channel
    FROM device_enrollments e
    JOIN payment_accounts pa ON pa.id = e.payment_account_id
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
      INSERT INTO devices(device_id, name, device_secret, enabled, paired_at, last_seen_at, app_version, metadata, created_at, updated_at)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(device_id) DO UPDATE SET
        name = COALESCE(excluded.name, devices.name),
        device_secret = excluded.device_secret,
        enabled = 1,
        paired_at = COALESCE(devices.paired_at, excluded.paired_at),
        last_seen_at = excluded.last_seen_at,
        app_version = COALESCE(excluded.app_version, devices.app_version),
        metadata = COALESCE(excluded.metadata, devices.metadata),
        updated_at = excluded.updated_at
    `).run(
      deviceId,
      name,
      deviceSecret,
      now,
      now,
      input.appVersion?.trim() || null,
      metadata,
      now,
      now
    );

    ctx.db.query(`
      INSERT OR IGNORE INTO device_payment_accounts(device_id, payment_account_id, created_at)
      VALUES (?, ?, ?)
    `).run(deviceId, row.payment_account_id, now);
  });
  transaction();

  const device = getDeviceByDeviceId(ctx, deviceId);
  if (!device) {
    throw apiError(500, "设备配对失败");
  }

  logSystem(ctx, "info", "devices.enrolled", "安卓设备已加入系统", {
    deviceId,
    paymentAccountId: row.payment_account_id
  });
  return { device: mapDevice(ctx, device), deviceSecret };
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

  return mapDevice(ctx, device);
}

function getDeviceByDeviceId(ctx: AppContext, deviceId: string) {
  return ctx.db.query("SELECT * FROM devices WHERE device_id = ?").get(deviceId) as DeviceRow | null;
}

function listDevicePaymentAccounts(ctx: AppContext, deviceId: string, paymentChannel?: PaymentChannel) {
  const params: SQLQueryBindings[] = [deviceId];
  const channelFilter = paymentChannel ? "AND pa.payment_channel = ?" : "";
  if (paymentChannel) {
    params.push(paymentChannel);
  }
  return ctx.db.query(`
    SELECT pa.*
    FROM device_payment_accounts dpa
    JOIN payment_accounts pa ON pa.id = dpa.payment_account_id
    WHERE dpa.device_id = ? ${channelFilter}
    ORDER BY pa.payment_channel ASC, pa.priority ASC, pa.id ASC
  `).all(...params) as PaymentAccountRow[];
}

export function listDevices(ctx: AppContext) {
  const rows = ctx.db.query(`
    SELECT *
    FROM devices
    ORDER BY last_seen_at DESC NULLS LAST, id DESC
  `).all() as DeviceRow[];
  return rows.map((row) => mapDevice(ctx, row));
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
  if (!row || row.enabled !== 1 || !row.device_secret) {
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
  return mapDevice(ctx, { ...row, last_seen_at: now, updated_at: now });
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
  const rawText = input.rawText?.trim() || input.text?.trim() || "";
  const packageName = packageNameFromNotification(input);
  const paymentChannel = inferPaymentChannel(input, rawText);
  const rawChannel = input.channel?.trim() || null;
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
      paymentAccountId: null,
      deviceId,
      channel: rawChannel,
      paymentChannel,
      packageName,
      amountCents: null,
      rawText,
      matchedOrderId: null,
      status: "parse_failed",
      receivedAt: now
    });
    logSystem(ctx, "warn", "notifications.parse_failed", "到账通知金额解析失败", { logId: log.id, rawText });
    return { matched: false, order: null, log };
  }

  const boundAccounts = listDevicePaymentAccounts(ctx, deviceId, paymentChannel)
    .filter((account) => account.enabled === 1)
    .filter((account) => accountPassesKeywordFilter(account, rawText));
  const transaction = ctx.db.transaction((): NotificationMatchResult => {
    let matchedOrder: Order | null = null;
    if (boundAccounts.length > 0) {
      const accountIds = boundAccounts.map((account) => account.id);
      const placeholders = accountIds.map(() => "?").join(", ");
      const orderRow = ctx.db.query(`
        ${orderSelectSql(`WHERE o.payment_account_id IN (${placeholders})
          AND o.payment_channel = ?
          AND o.actual_amount_cents = ?
          AND o.status = 'pending'
          AND o.expire_at > ?`)}
        ORDER BY pa.priority ASC, pa.id ASC, o.created_at ASC
        LIMIT 1
      `).get(...accountIds, paymentChannel, amountCents, now) as OrderRow | null;

      if (orderRow) {
        ctx.db.query(`
          UPDATE orders
          SET status = 'paid', paid_at = ?, updated_at = ?
          WHERE id = ?
        `).run(now, now, orderRow.id);
        matchedOrder = getOrder(ctx, orderRow.id);
      }
    }

    const log = insertNotificationLog(ctx, {
      paymentAccountId: matchedOrder?.paymentAccountId ?? null,
      deviceId,
      channel: rawChannel,
      paymentChannel,
      packageName,
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
      paymentAccountId: matchedOrder.paymentAccountId,
      paymentChannel,
      amount: matchedOrder.actualAmount
    });
    queueCallback(ctx, matchedOrder);
  } else {
    logSystem(ctx, "warn", "notifications.unmatched", "到账通知未匹配订单", {
      deviceId,
      paymentChannel,
      packageName,
      amount: formatMoney(amountCents)
    });
  }

  return { matched, order: matchedOrder, log };
}

function insertNotificationLog(
  ctx: AppContext,
  input: {
    paymentAccountId: number | null;
    deviceId?: string;
    channel?: string | null;
    paymentChannel: PaymentChannel | null;
    packageName?: string;
    amountCents: number | null;
    rawText: string;
    matchedOrderId: string | null;
    status: MatchStatus;
    receivedAt: string;
  }
) {
  ctx.db.query(`
    INSERT INTO payment_notifications(
      payment_account_id, device_id, channel, payment_channel, package_name, actual_amount_cents, raw_text,
      matched_order_id, status, received_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    input.paymentAccountId,
    input.deviceId ?? null,
    input.channel?.trim() || null,
    input.paymentChannel,
    input.packageName?.trim() || null,
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
    SELECT n.*, pa.code AS payment_account_code, pa.name AS payment_account_name
    FROM payment_notifications n
    LEFT JOIN payment_accounts pa ON pa.id = n.payment_account_id
    WHERE n.id = ?
  `).get(id) as NotificationRow | null;

  if (!row) {
    throw apiError(500, "到账通知日志读取失败");
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
    SELECT n.*, pa.code AS payment_account_code, pa.name AS payment_account_name
    FROM payment_notifications n
    LEFT JOIN payment_accounts pa ON pa.id = n.payment_account_id
    ${where}
    ORDER BY n.received_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as NotificationRow[];
  const total = scalar(ctx, `
    SELECT COUNT(*) AS value
    FROM payment_notifications n
    LEFT JOIN payment_accounts pa ON pa.id = n.payment_account_id
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
  const secret = secretRow?.callback_secret;
  if (!secret) {
    throw apiError(500, "订单回调密钥缺失");
  }
  const payload = {
    orderId: order.id,
    merchantOrderId: order.merchantOrderId,
    paymentAccountCode: order.paymentAccountCode,
    paymentChannel: order.paymentChannel,
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
    ctx.db.query(`
      UPDATE callback_logs
      SET status = 'failed', error = ?, attempts = ?, next_retry_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      error instanceof Error ? error.message : String(error),
      attempts,
      attempts >= ctx.callbackMaxAttempts ? null : addSeconds(30 * attempts),
      now,
      id
    );
    logSystem(ctx, "warn", "callbacks.error", "订单回调请求异常", {
      callbackId: id,
      orderId: row.order_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return getCallbackLog(ctx, id);
}

export async function dispatchDueCallbacks(ctx: AppContext) {
  const now = nowIso();
  const rows = ctx.db.query(`
    SELECT *
    FROM callback_logs
    WHERE status IN ('pending', 'failed')
      AND attempts < ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC
    LIMIT 20
  `).all(ctx.callbackMaxAttempts, now) as CallbackRow[];

  for (const row of rows) {
    await dispatchCallback(ctx, row.id);
  }
  return rows.length;
}

export const retryDueCallbacks = dispatchDueCallbacks;

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

export function logSystem(ctx: AppContext, level: LogLevel, action: string, message: string, context?: unknown) {
  ctx.db.query("INSERT INTO system_logs(level, action, message, context, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(level, action, message, context === undefined ? null : JSON.stringify(context), nowIso());
}

export function listAmountOccupations(
  ctx: AppContext,
  options: { paymentAccountId?: number; paymentAccountCode?: string; paymentChannel?: string; limit?: number; offset?: number } = {}
): Page<AmountOccupation> {
  releaseExpiredLocks(ctx);
  const filters = ["o.status = 'pending'"];
  const params: SQLQueryBindings[] = [];

  if (options.paymentAccountId != null) {
    filters.push("o.payment_account_id = ?");
    params.push(options.paymentAccountId);
  }
  if (options.paymentAccountCode) {
    filters.push("pa.code = ?");
    params.push(options.paymentAccountCode);
  }
  if (options.paymentChannel) {
    filters.push("o.payment_channel = ?");
    params.push(normalizePaymentChannel(options.paymentChannel));
  }

  const where = `WHERE ${filters.join(" AND ")}`;
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const offset = Math.max(options.offset ?? 0, 0);
  const rows = ctx.db.query(`
    ${orderSelectSql(where)}
    ORDER BY o.expire_at ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset) as OrderRow[];
  const total = scalar(ctx, `
    SELECT COUNT(*) AS value
    FROM orders o
    JOIN payment_accounts pa ON pa.id = o.payment_account_id
    ${where}
  `, ...params);

  return {
    items: rows.map((row) => ({
      orderId: row.id,
      paymentAccountId: row.payment_account_id,
      paymentAccountCode: row.payment_account_code,
      paymentAccountName: row.payment_account_name,
      paymentChannel: row.payment_channel,
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
      fallbackAccounts: scalar(ctx, "SELECT COUNT(*) AS value FROM payment_accounts WHERE enabled = 1 AND fallback_pay_url IS NOT NULL AND fallback_pay_url != ''")
    },
    callbacks: {
      pending: scalar(ctx, "SELECT COUNT(*) AS value FROM callback_logs WHERE status = 'pending'"),
      failed: scalar(ctx, "SELECT COUNT(*) AS value FROM callback_logs WHERE status = 'failed'")
    }
  };
}
