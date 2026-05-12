import { createHash, timingSafeEqual } from "node:crypto";
import {
  addOrderPaidListener,
  apiError,
  createOrder,
  getOrder,
  logSystem,
  nowIso,
  paymentPagePath,
  type AppContext
} from "./services";
import { formatMoney, parseMoney } from "./money";
import type { Order, PaymentChannel } from "../src/shared/types";

type EasyPayType = "alipay" | "wxpay";
type EasyPayNotifyStatus = "pending" | "success" | "failed";

type RouteRequest<T extends Record<string, string> = Record<string, string>> = Request & {
  params: T;
};

interface EasyPayConfig {
  pid: string;
  key: string;
}

interface EasyPayOrderMeta {
  orderId: string;
  outTradeNo: string;
  notifyUrl: string;
  returnUrl: string | null;
  param: string;
  money: string;
  type: EasyPayType;
  name: string;
  createdAt: string;
}

interface EasyPayOrderMetaRow {
  order_id: string;
  out_trade_no: string;
  notify_url: string;
  return_url: string | null;
  param: string | null;
  money: string;
  pay_type: EasyPayType;
  name: string;
  created_at: string;
}

interface EasyPayNotifyRow {
  id: number;
  order_id: string;
  url: string;
  status: EasyPayNotifyStatus;
  http_status: number | null;
  response_body: string | null;
  error: string | null;
  attempts: number;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

interface EasyPayCreateInput {
  pid: string;
  type: EasyPayType;
  paymentChannel: PaymentChannel;
  outTradeNo: string;
  notifyUrl: string;
  returnUrl: string | null;
  name: string;
  money: string;
  param: string;
}

const EASYPAY_NOTIFY_MAX_ATTEMPTS = 5;

export function signEasyPayParams(params: Record<string, unknown>, key: string) {
  const canonical = Object.keys(params)
    .filter((name) => name !== "sign" && name !== "sign_type")
    .filter((name) => params[name] != null && String(params[name]) !== "")
    .sort()
    .map((name) => `${name}=${params[name]}`)
    .join("&");
  return createHash("md5").update(`${canonical}${key}`).digest("hex");
}

export function registerEasyPayOrderPaidListener(ctx: AppContext) {
  addOrderPaidListener(ctx, queueEasyPayNotification);
}

export function createEasyPayRoutes(ctx: AppContext) {
  registerEasyPayOrderPaidListener(ctx);

  return {
    "/submit.php": {
      GET: (req: Request) => withEasyPayErrors(async () => handleEasyPaySubmit(ctx, req)),
      POST: (req: Request) => withEasyPayErrors(async () => handleEasyPaySubmit(ctx, req))
    },
    "/mapi.php": {
      POST: (req: Request) => withEasyPayErrors(async () => handleEasyPayApiPay(ctx, req))
    },
    "/api.php": {
      GET: (req: Request) => withEasyPayErrors(async () => handleEasyPayApi(ctx, req)),
      POST: (req: Request) => withEasyPayErrors(async () => handleEasyPayApi(ctx, req))
    },
    "/api/easypay/return/:id": {
      GET: (req: RouteRequest<{ id: string }>) => withEasyPayErrors(() => handleEasyPayReturn(ctx, req))
    }
  };
}

async function handleEasyPaySubmit(ctx: AppContext, req: Request) {
  const params = await readEasyPayParams(req);
  const config = easyPayConfig();
  verifySignedRequest(params, config);
  const input = normalizeCreateInput(params, config, true);
  const { order } = createOrReuseEasyPayOrder(ctx, req, input);
  return Response.redirect(publicUrl(req, paymentPagePath(order.id)), 302);
}

async function handleEasyPayApiPay(ctx: AppContext, req: Request) {
  const params = await readEasyPayParams(req);
  const config = easyPayConfig();
  verifySignedRequest(params, config);
  const input = normalizeCreateInput(params, config, false);
  const { order } = createOrReuseEasyPayOrder(ctx, req, input);

  return easyPayJson({
    code: 1,
    msg: "success",
    O_id: order.id,
    trade_no: order.id,
    payurl: publicUrl(req, paymentPagePath(order.id))
  });
}

async function handleEasyPayApi(ctx: AppContext, req: Request) {
  const params = await readEasyPayParams(req);
  const act = (params.act ?? "").trim().toLowerCase();
  if (act !== "order") {
    throw apiError(400, "暂不支持该接口");
  }

  const config = easyPayConfig();
  verifyKeyRequest(params, config);
  const result = findEasyPayOrderForQuery(ctx, params);
  if (!result) {
    throw apiError(404, "订单不存在");
  }

  const { order, meta } = result;
  return easyPayJson({
    code: 1,
    msg: "查询订单号成功！",
    trade_no: order.id,
    out_trade_no: meta.outTradeNo,
    type: meta.type,
    pid: config.pid,
    addtime: formatEasyPayTime(order.createdAt),
    endtime: order.paidAt ? formatEasyPayTime(order.paidAt) : "",
    name: meta.name,
    money: meta.money,
    status: order.status === "paid" || order.status === "notified" ? 1 : 0,
    param: meta.param,
    buyer: ""
  });
}

function handleEasyPayReturn(ctx: AppContext, req: RouteRequest<{ id: string }>) {
  const config = easyPayConfig();
  const order = getOrder(ctx, req.params.id);
  const meta = getEasyPayMetaByOrderId(ctx, req.params.id);
  if (!order || !meta || !meta.returnUrl) {
    throw apiError(404, "订单不存在");
  }
  if (order.status !== "paid" && order.status !== "notified") {
    throw apiError(409, "订单尚未支付");
  }

  return Response.redirect(appendParams(meta.returnUrl, signedNotifyParams(config, order, meta)), 302);
}

function createOrReuseEasyPayOrder(ctx: AppContext, req: Request, input: EasyPayCreateInput) {
  const existingMeta = getEasyPayMetaByOutTradeNo(ctx, input.outTradeNo);
  if (existingMeta) {
    const order = getOrder(ctx, existingMeta.orderId);
    if (!order) {
      throw apiError(500, "EasyPay 订单映射异常");
    }
    if (existingMeta.money !== input.money || existingMeta.type !== input.type || existingMeta.name !== input.name) {
      throw apiError(409, "商户订单号已存在");
    }
    return { order, meta: existingMeta };
  }

  const order = createOrder(ctx, {
    amount: input.money,
    paymentChannel: input.paymentChannel,
    merchantOrderId: input.outTradeNo,
    subject: input.name
  });
  const now = nowIso();
  ctx.db.query(`
    INSERT INTO easypay_order_meta(order_id, out_trade_no, notify_url, return_url, param, money, pay_type, name, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    order.id,
    input.outTradeNo,
    input.notifyUrl,
    input.returnUrl,
    input.param,
    input.money,
    input.type,
    input.name,
    now
  );

  if (input.returnUrl) {
    ctx.db.query("UPDATE orders SET redirect_url = ?, updated_at = ? WHERE id = ?")
      .run(publicUrl(req, `/api/easypay/return/${encodeURIComponent(order.id)}`), now, order.id);
  }

  const updatedOrder = getOrder(ctx, order.id);
  const meta = getEasyPayMetaByOrderId(ctx, order.id);
  if (!updatedOrder || !meta) {
    throw apiError(500, "EasyPay 订单创建失败");
  }
  return { order: updatedOrder, meta };
}

function normalizeCreateInput(params: Record<string, string>, config: EasyPayConfig, requireReturnUrl: boolean): EasyPayCreateInput {
  const pid = required(params, "pid", "商户ID");
  if (pid !== config.pid) {
    throw apiError(401, "商户ID错误");
  }

  const type = normalizeEasyPayType(required(params, "type", "支付方式"));
  const outTradeNo = required(params, "out_trade_no", "商户订单号");
  if (outTradeNo.length > 32) {
    throw apiError(400, "商户订单号最多32位");
  }

  const notifyUrl = normalizeHttpUrl(required(params, "notify_url", "异步通知地址"), "异步通知地址");
  const returnUrlValue = params.return_url?.trim() || "";
  const returnUrl = returnUrlValue ? normalizeHttpUrl(returnUrlValue, "跳转页面") : null;
  if (requireReturnUrl && !returnUrl) {
    throw apiError(400, "跳转页面不能为空");
  }

  const name = required(params, "name", "商品名称");
  const money = normalizeMoney(required(params, "money", "订单金额"));

  return {
    pid,
    type: type.easyPayType,
    paymentChannel: type.paymentChannel,
    outTradeNo,
    notifyUrl,
    returnUrl,
    name,
    money,
    param: params.param?.trim() ?? ""
  };
}

function normalizeEasyPayType(value: string) {
  if (value === "alipay") {
    return { easyPayType: "alipay" as const, paymentChannel: "alipay" as const };
  }
  if (value === "wxpay") {
    return { easyPayType: "wxpay" as const, paymentChannel: "wechat" as const };
  }
  throw apiError(400, "付款方式仅支持 alipay 或 wxpay");
}

function normalizeMoney(value: string) {
  return formatMoney(parseMoney(value)) ?? "0.00";
}

function normalizeHttpUrl(value: string, label: string) {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error("invalid protocol");
    }
    return url.toString();
  } catch {
    throw apiError(400, `${label}必须是有效的 HTTP/HTTPS 地址`);
  }
}

function findEasyPayOrderForQuery(ctx: AppContext, params: Record<string, string>) {
  const outTradeNo = params.out_trade_no?.trim();
  const tradeNo = params.trade_no?.trim();
  const meta = outTradeNo
    ? getEasyPayMetaByOutTradeNo(ctx, outTradeNo)
    : tradeNo
      ? getEasyPayMetaByOrderId(ctx, tradeNo)
      : null;
  if (!meta) {
    return null;
  }

  const order = getOrder(ctx, meta.orderId);
  return order ? { order, meta } : null;
}

function getEasyPayMetaByOutTradeNo(ctx: AppContext, outTradeNo: string) {
  const row = ctx.db.query("SELECT * FROM easypay_order_meta WHERE out_trade_no = ?")
    .get(outTradeNo) as EasyPayOrderMetaRow | null;
  return row ? mapEasyPayMeta(row) : null;
}

function getEasyPayMetaByOrderId(ctx: AppContext, orderId: string) {
  const row = ctx.db.query("SELECT * FROM easypay_order_meta WHERE order_id = ?")
    .get(orderId) as EasyPayOrderMetaRow | null;
  return row ? mapEasyPayMeta(row) : null;
}

function mapEasyPayMeta(row: EasyPayOrderMetaRow): EasyPayOrderMeta {
  return {
    orderId: row.order_id,
    outTradeNo: row.out_trade_no,
    notifyUrl: row.notify_url,
    returnUrl: row.return_url,
    param: row.param ?? "",
    money: row.money,
    type: row.pay_type,
    name: row.name,
    createdAt: row.created_at
  };
}

export function queueEasyPayNotification(ctx: AppContext, order: Order) {
  const meta = getEasyPayMetaByOrderId(ctx, order.id);
  if (!meta) {
    return null;
  }

  const existing = ctx.db.query(`
    SELECT *
    FROM easypay_notify_logs
    WHERE order_id = ? AND (status = 'success' OR attempts < ?)
    ORDER BY created_at ASC
    LIMIT 1
  `).get(order.id, EASYPAY_NOTIFY_MAX_ATTEMPTS) as EasyPayNotifyRow | null;
  if (existing) {
    return existing;
  }

  const now = nowIso();
  ctx.db.query(`
    INSERT INTO easypay_notify_logs(order_id, url, status, attempts, next_retry_at, created_at, updated_at)
    VALUES (?, ?, 'pending', 0, ?, ?, ?)
  `).run(order.id, meta.notifyUrl, now, now, now);
  const id = (ctx.db.query("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  if (ctx.runCallbacks) {
    void dispatchEasyPayNotification(ctx, id);
  }

  return getEasyPayNotifyLog(ctx, id);
}

export function getEasyPayNotifyLog(ctx: AppContext, id: number) {
  return ctx.db.query("SELECT * FROM easypay_notify_logs WHERE id = ?").get(id) as EasyPayNotifyRow | null;
}

export async function dispatchEasyPayNotification(ctx: AppContext, id: number) {
  const row = getEasyPayNotifyLog(ctx, id);
  if (!row) {
    throw apiError(404, "EasyPay 通知记录不存在");
  }
  if (row.attempts >= EASYPAY_NOTIFY_MAX_ATTEMPTS) {
    throw apiError(409, "EasyPay 通知已达到最大重试次数");
  }

  const order = getOrder(ctx, row.order_id);
  const meta = getEasyPayMetaByOrderId(ctx, row.order_id);
  if (!order || !meta) {
    throw apiError(404, "EasyPay 订单不存在");
  }

  const attempts = row.attempts + 1;
  const now = nowIso();
  try {
    const url = appendParams(row.url, signedNotifyParams(easyPayConfig(), order, meta));
    const response = await fetch(url, {
      method: "GET",
      signal: AbortSignal.timeout(10_000)
    });
    const responseBody = (await response.text()).slice(0, 2000);
    const ok = responseBody.includes("success");
    ctx.db.query(`
      UPDATE easypay_notify_logs
      SET status = ?, http_status = ?, response_body = ?, error = NULL, attempts = ?,
          next_retry_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      ok ? "success" : "failed",
      response.status,
      responseBody,
      attempts,
      ok || attempts >= EASYPAY_NOTIFY_MAX_ATTEMPTS ? null : addSeconds(30 * attempts),
      now,
      id
    );

    if (ok) {
      ctx.db.query(`
        UPDATE orders
        SET status = 'notified', notified_at = ?, updated_at = ?
        WHERE id = ? AND status = 'paid'
      `).run(now, now, row.order_id);
      logSystem(ctx, "info", "easypay.notify_success", "EasyPay 支付通知发送成功", { notifyId: id, orderId: row.order_id });
    } else {
      logSystem(ctx, "warn", "easypay.notify_failed", "EasyPay 支付通知响应失败", {
        notifyId: id,
        orderId: row.order_id,
        httpStatus: response.status
      });
    }
  } catch (error) {
    ctx.db.query(`
      UPDATE easypay_notify_logs
      SET status = 'failed', error = ?, attempts = ?, next_retry_at = ?, updated_at = ?
      WHERE id = ?
    `).run(
      error instanceof Error ? error.message : String(error),
      attempts,
      attempts >= EASYPAY_NOTIFY_MAX_ATTEMPTS ? null : addSeconds(30 * attempts),
      now,
      id
    );
    logSystem(ctx, "warn", "easypay.notify_error", "EasyPay 支付通知请求异常", {
      notifyId: id,
      orderId: row.order_id,
      error: error instanceof Error ? error.message : String(error)
    });
  }

