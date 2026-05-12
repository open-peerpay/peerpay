import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  closeAppContext,
  createAppContext,
  createDeviceEnrollment,
  createOrder,
  createPaymentAccount,
  enrollAndroidDevice,
  getOrder,
  getPaymentPageSettings,
  getPublicPaymentPage,
  handleAndroidNotification,
  listAmountOccupations,
  listNotificationLogs,
  listPresetQrCodes,
  paymentPagePath,
  setPaymentAccountEnabled,
  setPresetQrCodeChecked,
  signAndroidRequest,
  signPayload,
  touchDevice,
  unbindDevicePaymentAccount,
  updatePaymentAccountSettings,
  updateOrderStatus,
  updatePaymentPageSettings,
  upsertPresetQrCodes,
  verifyAndroidRequest,
  type AppContext
} from "../server/services";
import type { Device, EnrollDeviceResult, Order, PaymentAccount, PaymentPageData, PresetQrCode } from "../src/shared/types";
import { NOTIFICATION_AMOUNT_MACRO, NOTIFICATION_TEMPLATE_MAX_LENGTH } from "../src/shared/constants";
import { getAdminPath, getAdminSessionState, isSetupRequired, loginAdmin, setupAdminPassword } from "../server/auth";
import { extractMoneyByTemplate, parseMoney } from "../server/money";
import { createApiRoutes } from "../server/routes";
import { dispatchEasyPayNotification, signEasyPayParams } from "../server/easypay";

let ctx: AppContext;
let alipayA: PaymentAccount;
let alipayB: PaymentAccount;
let wechatA: PaymentAccount;

beforeEach(() => {
  Bun.env.EASYPAY_PID = "20220715225121";
  Bun.env.EASYPAY_KEY = "test-easypay-key";
  ctx = createAppContext({ databaseUrl: ":memory:", runCallbacks: false });
  alipayA = createPaymentAccount(ctx, {
    code: "alipay-a",
    name: "支付宝 A",
    paymentChannel: "alipay",
    priority: 10,
    maxOffsetCents: 10,
    fallbackPayUrl: "https://pay.example/alipay-a"
  });
  alipayB = createPaymentAccount(ctx, {
    code: "alipay-b",
    name: "支付宝 B",
    paymentChannel: "alipay",
    priority: 20,
    maxOffsetCents: 10,
    fallbackPayUrl: "https://pay.example/alipay-b"
  });
  wechatA = createPaymentAccount(ctx, {
    code: "wechat-a",
    name: "微信 A",
    paymentChannel: "wechat",
    priority: 10,
    maxOffsetCents: 10,
    fallbackPayUrl: "https://pay.example/wechat-a"
  });
  enrollTestDevice("alipay-a", "android-alipay-a");
  enrollTestDevice("alipay-b", "android-alipay-b");
  enrollTestDevice("wechat-a", "android-wechat-a");
});

afterEach(() => {
  closeAppContext(ctx);
});

function enrollTestDevice(paymentAccountCode = "alipay-a", deviceId = "android-main"): EnrollDeviceResult {
  const enrollment = createDeviceEnrollment(ctx, {
    paymentAccountCode,
    name: "主收款机",
    ttlMinutes: 10
  });

  return enrollAndroidDevice(ctx, {
    enrollmentToken: enrollment.token,
    deviceId,
    appVersion: "0.1.0"
  });
}

function checkPresetQrCode(paymentAccountCode: string, amount: string) {
  const qrCode = listPresetQrCodes(ctx, { paymentAccountCode }).items.find((item) => item.amount === amount);
  if (!qrCode) {
    throw new Error(`preset qr code ${paymentAccountCode} ${amount} not found`);
  }
  return setPresetQrCodeChecked(ctx, qrCode.id, true);
}

function signedEasyPayParams(params: Record<string, string>) {
  const payload = {
    pid: Bun.env.EASYPAY_PID ?? "",
    sign_type: "MD5",
    ...params
  };
  return {
    ...payload,
    sign: signEasyPayParams(payload, Bun.env.EASYPAY_KEY ?? "")
  };
}

function easyPayBody(params: Record<string, string>) {
  return new URLSearchParams(params).toString();
}

test("allows order creation when monitoring devices are offline", () => {
  ctx.db.query("UPDATE devices SET last_seen_at = ?").run(new Date(0).toISOString());

  const order = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.00",
    merchantOrderId: "offline-device",
    ttlMinutes: 10
  });

  expect(order.paymentAccountCode).toBe("alipay-a");
});

test("requires callback secret when callback url is provided", () => {
  expect(() => createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.00",
    merchantOrderId: "callback-without-secret",
    callbackUrl: "https://merchant.example/webhook",
    ttlMinutes: 10
  })).toThrow("callbackSecret");
});

test("stores redirect url on orders and public payment page data", () => {
  const order = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.00",
    merchantOrderId: "redirect-url",
    redirectUrl: "https://merchant.example/orders/redirect-url?paid=1",
    ttlMinutes: 10
  });

  expect(order.redirectUrl).toBe("https://merchant.example/orders/redirect-url?paid=1");
  expect(getPublicPaymentPage(ctx, order.id).redirectUrl).toBe(order.redirectUrl);
  expect(() => createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.01",
    merchantOrderId: "invalid-redirect-url",
    redirectUrl: "javascript:alert(1)"
  })).toThrow("重定向地址");

  const snakeCaseOrder = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.02",
    merchantOrderId: "legacy-redirect-url",
    redirect_url: "https://merchant.example/orders/legacy-redirect-url"
  });
  const returnUrlOrder = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.03",
    merchantOrderId: "legacy-return-url",
    returnUrl: "https://merchant.example/orders/legacy-return-url"
  });
  const snakeCaseReturnUrlOrder = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.04",
    merchantOrderId: "legacy-return-url-snake",
    return_url: "https://merchant.example/orders/legacy-return-url-snake"
  });

  expect(snakeCaseOrder.redirectUrl).toBe("https://merchant.example/orders/legacy-redirect-url");
  expect(returnUrlOrder.redirectUrl).toBe("https://merchant.example/orders/legacy-return-url");
  expect(snakeCaseReturnUrlOrder.redirectUrl).toBe("https://merchant.example/orders/legacy-return-url-snake");
});

