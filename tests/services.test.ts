import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  closeAppContext,
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

let ctx: AppContext;

beforeEach(() => {
  ctx = createAppContext({ databaseUrl: ":memory:", runCallbacks: false });
  updateAccountSettings(ctx, 1, {
    maxOffsetCents: 99,
    fallbackPayUrl: "https://pay.example/fallback"
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