  return getEasyPayNotifyLog(ctx, id);
}

export async function dispatchDueEasyPayNotifications(ctx: AppContext) {
  const now = nowIso();
  const rows = ctx.db.query(`
    SELECT *
    FROM easypay_notify_logs
    WHERE status IN ('pending', 'failed')
      AND attempts < ?
      AND (next_retry_at IS NULL OR next_retry_at <= ?)
    ORDER BY created_at ASC
    LIMIT 20
  `).all(EASYPAY_NOTIFY_MAX_ATTEMPTS, now) as EasyPayNotifyRow[];

  for (const row of rows) {
    await dispatchEasyPayNotification(ctx, row.id);
  }
  return rows.length;
}

function signedNotifyParams(config: EasyPayConfig, order: Order, meta: EasyPayOrderMeta) {
  const params = {
    pid: config.pid,
    name: meta.name,
    money: meta.money,
    out_trade_no: meta.outTradeNo,
    trade_no: order.id,
    param: meta.param,
    trade_status: "TRADE_SUCCESS",
    type: meta.type
  };
  return {
    ...params,
    sign: signEasyPayParams(params, config.key),
    sign_type: "MD5"
  };
}

function verifySignedRequest(params: Record<string, string>, config: EasyPayConfig) {
  if ((params.pid ?? "").trim() !== config.pid) {
    throw apiError(401, "商户ID错误");
  }
  const signType = (params.sign_type ?? "").trim();
  if (signType && signType.toUpperCase() !== "MD5") {
    throw apiError(400, "签名类型仅支持MD5");
  }
  const sign = (params.sign ?? "").trim().toLowerCase();
  if (!sign || !safeEqual(sign, signEasyPayParams(params, config.key))) {
    throw apiError(401, "签名验证失败");
  }
}

