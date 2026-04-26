import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { apiError, type AppContext, nowIso } from "./services";

const ADMIN_PASSWORD_KEY = "admin_password_hash";
const ADMIN_PATH_KEY = "admin_path";
const SESSION_SECRET_KEY = "session_secret";
const SESSION_COOKIE = "peerpay_admin";
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AdminSessionState {
  setupRequired: boolean;
  authenticated: boolean;
  adminPath: string;
}

export function getAdminSessionState(ctx: AppContext, req: Request): AdminSessionState {
  const authenticated = verifyAdminRequest(ctx, req);
  return {
    setupRequired: isSetupRequired(ctx),
    authenticated,
    adminPath: authenticated ? getAdminPath(ctx) : ""
  };
}

export function getAdminPath(ctx: AppContext) {
  const configured = Bun.env.ADMIN_PATH?.trim();
  if (configured) {
    return normalizeAdminPath(configured);
  }

  const existing = getSetting(ctx, ADMIN_PATH_KEY);
  if (existing) {
    return normalizeAdminPath(existing);
  }

  const generated = `/admin-${randomBytes(9).toString("hex")}`;
  setSetting(ctx, ADMIN_PATH_KEY, generated);
  return generated;
}

export function isSetupRequired(ctx: AppContext) {
  return !getSetting(ctx, ADMIN_PASSWORD_KEY);
}

export async function setupAdminPassword(ctx: AppContext, password: string) {
  if (!isSetupRequired(ctx)) {
    throw apiError(409, "管理密码已经初始化");
  }
  validatePassword(password);
  const hash = await Bun.password.hash(password);
  setSetting(ctx, ADMIN_PASSWORD_KEY, hash);
  return createAdminCookie(ctx);
}

export async function loginAdmin(ctx: AppContext, password: string) {
  const hash = getSetting(ctx, ADMIN_PASSWORD_KEY);
  if (!hash) {
    throw apiError(409, "请先初始化管理密码");
  }
  const ok = await Bun.password.verify(password, hash);
  if (!ok) {
    throw apiError(401, "管理密码错误");
  }
  return createAdminCookie(ctx);
}

export function logoutAdminCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function requireAdmin(ctx: AppContext, req: Request) {
  if (!verifyAdminRequest(ctx, req)) {
    throw apiError(401, "请先登录管理后台");
  }
}

function createAdminCookie(ctx: AppContext) {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
  const nonce = randomBytes(12).toString("base64url");
  const payload = `${expiresAt}.${nonce}`;
  const signature = sign(ctx, payload);
  return `${SESSION_COOKIE}=${payload}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}`;
}

function verifyAdminRequest(ctx: AppContext, req: Request) {
  const token = parseCookie(req.headers.get("cookie") ?? "")[SESSION_COOKIE];
  if (!token) {
    return false;
  }

  const parts = token.split(".");
  if (parts.length !== 3) {
    return false;
  }

  const [expiresAtText, nonce, signature] = parts;
  const expiresAt = Number(expiresAtText);
  if (!Number.isFinite(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expected = sign(ctx, `${expiresAtText}.${nonce}`);
  return safeEqual(signature, expected);
}

function sign(ctx: AppContext, payload: string) {
  return createHmac("sha256", getSessionSecret(ctx)).update(payload).digest("base64url");
}

function getSessionSecret(ctx: AppContext) {
  const existing = getSetting(ctx, SESSION_SECRET_KEY);
  if (existing) {
    return existing;
  }
  const generated = randomBytes(32).toString("base64url");
  setSetting(ctx, SESSION_SECRET_KEY, generated);
  return generated;
}

function validatePassword(password: string) {
  if (password.length < 8) {
    throw apiError(400, "管理密码至少需要 8 位");
  }
}

function normalizeAdminPath(value: string) {
  const path = value.startsWith("/") ? value : `/${value}`;
  if (!/^\/[a-zA-Z0-9_-]{8,80}$/.test(path)) {
    throw apiError(400, "ADMIN_PATH 只能包含 8-80 位字母、数字、下划线或短横线");
  }
  return path;
}

function parseCookie(header: string) {
  return Object.fromEntries(
    header
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf("=");
        if (index === -1) {
          return [part, ""];
        }
        return [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function safeEqual(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.byteLength !== right.byteLength) {
    return false;
  }
  return timingSafeEqual(left, right);
}

function getSetting(ctx: AppContext, key: string) {
  const row = ctx.db.query("SELECT value FROM app_settings WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

function setSetting(ctx: AppContext, key: string, value: string) {
  ctx.db.query(`
    INSERT INTO app_settings(key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, nowIso());
}