test("allocates same amount across payment accounts before offsetting", () => {
  const first = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.00",
    merchantOrderId: "m-10001",
    ttlMinutes: 10
  });
  const second = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.00",
    merchantOrderId: "m-10002",
    ttlMinutes: 10
  });
  const third = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.00",
    merchantOrderId: "m-10003",
    ttlMinutes: 10
  });

  expect(first.paymentAccountCode).toBe("alipay-a");
  expect(first.actualAmount).toBe("10.00");
  expect(second.paymentAccountCode).toBe("alipay-b");
  expect(second.actualAmount).toBe("10.00");
  expect(third.paymentAccountCode).toBe("alipay-a");
  expect(third.actualAmount).toBe("10.01");
  expect(listAmountOccupations(ctx).items).toHaveLength(3);
});

test("uses per-account preset qr codes and isolates payment channels", () => {
  upsertPresetQrCodes(ctx, {
    paymentAccountCode: "alipay-a",
    items: [{ amount: "12.00", payUrl: "https://pay.example/alipay-a/12.00" }]
  });
  checkPresetQrCode("alipay-a", "12.00");
  upsertPresetQrCodes(ctx, {
    paymentAccountCode: "wechat-a",
    items: [{ amount: "12.00", payUrl: "https://pay.example/wechat-a/12.00" }]
  });
  checkPresetQrCode("wechat-a", "12.00");

  const alipay = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "12.00",
    merchantOrderId: "m-alipay",
    ttlMinutes: 10
  });
  const wechat = createOrder(ctx, {
    paymentChannel: "wechat",
    amount: "12.00",
    merchantOrderId: "m-wechat",
    ttlMinutes: 10
  });

  expect(alipay.paymentAccountCode).toBe("alipay-a");
  expect(alipay.payMode).toBe("preset");
  expect(alipay.payUrl).toBe(paymentPagePath(alipay.id));
  expect(getPublicPaymentPage(ctx, alipay.id).targetPayUrl).toBe("https://pay.example/alipay-a/12.00");
  expect(wechat.paymentAccountCode).toBe("wechat-a");
  expect(wechat.payMode).toBe("preset");
  expect(wechat.payUrl).toBe(paymentPagePath(wechat.id));
  expect(getPublicPaymentPage(ctx, wechat.id).targetPayUrl).toBe("https://pay.example/wechat-a/12.00");
});

test("does not use unchecked preset qr codes when allocating orders", () => {
  updatePaymentAccountSettings(ctx, alipayA.id, { fallbackPayUrl: null });
  updatePaymentAccountSettings(ctx, alipayB.id, { fallbackPayUrl: null });
  upsertPresetQrCodes(ctx, {
    paymentAccountCode: "alipay-a",
    items: [{ amount: "12.25", payUrl: "https://pay.example/alipay-a/12.25" }]
  });

  expect(() => createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "12.25",
    merchantOrderId: "unchecked-preset",
    ttlMinutes: 10
  })).toThrow("已无可用收款账号");

  checkPresetQrCode("alipay-a", "12.25");
  const order = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "12.25",
    merchantOrderId: "checked-preset",
    ttlMinutes: 10
  });

  expect(order.payMode).toBe("preset");
  expect(getPublicPaymentPage(ctx, order.id).targetPayUrl).toBe("https://pay.example/alipay-a/12.25");
});

test("tracks preset qr code checked state and resets it when url changes", () => {
  upsertPresetQrCodes(ctx, {
    paymentAccountCode: "alipay-a",
    items: [{ amount: "12.50", payUrl: "https://pay.example/alipay-a/12.50" }]
  });
  const created = listPresetQrCodes(ctx, { paymentAccountCode: "alipay-a" }).items.find((item) => item.amount === "12.50");

  expect(created?.checked).toBe(false);
  const checked = setPresetQrCodeChecked(ctx, created?.id ?? 0, true);
  expect(checked.checked).toBe(true);

  upsertPresetQrCodes(ctx, {
    paymentAccountCode: "alipay-a",
    items: [{ amount: "12.50", payUrl: "https://pay.example/alipay-a/12.50" }]
  });
  expect(listPresetQrCodes(ctx, { paymentAccountCode: "alipay-a" }).items.find((item) => item.id === checked.id)?.checked).toBe(true);

  upsertPresetQrCodes(ctx, {
    paymentAccountCode: "alipay-a",
    items: [{ amount: "12.50", payUrl: "https://pay.example/alipay-a/12.50-updated" }]
  });
  expect(listPresetQrCodes(ctx, { paymentAccountCode: "alipay-a" }).items.find((item) => item.id === checked.id)?.checked).toBe(false);
});

test("does not offset cent-level amounts but can use another account", () => {
  const first = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.01",
    merchantOrderId: "m-cent-1",
    ttlMinutes: 10
  });
  const second = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.01",
    merchantOrderId: "m-cent-2",
    ttlMinutes: 10
  });

  expect(first.paymentAccountCode).toBe("alipay-a");
  expect(first.actualAmount).toBe("10.01");
  expect(second.paymentAccountCode).toBe("alipay-b");
  expect(second.actualAmount).toBe("10.01");
  expect(() => createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "10.01",
    merchantOrderId: "m-cent-3",
    ttlMinutes: 10
  })).toThrow("最大偏移 0.00");
});

test("skips payment accounts without preset qr code or fallback url", () => {
  updatePaymentAccountSettings(ctx, alipayA.id, { fallbackPayUrl: null });

  const order = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "13.00",
    merchantOrderId: "skip-empty-account",
    ttlMinutes: 10
  });

  expect(order.paymentAccountCode).toBe("alipay-b");
  expect(order.payUrl).toBe(paymentPagePath(order.id));
  expect(getPublicPaymentPage(ctx, order.id).targetPayUrl).toBe("https://pay.example/alipay-b");
});

