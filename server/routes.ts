import {
  createAccount,
  createOrder,
  dashboardStats,
  deletePresetQrCode,
  dispatchCallback,
  getOrder,
  handleAndroidNotification,
  listAccounts,
  listAmountOccupations,
  listCallbackLogs,
  listDevices,
  listNotificationLogs,
  listOrders,
  listPresetQrCodes,
  listSystemLogs,
  setAccountEnabled,
  setDeviceEnabled,
  touchDevice,
  updateOrderStatus,
  updateAccountSettings,
  upsertPresetQrCodes,
  type AppContext
} from "./services";
import {
  getAdminSessionState,
  loginAdmin,
  logoutAdminCookie,
  requireAdmin,
  setupAdminPassword
} from "./auth";
import { boolFromBody, corsHeaders, json, pageOptions, readJson, withErrors } from "./http";
import type {
  AndroidNotificationInput,
  BulkPresetQrCodeInput,
  CreateOrderInput,
  HeartbeatInput,
  OrderStatus
} from "../src/shared/types";

type RouteRequest<T extends Record<string, string> = Record<string, string>> = Request & {
  params: T;
};

function admin<T extends Request>(ctx: AppContext, req: T, handler: () => Response | Promise<Response>) {
  requireAdmin(ctx, req);
  return handler();
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
    "/api/accounts": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => json(listAccounts(ctx)))),
      POST: (req: Request) => withErrors(async () => admin(ctx, req, async () => json(createAccount(ctx, await readJson(req)), { status: 201 })))
    },
    "/api/accounts/:id/enabled": {
      POST: (req: RouteRequest<{ id: string }>) => withErrors(async () => {
        return admin(ctx, req, async () => {
          const body = await readJson<{ enabled: unknown }>(req);
          return json(setAccountEnabled(ctx, Number(req.params.id), boolFromBody(body.enabled)));
        });
      })
    },
    "/api/accounts/:id/settings": {
      POST: (req: RouteRequest<{ id: string }>) => withErrors(async () => {
        return admin(ctx, req, async () => json(updateAccountSettings(ctx, Number(req.params.id), await readJson(req))));
      })
    },
    "/api/orders": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => {
        const url = new URL(req.url);
        return json(listOrders(ctx, {
          ...pageOptions(url),
          status: url.searchParams.get("status") ?? undefined,
          accountCode: url.searchParams.get("accountCode") ?? undefined
        }));
      })),
      POST: (req: Request) => withErrors(async () => {
        const order = createOrder(ctx, await readJson<CreateOrderInput>(req));
        return json(order, { status: 201 });
      })
    },
    "/api/orders/:id": {
      GET: (req: RouteRequest<{ id: string }>) => withErrors(() => admin(ctx, req, () => json(getOrder(ctx, req.params.id))))
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
          accountCode: url.searchParams.get("accountCode") ?? undefined
        }));
      })),
      POST: (req: Request) => withErrors(async () => {
        return admin(ctx, req, async () => {
          const body = await readJson<BulkPresetQrCodeInput & { amount?: string | number; payUrl?: string }>(req);
          const result = upsertPresetQrCodes(ctx, Array.isArray(body.items) ? body : {
            accountId: body.accountId,
            accountCode: body.accountCode,
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
          accountCode: url.searchParams.get("accountCode") ?? undefined
        }));
      }))
    },
    "/api/android/notifications": {
      POST: (req: Request) => withErrors(async () => {
        const result = handleAndroidNotification(ctx, await readJson<AndroidNotificationInput>(req));
        return json(result, { status: result.matched ? 200 : 202 });
      })
    },
    "/api/android/heartbeat": {
      POST: (req: Request) => withErrors(async () => json(touchDevice(ctx, await readJson<HeartbeatInput>(req))))
    },
    "/api/devices": {
      GET: (req: Request) => withErrors(() => admin(ctx, req, () => json(listDevices(ctx))))
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
