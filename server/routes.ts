import {
  createDeviceEnrollment,
  createOrder,
  createPaymentAccount,
  dashboardStats,
  deletePresetQrCode,
  dispatchCallback,
  enrollAndroidDevice,
  getPaymentPageSettings,
  getOrder,
  getPublicPaymentPage,
  handleAndroidNotification,
  listAmountOccupations,
  listCallbackLogs,
  listDevices,
  listNotificationLogs,
  listOrders,
  listPaymentAccounts,
  listPresetQrCodes,
  listSystemLogs,
  paymentPagePath,
  setDeviceEnabled,
  setPaymentAccountEnabled,
  touchDevice,
  updateOrderStatus,
  updatePaymentAccountSettings,
  updatePaymentPageSettings,
  upsertPresetQrCodes,
  verifyAndroidRequest,
  type AppContext
} from "./services";
import {
  getAdminSessionState,
  loginAdmin,
  logoutAdminCookie,
  requireAdmin,
  setupAdminPassword
} from "./auth";
import { boolFromBody, corsHeaders, json, pageOptions, parseJsonText, readJson, withErrors } from "./http";
import type {
  AndroidNotificationInput,
  BulkPresetQrCodeInput,
  CreateDeviceEnrollmentInput,
  CreateOrderInput,
  EnrollDeviceInput,
  HeartbeatInput,
  Order,
  OrderStatus
} from "../src/shared/types";

type RouteRequest<T extends Record<string, string> = Record<string, string>> = Request & {
  params: T;
};

function admin<T extends Request>(ctx: AppContext, req: T, handler: () => Response | Promise<Response>) {
  requireAdmin(ctx, req);
  return handler();
}

function pairingUrl(token: string) {
  const url = new URL("/api/android/enroll", "http://peerpay.local");
  url.searchParams.set("token", token);
  return `${url.pathname}${url.search}`;
}

function publicUrl(req: Request, path: string) {
  return new URL(path, req.url).toString();
}

function publicOrder(req: Request, order: Order) {
  return {
    ...order,
    payUrl: publicUrl(req, paymentPagePath(order.id))
  };
}