test("defaults payment account max offset to 10 cents", () => {
  const account = createPaymentAccount(ctx, {
    code: "wechat-b",
    name: "微信 B",
    paymentChannel: "wechat"
  });

  expect(account.maxOffsetCents).toBe(10);
  expect(account.maxOffset).toBe("0.10");
  expect(account.priority).toBe(100);
});

test("accepts wxp pay urls for wechat fallback and preset qr codes", () => {
  const account = createPaymentAccount(ctx, {
    code: "wechat-wxp",
    name: "微信 WXP",
    paymentChannel: "wechat",
    priority: 5,
    maxOffsetCents: 10,
    fallbackPayUrl: "wxp://fallback-wechat"
  });

  expect(account.fallbackPayUrl).toBe("wxp://fallback-wechat");
  enrollTestDevice("wechat-wxp", "android-wechat-wxp");

  const fallbackOrder = createOrder(ctx, {
    paymentChannel: "wechat",
    amount: "14.00",
    merchantOrderId: "wxp-fallback",
    ttlMinutes: 10
  });

  expect(fallbackOrder.paymentAccountCode).toBe("wechat-wxp");
  expect(fallbackOrder.payUrl).toBe(paymentPagePath(fallbackOrder.id));
  expect(getPublicPaymentPage(ctx, fallbackOrder.id).targetPayUrl).toBe("wxp://fallback-wechat");

  upsertPresetQrCodes(ctx, {
    paymentAccountCode: "wechat-wxp",
    items: [{ amount: "15.00", payUrl: "wxp://preset-wechat-1500" }]
  });
  checkPresetQrCode("wechat-wxp", "15.00");

  const presetOrder = createOrder(ctx, {
    paymentChannel: "wechat",
    amount: "15.00",
    merchantOrderId: "wxp-preset",
    ttlMinutes: 10
  });

  expect(presetOrder.paymentAccountCode).toBe("wechat-wxp");
  expect(presetOrder.payUrl).toBe(paymentPagePath(presetOrder.id));
  expect(getPublicPaymentPage(ctx, presetOrder.id).targetPayUrl).toBe("wxp://preset-wechat-1500");

  const updatedAccount = updatePaymentAccountSettings(ctx, account.id, {
    fallbackPayUrl: "wxp://fallback-wechat-updated"
  });

  expect(updatedAccount?.fallbackPayUrl).toBe("wxp://fallback-wechat-updated");
});

test("exposes payment page data and configurable notice content", () => {
  expect(getPaymentPageSettings(ctx).noticeEnabled).toBe(false);

  updatePaymentPageSettings(ctx, {
    noticeEnabled: true,
    noticeTitle: "到账公告",
    noticeBody: "夜间到账可能延迟，请以订单状态为准。",
    noticeLinkText: "联系客服",
    noticeLinkUrl: "https://merchant.example/support"
  });

  const order = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "16.00",
    merchantOrderId: "payment-page-settings",
    subject: "测试订单",
    ttlMinutes: 10
  });
  const page = getPublicPaymentPage(ctx, order.id);

  expect(page.orderId).toBe(order.id);
  expect(page.targetPayUrl).toBe("https://pay.example/alipay-a");
  expect(page.payMode).toBe("fallback");
  expect(page.amountInputRequired).toBe(true);
  expect(page.notice).toEqual({
    title: "到账公告",
    body: "夜间到账可能延迟，请以订单状态为准。",
    linkText: "联系客服",
    linkUrl: "https://merchant.example/support"
  });

  updateOrderStatus(ctx, order.id, "paid");
  expect(getPublicPaymentPage(ctx, order.id).status).toBe("paid");
});

test("order api returns an absolute payment page url", async () => {
  const routes = createApiRoutes(ctx);
  const response = await routes["/api/orders"].POST(new Request("https://peerpay.test/api/orders", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      paymentChannel: "alipay",
      amount: "17.00",
      merchantOrderId: "api-pay-page",
      redirectUrl: "https://merchant.example/orders/api-pay-page"
    })
  }));
  const payload = await response.json() as { data: Order };

  expect(payload.data.payUrl).toBe(`https://peerpay.test${paymentPagePath(payload.data.id)}`);
  expect(payload.data.redirectUrl).toBe("https://merchant.example/orders/api-pay-page");

  const publicResponse = await routes["/api/pay/:id"].GET(Object.assign(
    new Request(`https://peerpay.test/api/pay/${payload.data.id}`),
    { params: { id: payload.data.id } }
  ));
  const publicPayload = await publicResponse.json() as { data: PaymentPageData };

  expect(publicPayload.data.orderId).toBe(payload.data.id);
  expect(publicPayload.data.targetPayUrl).toBe("https://pay.example/alipay-a");
  expect(publicPayload.data.redirectUrl).toBe("https://merchant.example/orders/api-pay-page");
});

test("generates EasyPay MD5 signatures from canonical non-empty params", () => {
  const params = {
    pid: "20220715225121",
    name: "iPhone17苹果手机",
    money: "5.67",
    type: "alipay",
    out_trade_no: "epay-signature",
    notify_url: "https://merchant.example/notify",
    return_url: "https://merchant.example/return",
    empty: "",
    sign: "ignored",
    sign_type: "MD5"
  };

  expect(signEasyPayParams(params, "merchant-key")).toBe(signEasyPayParams({
    sign_type: "RSA",
    return_url: "https://merchant.example/return",
    notify_url: "https://merchant.example/notify",
    out_trade_no: "epay-signature",
    type: "alipay",
    money: "5.67",
    name: "iPhone17苹果手机",
    pid: "20220715225121",
    sign: "different",
    empty: ""
  }, "merchant-key"));
});

