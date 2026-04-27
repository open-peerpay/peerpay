import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  closeAppContext,
  createAppContext,
  createDeviceEnrollment,
  createOrder,
  createPaymentAccount,
  enrollAndroidDevice,
  handleAndroidNotification,
  listAmountOccupations,
  listNotificationLogs,
  setPaymentAccountEnabled,
  signAndroidRequest,
  signPayload,
  updatePaymentAccountSettings,
  upsertPresetQrCodes,
  verifyAndroidRequest,
  type AppContext
} from "../server/services";
import type { Device, EnrollDeviceResult, PaymentAccount } from "../src/shared/types";
import { getAdminPath, getAdminSessionState, isSetupRequired, loginAdmin, setupAdminPassword } from "../server/auth";
import { parseMoney } from "../server/money";

let ctx: AppContext;
let alipayA: PaymentAccount;
let alipayB: PaymentAccount;
let wechatA: PaymentAccount;

beforeEach(() => {
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
  upsertPresetQrCodes(ctx, {
    paymentAccountCode: "wechat-a",
    items: [{ amount: "12.00", payUrl: "https://pay.example/wechat-a/12.00" }]
  });

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
  expect(alipay.payUrl).toBe("https://pay.example/alipay-a/12.00");
  expect(wechat.paymentAccountCode).toBe("wechat-a");
  expect(wechat.payMode).toBe("preset");
  expect(wechat.payUrl).toBe("https://pay.example/wechat-a/12.00");
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
  expect(order.payUrl).toBe("https://pay.example/alipay-b");
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

test("parses money into integer cents without floating point multiplication", () => {
  expect(parseMoney("10.01")).toBe(1001);
  expect(parseMoney(10.01)).toBe(1001);
  expect(parseMoney(0.3)).toBe(30);
  expect(() => parseMoney(1.005)).toThrow("最多两位小数");
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
