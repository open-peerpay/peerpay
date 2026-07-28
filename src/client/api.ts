import type {
  AmountOccupation,
  BulkPresetQrCodeInput,
  CallbackLog,
  CreateDeviceEnrollmentInput,
  CreatePaymentAccountInput,
  CreatePresetQrGenerationTaskInput,
  DashboardStats,
  Device,
  DeviceEnrollment,
  NotificationSettings,
  NotificationLog,
  Order,
  OrderStatus,
  Page,
  PaymentPageData,
  PaymentPageSettings,
  PaymentAccount,
  PresetQrGenerationTask,
  PresetQrCode,
  SystemLog,
  CallbackType,
  UpdatePaymentAccountInput,
  UpdateNotificationSettingsInput,
  UpdatePaymentPageSettingsInput
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
    request<NotificationSettings>("/api/settings/notifications"),
    request<PaymentPageSettings>("/api/settings/payment-page"),
    request<PaymentAccount[]>("/api/payment-accounts"),
    request<Page<Order>>("/api/orders?limit=80"),
    request<Page<AmountOccupation>>("/api/amount-occupations?limit=160"),
    request<Page<PresetQrCode>>("/api/preset-qrcodes?limit=160"),
    request<Page<PresetQrGenerationTask>>("/api/preset-qrcode-generation-tasks?limit=20"),
    request<Device[]>("/api/devices"),
    request<Page<NotificationLog>>("/api/logs/notifications?limit=80"),
    request<Page<SystemLog>>("/api/logs/system?limit=80"),
    request<Page<CallbackLog>>("/api/callbacks?limit=80")
  ]).then(([dashboard, notificationSettings, paymentPageSettings, paymentAccounts, orders, occupations, qrCodes, qrGenerationTasks, devices, notifications, systemLogs, callbacks]) => ({
    dashboard,
    notificationSettings,
    paymentPageSettings,
    paymentAccounts,
    orders,
    occupations,
    qrCodes,
    qrGenerationTasks,
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

export function createDeviceEnrollment(input: CreateDeviceEnrollmentInput) {
  return request<DeviceEnrollment>("/api/device-enrollments", { method: "POST", body: JSON.stringify(input) });
}

export function upsertQrCodes(input: BulkPresetQrCodeInput) {
  return request<{ saved: number }>("/api/preset-qrcodes", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function createQrGenerationTask(input: CreatePresetQrGenerationTaskInput) {
  return request<PresetQrGenerationTask>("/api/preset-qrcode-generation-tasks", {
    method: "POST",
    body: JSON.stringify(input)
  });
}

export function deleteQrGenerationTask(id: number) {
  return request<PresetQrGenerationTask>(`/api/preset-qrcode-generation-tasks/${id}`, { method: "DELETE" });
}

export function retryQrGenerationTask(id: number) {
  return request<PresetQrGenerationTask>(`/api/preset-qrcode-generation-tasks/${id}/retry`, { method: "POST" });
}

export function stopQrGenerationTask(id: number) {
  return request<PresetQrGenerationTask>(`/api/preset-qrcode-generation-tasks/${id}/stop`, { method: "POST" });
}

export function createPaymentAccount(input: CreatePaymentAccountInput) {
  return request<PaymentAccount>("/api/payment-accounts", { method: "POST", body: JSON.stringify(input) });
}

export function deletePaymentAccount(id: number) {
  return request<PaymentAccount>(`/api/payment-accounts/${id}`, { method: "DELETE" });
}

export function setPaymentAccountEnabled(id: number, enabled: boolean) {
  return request<PaymentAccount>(`/api/payment-accounts/${id}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) });
}

export function updatePaymentAccountSettings(id: number, input: UpdatePaymentAccountInput) {
  return request<PaymentAccount>(`/api/payment-accounts/${id}/settings`, { method: "POST", body: JSON.stringify(input) });
}

export function updatePaymentPageSettings(input: UpdatePaymentPageSettingsInput) {
  return request<PaymentPageSettings>("/api/settings/payment-page", { method: "POST", body: JSON.stringify(input) });
}

export function updateNotificationSettings(input: UpdateNotificationSettingsInput) {
  return request<NotificationSettings>("/api/settings/notifications", { method: "POST", body: JSON.stringify(input) });
}

export function getPaymentPage(orderId: string) {
  return request<PaymentPageData>(`/api/pay/${encodeURIComponent(orderId)}`);
}

export function setDeviceEnabled(id: number, enabled: boolean) {
  return request<Device>(`/api/devices/${id}/enabled`, { method: "POST", body: JSON.stringify({ enabled }) });
}

export function deleteDevice(id: number) {
  return request<Device>(`/api/devices/${id}`, { method: "DELETE" });
}

export function unbindDevicePaymentAccount(deviceId: number, paymentAccountId: number) {
  return request<Device>(`/api/devices/${deviceId}/payment-accounts/${paymentAccountId}`, { method: "DELETE" });
}

export function updateOrderStatus(id: string, status: OrderStatus) {
  return request<Order>(`/api/orders/${id}/status`, { method: "POST", body: JSON.stringify({ status }) });
}

export function deleteQrCode(id: number) {
  return request<PresetQrCode>(`/api/preset-qrcodes/${id}`, { method: "DELETE" });
}

export function setQrCodeChecked(id: number, checked: boolean) {
  return request<PresetQrCode>(`/api/preset-qrcodes/${id}/checked`, { method: "POST", body: JSON.stringify({ checked }) });
}

export function retryCallback(id: number, type: CallbackType = "peerpay") {
  return request<CallbackLog>(`/api/callbacks/${id}/retry`, { method: "POST", body: JSON.stringify({ type }) });
}