test("EasyPay mapi creates and reuses PeerPay orders without using native JSON callbacks", async () => {
  const routes = createApiRoutes(ctx);
  const params = signedEasyPayParams({
    type: "wxpay",
    out_trade_no: "epay-mapi-10001",
    notify_url: "https://merchant.example/notify",
    name: "会员月卡",
    money: "18"
  });
  const request = new Request("https://peerpay.test/mapi.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: easyPayBody(params)
  });

  const response = await routes["/mapi.php"].POST(request);
  const payload = await response.json() as { code: number; trade_no: string; O_id: string; payurl: string };
  const order = getOrder(ctx, payload.trade_no);

  expect(payload.code).toBe(1);
  expect(payload.O_id).toBe(payload.trade_no);
  expect(payload.payurl).toBe(`https://peerpay.test${paymentPagePath(payload.trade_no)}`);
  expect(order?.merchantOrderId).toBe("epay-mapi-10001");
  expect(order?.paymentChannel).toBe("wechat");
  expect(order?.requestedAmount).toBe("18.00");
  expect(order?.callbackUrl).toBeNull();

  const reusedResponse = await routes["/mapi.php"].POST(new Request("https://peerpay.test/mapi.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: easyPayBody(params)
  }));
  const reusedPayload = await reusedResponse.json() as { code: number; trade_no: string };
  expect(reusedPayload.trade_no).toBe(payload.trade_no);

  const conflictResponse = await routes["/mapi.php"].POST(new Request("https://peerpay.test/mapi.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: easyPayBody(signedEasyPayParams({
      type: "wxpay",
      out_trade_no: "epay-mapi-10001",
      notify_url: "https://merchant.example/notify",
      name: "会员月卡",
      money: "18.01"
    }))
  }));
  const conflictPayload = await conflictResponse.json() as { code: string; msg: string };
  expect(conflictPayload.code).toBe("error");
  expect(conflictPayload.msg).toContain("商户订单号");
});

test("EasyPay submit redirects to PeerPay cashier and return bridge signs merchant redirect", async () => {
  const routes = createApiRoutes(ctx);
  const params = signedEasyPayParams({
    type: "alipay",
    out_trade_no: "epay-submit-10001",
    notify_url: "https://merchant.example/notify",
    return_url: "https://merchant.example/return",
    name: "单次服务",
    money: "19.00",
    param: "gold"
  });
  const response = await routes["/submit.php"].GET(new Request(`https://peerpay.test/submit.php?${easyPayBody(params)}`));
  const location = response.headers.get("location");
  if (!location) {
    throw new Error("missing redirect location");
  }
  const orderId = location.split("/pay/")[1];
  const order = getOrder(ctx, orderId);

  expect(response.status).toBe(302);
  expect(location).toBe(`https://peerpay.test${paymentPagePath(orderId)}`);
  expect(order?.redirectUrl).toBe(`https://peerpay.test/api/easypay/return/${orderId}`);

  updateOrderStatus(ctx, orderId, "paid");
  const returnResponse = await routes["/api/easypay/return/:id"].GET(Object.assign(
    new Request(order?.redirectUrl ?? ""),
    { params: { id: orderId } }
  ));
  const merchantLocation = returnResponse.headers.get("location");
  if (!merchantLocation) {
    throw new Error("missing merchant redirect location");
  }
  const merchantUrl = new URL(merchantLocation);
  const returnParams = Object.fromEntries(merchantUrl.searchParams.entries());

  expect(merchantUrl.origin + merchantUrl.pathname).toBe("https://merchant.example/return");
  expect(returnParams.trade_status).toBe("TRADE_SUCCESS");
  expect(returnParams.out_trade_no).toBe("epay-submit-10001");
  expect(returnParams.param).toBe("gold");
  expect(returnParams.sign).toBe(signEasyPayParams(returnParams, Bun.env.EASYPAY_KEY ?? ""));
});

test("EasyPay order query supports out_trade_no and maps paid status", async () => {
  const routes = createApiRoutes(ctx);
  const params = signedEasyPayParams({
    type: "alipay",
    out_trade_no: "epay-query-10001",
    notify_url: "https://merchant.example/notify",
    name: "查询订单",
    money: "20.00"
  });
  const createResponse = await routes["/mapi.php"].POST(new Request("https://peerpay.test/mapi.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: easyPayBody(params)
  }));
  const createPayload = await createResponse.json() as { trade_no: string };
  const pendingResponse = await routes["/api.php"].GET(new Request(`https://peerpay.test/api.php?${easyPayBody({
    act: "order",
    pid: Bun.env.EASYPAY_PID ?? "",
    key: Bun.env.EASYPAY_KEY ?? "",
    out_trade_no: "epay-query-10001"
  })}`));
  const pendingPayload = await pendingResponse.json() as { code: number; trade_no: string; status: number; money: string };

  expect(pendingPayload.code).toBe(1);
  expect(pendingPayload.trade_no).toBe(createPayload.trade_no);
  expect(pendingPayload.status).toBe(0);
  expect(pendingPayload.money).toBe("20.00");

  updateOrderStatus(ctx, createPayload.trade_no, "paid");
  const paidResponse = await routes["/api.php"].GET(new Request(`https://peerpay.test/api.php?${easyPayBody({
    act: "order",
    pid: Bun.env.EASYPAY_PID ?? "",
    key: Bun.env.EASYPAY_KEY ?? "",
    trade_no: createPayload.trade_no
  })}`));
  const paidPayload = await paidResponse.json() as { status: number; out_trade_no: string };

  expect(paidPayload.status).toBe(1);
  expect(paidPayload.out_trade_no).toBe("epay-query-10001");
});

