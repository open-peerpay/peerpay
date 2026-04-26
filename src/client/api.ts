import type {
  Account,
  AmountOccupation,
  BulkPresetQrCodeInput,
  CallbackLog,
  CreateOrderInput,
  DashboardStats,
  Device,
  NotificationLog,
  Order,
  OrderStatus,
  Page,
  PresetQrCode,
  SystemLog
} from "../shared/types";

export interface AdminSessionState {
  setupRequired: boolean;
  authenticated: boolean;
  adminPath: string;
}

interface ApiEnvelope<T> {
  data: T;
}

interface ApiErrorEnvelope {
  data?: {
    error?: string;
  };
  error?: string;
}

async function request<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers
    }
  });
  const payload = await response.json().catch(() => ({})) as ApiEnvelope<T> & ApiErrorEnvelope;

  if (!response.ok) {
    throw new Error(payload.data?.error ?? payload.error ?? `请求失败 (${response.status})`);
  }

  return payload.data;
}

export function loadSnapshot() {
  return Promise.all([
    request<DashboardStats>("/api/dashboard"),
    request<Account[]>("/api/accounts"),
    request<Page<Order>>("/api/orders?limit=80"),
    request<Page<AmountOccupation>>("/api/amount-occupations?limit=160"),
    request<Page<PresetQrCode>>("/api/preset-qrcodes?limit=160"),
    request<Device[]>("/api/devices"),
    request<Page<NotificationLog>>("/api/logs/notifications?limit=80"),
    request<Page<SystemLog>>("/api/logs/system?limit=80"),
    request<Page<CallbackLog>>("/api/callbacks?limit=80")
  ]).then(([dashboard, accounts, orders, occupations, qrCodes, devices, notifications, systemLogs, callbacks]) => ({
    dashboard,
    accounts,
    orders,
    occupations,
    qrCodes,
    devices,
    notifications,
    systemLogs,
    callbacks
  }));
}

export type Snapshot = Awaited<ReturnType<typeof loadSnapshot>>;

export function getAdminSession() {
  return request<AdminSessionState>("/api/admin/session");
}

export function setupAdmin(password: string) {
  return request<AdminSessionState>("/api/admin/setup", { method: "POST", body: JSON.stringify({ password }) });
}

export function loginAdmin(password: string) {
  return request<AdminSessionState>("/api/admin/login", { method: "POST", body: JSON.stringify({ password }) });
}

export function logoutAdmin() {
  return request<{ ok: boolean }>("/api/admin/logout", { method: "POST" });
}

export function createOrder(input: CreateOrderInput) {
  return request<Order>("/api/orders", { method: "POST", body: JSON.stringify(input) });
}

export function upsertQrCodes(input: BulkPresetQrCodeInput) {
  return request<{ saved: number }>("/api/preset-qrcodes", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function createAccount(input: { code: string; name: string }) {
  return request<Account>("/api/accounts", { method: "POST", body: JSON.stringify(input) });
}

export function setAccountEnabled(id: number, enabled: boolean) {
  return request<Account>(`/api/accounts/${id}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) });
}

export function updateAccountSettings(id: number, input: { maxOffsetCents?: number; fallbackPayUrl?: string | null }) {
  return request<Account>(`/api/accounts/${id}/settings`, { method: "POST", body: JSON.stringify(input) });
}

export function setDeviceEnabled(id: number, enabled: boolean) {
  return request<Device>(`/api/devices/${id}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) });
}

export function updateOrderStatus(id: string, status: OrderStatus) {
  return request<Order>(`/api/orders/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
}

export function deleteQrCode(id: number) {
  return request<PresetQrCode>(`/api/preset-qrcodes/${id}`, { method: "DELETE" });
}

export function retryCallback(id: number) {
  return request<CallbackLog>(`/api/callbacks/${id}/retry`, { method: "POST" });
}
