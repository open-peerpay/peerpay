import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  closeAppContext,
  createAccount,
  createAppContext,
  createDeviceEnrollment,
  createOrder,
  enrollAndroidDevice,
  handleAndroidNotification,
  listAmountOccupations,
  listNotificationLogs,
  signAndroidRequest,
  signPayload,
  updateAccountSettings,
  upsertPresetQrCodes,
  verifyAndroidRequest,
  type AppContext
} from "../server/services";
import type { Device, EnrollDeviceResult } from "../src/shared/types";
import { getAdminPath, getAdminSessionState, isSetupRequired, loginAdmin, setupAdminPassword } from "../server/auth";
import { parseMoney } from "../server/money";

let ctx: AppContext;

beforeEach(() => {
  ctx = createAppContext({ databaseUrl: ":memory:", runCallbacks: false });
  updateAccountSettings(ctx, 1, {
    maxOffsetCents: 10,
    fallbackPayUrl: "https://pay.example/alipay-fallback",
    wechatFallbackPayUrl: "https://pay.example/wechat-fallback"
  });
});

afterEach(() => {
  closeAppContext(ctx);
});

function enrollTestDevice(deviceId = "android-main"): EnrollDeviceResult {
  const enrollment = createDeviceEnrollment(ctx, {
    accountCode: "default",
    name: "主收款机",
    ttlMinutes: 10
  });

  return enrollAndroidDevice(ctx, {
    enrollmentToken: enrollment.token,
    deviceId,
    appVersion: "0.1.0"
  });
}

test("creates orders by dynamically assigning offset amounts", () => {
  upsertPresetQrCodes(ctx, {
    accountCode: "default",
    items: [{ amount: "10.00", payUrl: "https://pay.example/10.00" }]
  });

  const first = createOrder(ctx, {
    accountCode: "default",
    amount: "10.00",
    merchantOrderId: "m-10001",
    ttlMinutes: 10
  });
  const second = createOrder(ctx, {
    accountCode: "default",
    amount: "10.00",
    merchantOrderId: "m-10002",
    ttlMinutes: 10
  });

  expect(first.status).toBe("pending");
  expect(first.paymentChannel).toBe("alipay");
  expect(first.actualAmount).toBe("10.00");
  expect(first.payMode).toBe("preset");
  expect(first.amountInputRequired).toBe(false);
  expect(first.payUrl).toBe("https://pay.example/10.00");
  expect(second.actualAmount).toBe("10.01");
  expect(second.payMode).toBe("fallback");
  expect(second.amountInputRequired).toBe(true);

  const occupied = listAmountOccupations(ctx).items;
  expect(occupied).toHaveLength(2);
});

test("separates amount locks and preset qr codes by payment channel", () => {
  upsertPresetQrCodes(ctx, {
    accountCode: "default",
    items: [
      { paymentChannel: "alipay", amount: "12.00", payUrl: "https://pay.example/alipay/12.00" },
      { paymentChannel: "wechat", amount: "12.00", payUrl: "https://pay.example/wechat/12.00" }
    ]
  });

  const alipay = createOrder(ctx, {
    accountCode: "default",
    paymentChannel: "alipay",
    amount: "12.00",
    merchantOrderId: "m-alipay",
    ttlMinutes: 10
  });
  const wechat = createOrder(ctx, {
    accountCode: "default",
    paymentChannel: "wechat",
    amount: "12.00",
    merchantOrderId: "m-wechat",
    ttlMinutes: 10
  });
  const nextAlipay = createOrder(ctx, {
    accountCode: "default",
    paymentChannel: "alipay",
    amount: "12.00",
    merchantOrderId: "m-alipay-next",
    ttlMinutes: 10
  });

  expect(alipay.actualAmount).toBe("12.00");
  expect(alipay.payUrl).toBe("https://pay.example/alipay/12.00");
  expect(wechat.actualAmount).toBe("12.00");
  expect(wechat.payUrl).toBe("https://pay.example/wechat/12.00");
  expect(nextAlipay.actualAmount).toBe("12.01");

  const occupied = listAmountOccupations(ctx).items;
  expect(occupied).toHaveLength(3);
  expect(occupied.map((item) => `${item.paymentChannel}:${item.actualAmount}`).sort()).toEqual([
    "alipay:12.00",
    "alipay:12.01",
    "wechat:12.00"
  ]);
});