test("EasyPay paid notifications use GET success semantics and do not create PeerPay callback logs", async () => {
  const routes = createApiRoutes(ctx);
  const params = signedEasyPayParams({
    type: "alipay",
    out_trade_no: "epay-notify-10001",
    notify_url: "https://merchant.example/notify",
    name: "通知订单",
    money: "21.00",
    param: "custom"
  });
  const createResponse = await routes["/mapi.php"].POST(new Request("https://peerpay.test/mapi.php", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: easyPayBody(params)
  }));
  const createPayload = await createResponse.json() as { trade_no: string };
  updateOrderStatus(ctx, createPayload.trade_no, "paid");

  const peerPayCallbackCount = (ctx.db.query("SELECT COUNT(*) AS value FROM callback_logs").get() as { value: number }).value;
  const notifyLog = ctx.db.query("SELECT id FROM easypay_notify_logs WHERE order_id = ?").get(createPayload.trade_no) as { id: number } | null;
  if (!notifyLog) {
    throw new Error("missing EasyPay notify log");
  }

  const originalFetch = globalThis.fetch;
  let requestedUrl = "";
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    requestedUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return new Response("success");
  }) as typeof fetch;

  try {
    await dispatchEasyPayNotification(ctx, notifyLog.id);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const url = new URL(requestedUrl);
  const notifyParams = Object.fromEntries(url.searchParams.entries());
  const updatedOrder = getOrder(ctx, createPayload.trade_no);
  const updatedNotifyLog = ctx.db.query("SELECT status FROM easypay_notify_logs WHERE id = ?").get(notifyLog.id) as { status: string };

  expect(peerPayCallbackCount).toBe(0);
  expect(url.origin + url.pathname).toBe("https://merchant.example/notify");
  expect(notifyParams.trade_status).toBe("TRADE_SUCCESS");
  expect(notifyParams.out_trade_no).toBe("epay-notify-10001");
  expect(notifyParams.param).toBe("custom");
  expect(notifyParams.sign).toBe(signEasyPayParams(notifyParams, Bun.env.EASYPAY_KEY ?? ""));
  expect(updatedOrder?.status).toBe("notified");
  expect(updatedNotifyLog.status).toBe("success");
});

test("preset qr code checked api toggles the flag", async () => {
  upsertPresetQrCodes(ctx, {
    paymentAccountCode: "alipay-a",
    items: [{ amount: "17.50", payUrl: "https://pay.example/alipay-a/17.50" }]
  });
  const qrCode = listPresetQrCodes(ctx, { paymentAccountCode: "alipay-a" }).items.find((item) => item.amount === "17.50");
  if (!qrCode) {
    throw new Error("test qr code not found");
  }

  const routes = createApiRoutes(ctx);
  await setupAdminPassword(ctx, "strong-password");
  const cookie = await loginAdmin(ctx, "strong-password");
  const checkedResponse = await routes["/api/preset-qrcodes/:id/checked"].POST(Object.assign(
    new Request(`https://peerpay.test/api/preset-qrcodes/${qrCode.id}/checked`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cookie": cookie
      },
      body: JSON.stringify({ checked: true })
    }),
    { params: { id: String(qrCode.id) } }
  ));
  const checkedPayload = await checkedResponse.json() as { data: PresetQrCode };

  expect(checkedPayload.data.checked).toBe(true);

  const uncheckedResponse = await routes["/api/preset-qrcodes/:id/checked"].POST(Object.assign(
    new Request(`https://peerpay.test/api/preset-qrcodes/${qrCode.id}/checked`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cookie": cookie
      },
      body: JSON.stringify({ checked: false })
    }),
    { params: { id: String(qrCode.id) } }
  ));
  const uncheckedPayload = await uncheckedResponse.json() as { data: PresetQrCode };

  expect(uncheckedPayload.data.checked).toBe(false);
});

test("device enrollment api returns a pairing path", async () => {
  const routes = createApiRoutes(ctx);
  await setupAdminPassword(ctx, "strong-password");
  const cookie = await loginAdmin(ctx, "strong-password");
  const response = await routes["/api/device-enrollments"].POST(new Request("http://pay.auair.cn/api/device-enrollments", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cookie": cookie
    },
    body: JSON.stringify({
      paymentAccountCode: "alipay-a",
      name: "主收款机",
      ttlMinutes: 10
    })
  }));
  const payload = await response.json() as { data: { pairingUrl: string } };

  expect(payload.data.pairingUrl).toStartWith("/api/android/enroll?token=");
});

test("device account unbind api removes a binding", async () => {
  const firstEnroll = enrollTestDevice("alipay-a", "android-api-unbind");
  const enrollment = createDeviceEnrollment(ctx, {
    paymentAccountCode: "wechat-a",
    name: "主收款机",
    ttlMinutes: 10
  });
  const secondEnroll = enrollAndroidDevice(ctx, {
    enrollmentToken: enrollment.token,
    deviceId: "android-api-unbind",
    appVersion: "0.1.0"
  });
  expect(firstEnroll.device.deviceId).toBe(secondEnroll.device.deviceId);

  const routes = createApiRoutes(ctx);
  await setupAdminPassword(ctx, "strong-password");
  const cookie = await loginAdmin(ctx, "strong-password");
  const response = await routes["/api/devices/:id/payment-accounts/:paymentAccountId"].DELETE(Object.assign(
    new Request(`http://peerpay.test/api/devices/${secondEnroll.device.id}/payment-accounts/${alipayA.id}`, {
      method: "DELETE",
      headers: { cookie }
    }),
    { params: { id: String(secondEnroll.device.id), paymentAccountId: String(alipayA.id) } }
  ));
  const payload = await response.json() as { data: Device };

  expect(response.status).toBe(200);
  expect(payload.data.paymentAccounts.map((item) => item.code)).toEqual(["wechat-a"]);
});

test("parses money into integer cents without floating point multiplication", () => {
  expect(parseMoney("10.01")).toBe(1001);
  expect(parseMoney(10.01)).toBe(1001);
  expect(parseMoney(0.3)).toBe(30);
  expect(() => parseMoney(1.005)).toThrow("最多两位小数");
});

