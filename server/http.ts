import { apiError } from "./services";

export const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
  "access-control-allow-headers": "content-type, authorization, x-peerpay-device-id, x-peerpay-timestamp, x-peerpay-nonce, x-peerpay-signature"
};

export function json<T>(data: T, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  headers.set("cache-control", "no-store");
  return Response.json({ data }, { ...init, headers });
}

export function errorResponse(error: unknown) {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number((error as { status?: number }).status)
    : 500;
  const message = error instanceof Error ? error.message : "服务器内部错误";
  const details = typeof error === "object" && error !== null && "details" in error
    ? (error as { details?: unknown }).details
    : undefined;

  return json({ error: message, details }, { status: Number.isFinite(status) ? status : 500 });
}

export async function withErrors(handler: () => Response | Promise<Response>) {
  try {
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}

export async function readJson<T>(req: Request): Promise<T> {
  const text = await req.text();
  return parseJsonText<T>(text);
}

export function parseJsonText<T>(text: string): T {
  if (!text.trim()) {
    return {} as T;
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    throw apiError(400, "请求体不是有效 JSON");
  }
}

export function pageOptions(url: URL) {
  return {
    limit: Number(url.searchParams.get("limit") ?? 50),
    offset: Number(url.searchParams.get("offset") ?? 0)
  };
}

export function boolFromBody(value: unknown) {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1 || value === "1" || value === "true") {
    return true;
  }
  if (value === 0 || value === "0" || value === "false") {
    return false;
  }
  throw apiError(400, "enabled 必须是布尔值");
}