test("uses channel-specific fallback pay urls", () => {
  const alipay = createOrder(ctx, {
    accountCode: "default",
    paymentChannel: "alipay",
    amount: "13.00",
    merchantOrderId: "fallback-alipay",
    ttlMinutes: 10
  });
  const wechat = createOrder(ctx, {
    accountCode: "default",
    paymentChannel: "wechat",
    amount: "13.00",
    merchantOrderId: "fallback-wechat",
    ttlMinutes: 10
  });

  expect(alipay.actualAmount).toBe("13.00");
  expect(alipay.payUrl).toBe("https://pay.example/alipay-fallback");
  expect(wechat.actualAmount).toBe("13.00");
  expect(wechat.payUrl).toBe("https://pay.example/wechat-fallback");
});

test("defaults account max offset to 10 cents", () => {
  const account = createAccount(ctx, {
    code: "store-a",
    name: "门店 A"
  });

  expect(account.maxOffsetCents).toBe(10);
  expect(account.maxOffset).toBe("0.10");
});

test("does not offset cent-level order amounts", () => {
  const first = createOrder(ctx, {
    accountCode: "default",
    amount: "10.01",
    merchantOrderId: "m-20001",
    ttlMinutes: 10
  });

  expect(first.actualAmount).toBe("10.01");
  expect(() => createOrder(ctx, {
    accountCode: "default",
    amount: "10.01",
    merchantOrderId: "m-20002",
    ttlMinutes: 10
  })).toThrow("最大偏移 0.00");
  expect(listAmountOccupations(ctx).items).toHaveLength(1);
});

test("parses money into integer cents without floating point multiplication", () => {
  expect(parseMoney("10.01")).toBe(1001);
  expect(parseMoney(10.01)).toBe(1001);
  expect(parseMoney(0.3)).toBe(30);
  expect(() => parseMoney(1.005)).toThrow("最多两位小数");
});

test("matches an android payment notification and clears the occupation", () => {
  const { device } = enrollTestDevice();
  const order = createOrder(ctx, {
    accountCode: "default",
    amount: "10.00",
    callbackUrl: "https://merchant.example/webhook"
  });

  const result = handleAndroidNotification(ctx, {
    channel: "alipay",
    actualAmount: order.actualAmount,
    rawText: `支付宝到账 ${order.actualAmount} 元`
  }, device);

  expect(result.matched).toBe(true);
  expect(result.order?.id).toBe(order.id);
  expect(result.order?.status).toBe("paid");
  expect(listAmountOccupations(ctx).items).toHaveLength(0);
});

test("matches android payment notifications by package name", () => {
  const { device } = enrollTestDevice();
  const alipayOrder = createOrder(ctx, {
    accountCode: "default",
    paymentChannel: "alipay",
    amount: "20.00",
    merchantOrderId: "pkg-alipay"
  });
  const wechatOrder = createOrder(ctx, {
    accountCode: "default",
    paymentChannel: "wechat",
    amount: "20.00",
    merchantOrderId: "pkg-wechat"
  });

  const wechatResult = handleAndroidNotification(ctx, {
    packageName: "com.tencent.mm",
    actualAmount: "20.00",
    rawText: "微信收款到账 20.00 元"
  }, device);
  const alipayResult = handleAndroidNotification(ctx, {
    packageName: "com.eg.android.AlipayGphone",
    actualAmount: "20.00",
    rawText: "支付宝到账 20.00 元"
  }, device);

  expect(wechatResult.matched).toBe(true);
  expect(wechatResult.order?.id).toBe(wechatOrder.id);
  expect(wechatResult.order?.id).not.toBe(alipayOrder.id);
  expect(wechatResult.log.paymentChannel).toBe("wechat");
  expect(wechatResult.log.packageName).toBe("com.tencent.mm");
  expect(alipayResult.matched).toBe(true);
  expect(alipayResult.order?.id).toBe(alipayOrder.id);
  expect(alipayResult.log.paymentChannel).toBe("alipay");
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
    accountCode: "default",
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