test("extracts notification amount strictly from the configured template macro", () => {
  const rawText = "已转入余额 收钱1笔得3元红包，去看看>> 你已成功收款0.01元（老顾客消费） 已转入余额 收钱1笔得3元红包，去看看>>";

  expect(extractMoneyByTemplate(rawText, `成功收款${NOTIFICATION_AMOUNT_MACRO}元`)).toBe(1);
  expect(extractMoneyByTemplate(rawText, `收款${NOTIFICATION_AMOUNT_MACRO}元，去看看`)).toBeNull();
});

test("does not parse raw notification amount without a configured template", () => {
  const { device } = enrollTestDevice();
  createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "0.01",
    merchantOrderId: "raw-without-template"
  });

  const result = handleAndroidNotification(ctx, {
    packageName: "com.eg.android.AlipayGphone",
    rawText: "支付宝到账 0.01 元"
  }, device);

  expect(result.matched).toBe(false);
  expect(result.log.status).toBe("parse_failed");
});

test("matches android notifications using the configured collection template", () => {
  const { device } = enrollTestDevice();
  updatePaymentAccountSettings(ctx, alipayA.id, {
    notificationKeywords: [`成功收款${NOTIFICATION_AMOUNT_MACRO}元`]
  });
  const order = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "0.01",
    merchantOrderId: "collection-before-red-packet"
  });

  const result = handleAndroidNotification(ctx, {
    packageName: "com.eg.android.AlipayGphone",
    rawText: "已转入余额 收钱1笔得3元红包，去看看>> 你已成功收款0.01元（老顾客消费） 已转入余额 收钱1笔得3元红包，去看看>>"
  }, device);

  expect(result.matched).toBe(true);
  expect(result.order?.id).toBe(order.id);
  expect(result.log.actualAmount).toBe("0.01");
});

test("matches android payment notifications by package name across bound accounts", () => {
  const firstEnroll = enrollTestDevice("alipay-a", "android-multi");
  const secondEnrollment = createDeviceEnrollment(ctx, {
    paymentAccountCode: "wechat-a",
    name: "主收款机",
    ttlMinutes: 10
  });
  const secondEnroll = enrollAndroidDevice(ctx, {
    enrollmentToken: secondEnrollment.token,
    deviceId: "android-multi",
    appVersion: "0.1.0"
  });
  const verifiedDevice = secondEnroll.device;
  expect(firstEnroll.device.deviceId).toBe(verifiedDevice.deviceId);
  expect(verifiedDevice.paymentAccounts.map((item) => item.code).sort()).toEqual(["alipay-a", "wechat-a"]);

  const alipayOrder = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "20.00",
    merchantOrderId: "pkg-alipay"
  });
  const wechatOrder = createOrder(ctx, {
    paymentChannel: "wechat",
    amount: "20.00",
    merchantOrderId: "pkg-wechat"
  });

  const wechatResult = handleAndroidNotification(ctx, {
    packageName: "com.tencent.mm",
    actualAmount: "20.00",
    rawText: "微信收款到账 20.00 元"
  }, verifiedDevice);
  const alipayResult = handleAndroidNotification(ctx, {
    packageName: "com.eg.android.AlipayGphone",
    actualAmount: "20.00",
    rawText: "支付宝到账 20.00 元"
  }, verifiedDevice);

  expect(wechatResult.matched).toBe(true);
  expect(wechatResult.order?.id).toBe(wechatOrder.id);
  expect(wechatResult.log.paymentAccountCode).toBe("wechat-a");
  expect(wechatResult.log.paymentChannel).toBe("wechat");
  expect(alipayResult.matched).toBe(true);
  expect(alipayResult.order?.id).toBe(alipayOrder.id);
  expect(alipayResult.log.paymentAccountCode).toBe("alipay-a");
  expect(alipayResult.log.paymentChannel).toBe("alipay");
  expect(listAmountOccupations(ctx).items).toHaveLength(0);
});

test("unbinds a payment account from an android device", () => {
  const firstEnroll = enrollTestDevice("alipay-a", "android-unbind");
  const secondEnrollment = createDeviceEnrollment(ctx, {
    paymentAccountCode: "wechat-a",
    name: "主收款机",
    ttlMinutes: 10
  });
  const secondEnroll = enrollAndroidDevice(ctx, {
    enrollmentToken: secondEnrollment.token,
    deviceId: "android-unbind",
    appVersion: "0.1.0"
  });

  expect(firstEnroll.device.deviceId).toBe(secondEnroll.device.deviceId);
  expect(secondEnroll.device.paymentAccounts.map((item) => item.code).sort()).toEqual(["alipay-a", "wechat-a"]);

  const updated = unbindDevicePaymentAccount(ctx, secondEnroll.device.id, alipayA.id);
  expect(updated.paymentAccounts.map((item) => item.code)).toEqual(["wechat-a"]);

  const heartbeat = touchDevice(ctx, { appVersion: "0.1.0" }, updated);
  expect(heartbeat.paymentAccounts.map((item) => item.code)).toEqual(["wechat-a"]);

  createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "31.00",
    merchantOrderId: "unbound-after-admin"
  });
  const retainedOrder = createOrder(ctx, {
    paymentChannel: "wechat",
    amount: "32.00",
    merchantOrderId: "retained-after-admin"
  });

  const unboundResult = handleAndroidNotification(ctx, {
    packageName: "com.eg.android.AlipayGphone",
    actualAmount: "31.00",
    rawText: "支付宝到账 31.00 元"
  }, updated);
  expect(unboundResult.matched).toBe(false);
  expect(unboundResult.log.status).toBe("unmatched");

  const retainedResult = handleAndroidNotification(ctx, {
    packageName: "com.tencent.mm",
    actualAmount: "32.00",
    rawText: "微信收款到账 32.00 元"
  }, updated);
  expect(retainedResult.matched).toBe(true);
  expect(retainedResult.order?.id).toBe(retainedOrder.id);
  expect(retainedResult.log.paymentAccountCode).toBe("wechat-a");
});