function verifyKeyRequest(params: Record<string, string>, config: EasyPayConfig) {
  if ((params.pid ?? "").trim() !== config.pid || (params.key ?? "").trim() !== config.key) {
    throw apiError(401, "商户ID或密钥错误");
  }
}

function easyPayConfig(): EasyPayConfig {
  const pid = Bun.env.EASYPAY_PID?.trim();
  const key = Bun.env.EASYPAY_KEY?.trim();
  if (!pid || !key) {
    throw apiError(500, "EasyPay 未配置 EASYPAY_PID/EASYPAY_KEY");
  }
  return { pid, key };
}

async function readEasyPayParams(req: Request) {
  const params: Record<string, string> = {};
  const url = new URL(req.url);
  for (const [key, value] of url.searchParams.entries()) {
    params[key] = value;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const form = await req.formData();
      for (const [key, value] of form.entries()) {
        if (typeof value === "string") {
          params[key] = value;
        }
      }
    } else {
      const body = await req.text();
      for (const [key, value] of new URLSearchParams(body).entries()) {
        params[key] = value;
      }
    }
  }

  return params;
}

async function withEasyPayErrors(handler: () => Response | Promise<Response>) {
  try {
    return await handler();
  } catch (error) {
    return easyPayJson({
      code: "error",
      msg: error instanceof Error ? error.message : "服务器内部错误"
    });
  }
}

function easyPayJson(payload: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cache-control", "no-store");
  headers.set("content-type", "application/json; charset=utf-8");
  return Response.json(payload, { ...init, headers });
}

function required(params: Record<string, string>, key: string, label: string) {
  const value = params[key]?.trim() ?? "";
  if (!value) {
    throw apiError(400, `${label}不能为空`);
  }
  return value;
}

function publicUrl(req: Request, path: string) {
  return new URL(path, req.url).toString();
}

function appendParams(target: string, params: Record<string, string>) {
  const url = new URL(target);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return url.toString();
}

function safeEqual(leftText: string, rightText: string) {
  const left = Buffer.from(leftText);
  const right = Buffer.from(rightText);
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function formatEasyPayTime(value: string) {
  return new Date(value).toISOString().replace("T", " ").slice(0, 19);
}

function addSeconds(seconds: number) {
  return new Date(Date.now() + seconds * 1000).toISOString();
}