export function createApiRoutes(ctx: AppContext) {
  return {
    "/api/health": {
      GET: () => json({ ok: true, time: new Date().toISOString() })
    },
    "/api/admin/session": {
      GET: (req: Request) => withErrors(() => json(getAdminSessionState(ctx, req)))
    },
    "/api/admin/setup": {
      POST: (req: Request) => withErrors(async () => {
        const body = await readJson<{ password?: string }>(req);
        const cookie = await setupAdminPassword(ctx, body.password ?? "");
        return json({ ...getAdminSessionState(ctx, req), authenticated: true, setupRequired: false }, { headers: { "set-cookie": cookie } });
      })
    },
    "/api/admin/login": {
      POST: (req: Request) => withErrors(async () => {
        const body = await readJson<{ password?: string }>(req);
        const cookie = await loginAdmin(ctx, body.password ?? "");
        return json({ ...getAdminSessionState(ctx, req), authenticated: true }, { headers: { "set-cookie": cookie } });
      })
    },
    "/api/admin/logout": {
      POST: () => withErrors(() => json({ ok: true }, { headers: { "set-cookie": logoutAdminCookie() } }))
    },
    "/api/dashboard": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => json(dashboardStats(ctx))))
    },
    "/api/settings/payment-page": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => json(getPaymentPageSettings(ctx)))),
      POST: (req: Request) => withErrors(async () => admin(ctx, req, async () => json(updatePaymentPageSettings(ctx, await readJson(req)))))
    },
    "/api/payment-accounts": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => json(listPaymentAccounts(ctx)))),
      POST: (req: Request) => withErrors(async () => admin(ctx, req, async () => json(createPaymentAccount(ctx, await readJson(req)), { status: 201 })))
    },
    "/api/payment-accounts/:id/enabled": {
      POST: (req: RouteRequest<{ id: string }>) => withErrors(async () => {
        return admin(ctx, req, async () => {
          const body = await readJson<{ enabled: unknown }>(req);
          return json(setPaymentAccountEnabled(ctx, Number(req.params.id), boolFromBody(body.enabled)));
        });
      })
    },
    "/api/payment-accounts/:id/settings": {
      POST: (req: RouteRequest<{ id: string }>) => withErrors(async () => {
        return admin(ctx, req, async () => json(updatePaymentAccountSettings(ctx, Number(req.params.id), await readJson(req))));
      })
    },
    "/api/orders": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => {
        const url = new URL(req.url);
        const page = listOrders(ctx, {
          ...pageOptions(url),
          status: url.searchParams.get("status") ?? undefined,
          paymentAccountCode: url.searchParams.get("paymentAccountCode") ?? undefined,
          paymentChannel: url.searchParams.get("paymentChannel") ?? url.searchParams.get("channel") ?? undefined
        });
        return json({ ...page, items: page.items.map((order) => publicOrder(req, order)) });
      })),
      POST: (req: Request) => withErrors(async () => {
        const order = createOrder(ctx, await readJson<CreateOrderInput>(req));
        return json(publicOrder(req, order), { status: 201 });
      })
    },
    "/api/orders/:id": {
      GET: (req: RouteRequest<{ id: string }>) => withErrors(() => admin(ctx, req, () => {
        const order = getOrder(ctx, req.params.id);
        return json(order ? publicOrder(req, order) : null);
      }))
    },
    "/api/pay/:id": {
      GET: (req: RouteRequest<{ id: string }>) => withErrors(() => json(getPublicPaymentPage(ctx, req.params.id)))
    },
    "/api/orders/:id/status": {
      POST: (req: RouteRequest<{ id: string }>) => withErrors(async () => {
        return admin(ctx, req, async () => {
          const body = await readJson<{ status: OrderStatus }>(req);
          return json(updateOrderStatus(ctx, req.params.id, body.status));
        });
      })
    },
    "/api/preset-qrcodes": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => {
        const url = new URL(req.url);
        return json(listPresetQrCodes(ctx, {
          ...pageOptions(url),
          paymentAccountCode: url.searchParams.get("paymentAccountCode") ?? undefined,
          paymentChannel: url.searchParams.get("paymentChannel") ?? url.searchParams.get("channel") ?? undefined
        }));
      })),
      POST: (req: Request) => withErrors(async () => {
        return admin(ctx, req, async () => {
          const body = await readJson<BulkPresetQrCodeInput & { amount?: string | number; payUrl?: string }>(req);
          const result = upsertPresetQrCodes(ctx, Array.isArray(body.items) ? body : {
            paymentAccountId: body.paymentAccountId,
            paymentAccountCode: body.paymentAccountCode,
            items: [{ amount: body.amount ?? "", payUrl: body.payUrl ?? "" }]
          });
          return json(result, { status: 201 });
        });
      })
    },
    "/api/preset-qrcodes/:id": {
      DELETE: (req: RouteRequest<{ id: string }>) => withErrors(() => admin(ctx, req, () => json(deletePresetQrCode(ctx, Number(req.params.id)))))
    },
    "/api/amount-occupations": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => {
        const url = new URL(req.url);
        return json(listAmountOccupations(ctx, {
          ...pageOptions(url),
          paymentAccountCode: url.searchParams.get("paymentAccountCode") ?? undefined,
          paymentChannel: url.searchParams.get("paymentChannel") ?? url.searchParams.get("channel") ?? undefined
        }));
      }))
    },
    "/api/android/notifications": {
      POST: (req: Request) => withErrors(async () => {
        const bodyText = await req.text();
        const device = verifyAndroidRequest(ctx, req, bodyText);
        const result = handleAndroidNotification(ctx, parseJsonText<AndroidNotificationInput>(bodyText), device);
        return json(result, { status: result.matched ? 200 : 202 });
      })
    },
    "/api/android/enroll": {
      POST: (req: Request) => withErrors(async () => {
        const url = new URL(req.url);
        const body = await readJson<EnrollDeviceInput>(req);
        return json(enrollAndroidDevice(ctx, {
          ...body,
          enrollmentToken: body.enrollmentToken || url.searchParams.get("token") || ""
        }));
      })
    },
    "/api/android/heartbeat": {
      POST: (req: Request) => withErrors(async () => {
        const bodyText = await req.text();
        const device = verifyAndroidRequest(ctx, req, bodyText);
        return json(touchDevice(ctx, parseJsonText<HeartbeatInput>(bodyText), device));
      })
    },
    "/api/devices": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => json(listDevices(ctx))))
    },
    "/api/device-enrollments": {
      POST: (req: Request) => withErrors(async () => admin(ctx, req, async () => {
        const enrollment = createDeviceEnrollment(ctx, await readJson<CreateDeviceEnrollmentInput>(req));
        return json({ ...enrollment, pairingUrl: pairingUrl(enrollment.token) }, { status: 201 });
      }))
    },
    "/api/devices/:id/enabled": {
      POST: (req: RouteRequest<{ id: string }>) => withErrors(async () => {
        return admin(ctx, req, async () => {
          const body = await readJson<{ enabled: unknown }>(req);
          return json(setDeviceEnabled(ctx, Number(req.params.id), boolFromBody(body.enabled)));
        });
      })
    },
    "/api/logs/notifications": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => {
        const url = new URL(req.url);
        return json(listNotificationLogs(ctx, {
          ...pageOptions(url),
          status: url.searchParams.get("status") ?? undefined
        }));
      }))
    },
    "/api/logs/system": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => {
        const url = new URL(req.url);
        return json(listSystemLogs(ctx, {
          ...pageOptions(url),
          level: url.searchParams.get("level") ?? undefined
        }));
      }))
    },
    "/api/callbacks": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => {
        const url = new URL(req.url);
        return json(listCallbackLogs(ctx, {
          ...pageOptions(url),
          status: url.searchParams.get("status") ?? undefined
        }));
      }))
    },
    "/api/callbacks/:id/retry": {
      POST: (req: RouteRequest<{ id: string }>) => withErrors(async () => admin(ctx, req, async () => json(await dispatchCallback(ctx, Number(req.params.id)))))
    },
    "/api/*": {
      OPTIONS: () => new Response(null, { status: 204, headers: corsHeaders })
    }
  };
}