test("rejects missing android device account unbind targets", () => {
  const { device } = enrollTestDevice("alipay-a", "android-unbind-missing");

  expect(() => unbindDevicePaymentAccount(ctx, 999_999, alipayA.id)).toThrow("设备不存在");
  expect(() => unbindDevicePaymentAccount(ctx, device.id, wechatA.id)).toThrow("设备账号绑定不存在");
});

test("filters android payment notifications with per-account templates", () => {
  const updatedAlipayA = updatePaymentAccountSettings(ctx, alipayA.id, {
    notificationKeywords: [`支付宝 A 到账 ${NOTIFICATION_AMOUNT_MACRO} 元`]
  });
  const updatedAlipayB = updatePaymentAccountSettings(ctx, alipayB.id, {
    notificationKeywords: [`支付宝 B 到账 ${NOTIFICATION_AMOUNT_MACRO} 元`]
  });
  expect(updatedAlipayA?.notificationKeywords).toEqual([`支付宝 A 到账 ${NOTIFICATION_AMOUNT_MACRO} 元`]);
  expect(updatedAlipayB?.notificationKeywords).toEqual([`支付宝 B 到账 ${NOTIFICATION_AMOUNT_MACRO} 元`]);

  const firstEnroll = enrollTestDevice("alipay-a", "android-filter");
  const secondEnrollment = createDeviceEnrollment(ctx, {
    paymentAccountCode: "alipay-b",
    name: "主收款机",
    ttlMinutes: 10
  });
  const secondEnroll = enrollAndroidDevice(ctx, {
    enrollmentToken: secondEnrollment.token,
    deviceId: "android-filter",
    appVersion: "0.1.0"
  });
  const verifiedDevice = secondEnroll.device;
  expect(firstEnroll.device.deviceId).toBe(verifiedDevice.deviceId);
  expect(verifiedDevice.paymentAccounts.map((item) => item.code).sort()).toEqual(["alipay-a", "alipay-b"]);

  const firstOrder = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "22.00",
    merchantOrderId: "filter-alipay-a"
  });
  const secondOrder = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "22.00",
    merchantOrderId: "filter-alipay-b"
  });

  expect(firstOrder.paymentAccountCode).toBe("alipay-a");
  expect(secondOrder.paymentAccountCode).toBe("alipay-b");
  const matchedSecond = handleAndroidNotification(ctx, {
    packageName: "com.eg.android.AlipayGphone",
    actualAmount: "22.00",
    rawText: "支付宝 B 到账 22.00 元"
  }, verifiedDevice);

  expect(matchedSecond.matched).toBe(true);
  expect(matchedSecond.order?.id).toBe(secondOrder.id);
  expect(matchedSecond.log.paymentAccountCode).toBe("alipay-b");

  const blocked = handleAndroidNotification(ctx, {
    packageName: "com.eg.android.AlipayGphone",
    actualAmount: "22.00",
    rawText: "支付宝到账 22.00 元"
  }, verifiedDevice);

  expect(blocked.matched).toBe(false);
  expect(blocked.log.status).toBe("unmatched");
  expect(listAmountOccupations(ctx).items.some((item) => item.orderId === firstOrder.id)).toBe(true);

  const matchedFirst = handleAndroidNotification(ctx, {
    packageName: "com.eg.android.AlipayGphone",
    actualAmount: "22.00",
    rawText: "支付宝 A 到账 22.00 元"
  }, verifiedDevice);

  expect(matchedFirst.matched).toBe(true);
  expect(matchedFirst.order?.id).toBe(firstOrder.id);
});

test("allows longer payment notification templates", () => {
  const prefix = "到账通知模板".repeat(Math.ceil(NOTIFICATION_TEMPLATE_MAX_LENGTH / 6))
    .slice(0, NOTIFICATION_TEMPLATE_MAX_LENGTH - NOTIFICATION_AMOUNT_MACRO.length);
  const template = `${prefix}${NOTIFICATION_AMOUNT_MACRO}`;

  const updated = updatePaymentAccountSettings(ctx, alipayA.id, {
    notificationKeywords: [template]
  });

  expect(updated?.notificationKeywords).toEqual([template]);
  expect(() => updatePaymentAccountSettings(ctx, alipayA.id, {
    notificationKeywords: [`${template}超`]
  })).toThrow(`到账通知模板不能超过 ${NOTIFICATION_TEMPLATE_MAX_LENGTH} 个字符`);
  expect(() => updatePaymentAccountSettings(ctx, alipayA.id, {
    notificationKeywords: ["支付宝到账"]
  })).toThrow(`到账通知模板必须且只能包含一个 ${NOTIFICATION_AMOUNT_MACRO}`);
});

test("routes same-amount wechat notifications to different accounts by templates", () => {
  const wechatB = createPaymentAccount(ctx, {
    code: "wechat-b",
    name: "微信 B",
    paymentChannel: "wechat",
    priority: 20,
    maxOffsetCents: 10,
    fallbackPayUrl: "https://pay.example/wechat-b",
    notificationKeywords: [`微信支付: 个人收款码到账¥${NOTIFICATION_AMOUNT_MACRO}`]
  });
  updatePaymentAccountSettings(ctx, wechatA.id, {
    notificationKeywords: [`微信收款助手: [店员消息]收款到账${NOTIFICATION_AMOUNT_MACRO}元`]
  });

  const firstEnroll = enrollTestDevice("wechat-a", "android-wechat-keywords");
  const secondEnrollment = createDeviceEnrollment(ctx, {
    paymentAccountCode: "wechat-b",
    name: "微信备用机",
    ttlMinutes: 10
  });
  const secondEnroll = enrollAndroidDevice(ctx, {
    enrollmentToken: secondEnrollment.token,
    deviceId: "android-wechat-keywords",
    appVersion: "0.1.0"
  });
  const verifiedDevice = secondEnroll.device;
  expect(firstEnroll.device.deviceId).toBe(verifiedDevice.deviceId);
  expect(verifiedDevice.paymentAccounts.map((item) => item.code).sort()).toEqual(["wechat-a", "wechat-b"]);

  const assistantOrder = createOrder(ctx, {
    paymentChannel: "wechat",
    amount: "1.00",
    merchantOrderId: "wechat-assistant"
  });
  const personalCodeOrder = createOrder(ctx, {
    paymentChannel: "wechat",
    amount: "1.00",
    merchantOrderId: "wechat-personal-code"
  });

  expect(assistantOrder.paymentAccountCode).toBe("wechat-a");
  expect(personalCodeOrder.paymentAccountCode).toBe(wechatB.code);

  const assistantResult = handleAndroidNotification(ctx, {
    rawText: "android.app.Notification 微信收款助手: [店员消息]收款到账1.00元"
  }, verifiedDevice);
  const personalCodeResult = handleAndroidNotification(ctx, {
    rawText: "android.app.Notification 微信支付: 个人收款码到账¥1.00"
  }, verifiedDevice);

  expect(assistantResult.matched).toBe(true);
  expect(assistantResult.order?.id).toBe(assistantOrder.id);
  expect(assistantResult.log.paymentAccountCode).toBe("wechat-a");
  expect(assistantResult.log.actualAmount).toBe("1.00");
  expect(personalCodeResult.matched).toBe(true);
  expect(personalCodeResult.order?.id).toBe(personalCodeOrder.id);
  expect(personalCodeResult.log.paymentAccountCode).toBe("wechat-b");
  expect(personalCodeResult.log.actualAmount).toBe("1.00");
});

test("does not match orders for payment accounts not bound to the android device", () => {
  setPaymentAccountEnabled(ctx, alipayA.id, false);
  const order = createOrder(ctx, {
    paymentChannel: "alipay",
    amount: "21.00",
    merchantOrderId: "unbound-account"
  });
  setPaymentAccountEnabled(ctx, alipayA.id, true);
  const { device } = enrollTestDevice("alipay-a", "android-limited");

  const result = handleAndroidNotification(ctx, {
    packageName: "com.eg.android.AlipayGphone",
    actualAmount: "21.00",
    rawText: "支付宝到账 21.00 元"
  }, device);

  expect(order.paymentAccountCode).toBe("alipay-b");
  expect(result.matched).toBe(false);
  expect(result.order).toBeNull();
  expect(result.log.status).toBe("unmatched");
});

test("records parse failures for unstructured notifications", () => {
  const { device } = enrollTestDevice();
  const result = handleAndroidNotification(ctx, {
    rawText: "你有一条新的收款消息"
  }, device);

  expect(result.matched).toBe(false);
  expect(result.log.status).toBe("parse_failed");
  expect(listNotificationLogs(ctx, { status: "parse_failed" }).total).toBe(1);
});

test("consumes device enrollment tokens once", () => {
  const enrollment = createDeviceEnrollment(ctx, {
    paymentAccountCode: "alipay-a",
    name: "备用收款机",
    ttlMinutes: 10
  });

  const first = enrollAndroidDevice(ctx, {
    enrollmentToken: enrollment.token,
    deviceId: "android-once"
  });

  expect(first.device.deviceId).toBe("android-once");
  expect(() => enrollAndroidDevice(ctx, {
    enrollmentToken: enrollment.token,
    deviceId: "android-replay"
  })).toThrow("配对码");
});

test("verifies signed android requests and rejects replayed nonce", () => {
  const { device, deviceSecret } = enrollTestDevice();
  const bodyText = JSON.stringify({ appVersion: "0.1.0" });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = "nonce-1";
  const signature = signAndroidRequest({
    method: "POST",
    path: "/api/android/heartbeat",
    timestamp,
    nonce,
    bodyText,
    deviceSecret
  });
  const request = new Request("http://peerpay.test/api/android/heartbeat", {
    method: "POST",
    headers: {
      "x-peerpay-device-id": device.deviceId,
      "x-peerpay-timestamp": timestamp,
      "x-peerpay-nonce": nonce,
      "x-peerpay-signature": signature
    },
    body: bodyText
  });

  const verified = verifyAndroidRequest(ctx, request, bodyText) as Device;
  expect(verified.deviceId).toBe(device.deviceId);
  expect(verified.online).toBe(true);
  expect(verified.paymentAccounts.map((item) => item.code)).toEqual(["alipay-a"]);
  expect(verified.lastSeenAt).toBeTruthy();
  expect(() => verifyAndroidRequest(ctx, request, bodyText)).toThrow("nonce");
});

test("generates deterministic webhook signatures", () => {
  const payload = {
    orderId: "ord_1",
    actualAmount: "10.01",
    status: "paid"
  };

  expect(signPayload(payload, "secret")).toBe(signPayload({ status: "paid", orderId: "ord_1", actualAmount: "10.01" }, "secret"));
});

test("generates a hidden admin path and authenticates after setup", async () => {
  const path = getAdminPath(ctx);
  expect(path).toMatch(/^\/[a-f0-9]{7}$/);
  expect(getAdminPath(ctx)).toBe(path);
  expect(isSetupRequired(ctx)).toBe(true);

  const setupCookie = await setupAdminPassword(ctx, "strong-password");
  expect(setupCookie).toContain("peerpay_admin=");
  expect(isSetupRequired(ctx)).toBe(false);

  const state = getAdminSessionState(ctx, new Request("http://peerpay.test", {
    headers: { cookie: setupCookie.split(";")[0] }
  }));
  expect(state.authenticated).toBe(true);
  expect(state.adminPath).toBe(path);

  await expect(loginAdmin(ctx, "wrong-password")).rejects.toThrow("管理密码错误");
});

test("replaces legacy generated admin-prefixed paths", () => {
  ctx.db.query("INSERT INTO app_settings(key, value, updated_at) VALUES (?, ?, ?)")
    .run("admin_path", "/admin-aaaaaaaaaaaaaaaaaa", new Date().toISOString());

  const path = getAdminPath(ctx);
  expect(path).toMatch(/^\/[a-f0-9]{7}$/);
  expect(path).not.toContain("admin-");
});
