export type OrderStatus = "pending" | "paid" | "notified" | "expired";
export type LogLevel = "info" | "warn" | "error";
export type MatchStatus = "matched" | "unmatched" | "parse_failed";
export type CallbackStatus = "pending" | "success" | "failed";
export type PayMode = "preset" | "fallback";
export type PaymentChannel = "wechat" | "alipay";

export interface PaymentAccount {
  id: number;
  code: string;
  name: string;
  paymentChannel: PaymentChannel;
  priority: number;
  enabled: boolean;
  maxOffsetCents: number;
  maxOffset: string;
  fallbackPayUrl: string | null;
  notificationKeywords: string[];
  createdAt: string;
}

export interface PresetQrCode {
  id: number;
  paymentAccountId: number;
  paymentAccountCode: string;
  paymentAccountName: string;
  paymentChannel: PaymentChannel;
  amount: string;
  amountCents: number;
  payUrl: string;
  checked: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AmountOccupation {
  orderId: string;
  paymentAccountId: number;
  paymentAccountCode: string;
  paymentAccountName: string;
  paymentChannel: PaymentChannel;
  actualAmount: string;
  actualAmountCents: number;
  requestedAmount: string;
  status: OrderStatus;
  expireAt: string;
  payMode: PayMode;
}

export interface Order {
  id: string;
  merchantOrderId: string | null;
  paymentAccountId: number;
  paymentAccountCode: string;
  paymentAccountName: string;
  paymentChannel: PaymentChannel;
  requestedAmount: string;
  requestedAmountCents: number;
  actualAmount: string;
  actualAmountCents: number;
  payUrl: string;
  payMode: PayMode;
  amountInputRequired: boolean;
  status: OrderStatus;
  subject: string | null;
  callbackUrl: string | null;
  redirectUrl: string | null;
  expireAt: string;
  paidAt: string | null;
  notifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentPageSettings {
  noticeEnabled: boolean;
  noticeTitle: string;
  noticeBody: string;
  noticeLinkText: string;
  noticeLinkUrl: string | null;
}

export interface PaymentPageNotice {
  title: string;
  body: string;
  linkText: string;
  linkUrl: string | null;
}

export interface PaymentPageData {
  orderId: string;
  merchantOrderId: string | null;
  paymentAccountName: string;
  paymentAccountCode: string;
  paymentChannel: PaymentChannel;
  requestedAmount: string;
  actualAmount: string;
  targetPayUrl: string;
  payMode: PayMode;
  amountInputRequired: boolean;
  status: OrderStatus;
  subject: string | null;
  redirectUrl: string | null;
  expireAt: string;
  notice: PaymentPageNotice | null;
}

export interface DevicePaymentAccount {
  id: number;
  code: string;
  name: string;
  paymentChannel: PaymentChannel;
}

export interface Device {
  id: number;
  deviceId: string;
  name: string | null;
  paymentAccounts: DevicePaymentAccount[];
  enabled: boolean;
  online: boolean;
  pairedAt: string | null;
  lastSeenAt: string | null;
  appVersion: string | null;
  metadata: unknown;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationLog {
  id: number;
  paymentAccountId: number | null;
  paymentAccountCode: string | null;
  paymentAccountName: string | null;
  paymentChannel: PaymentChannel | null;
  deviceId: string | null;
  packageName: string | null;
  channel: string | null;
  actualAmount: string | null;
  actualAmountCents: number | null;
  rawText: string;
  matchedOrderId: string | null;
  status: MatchStatus;
  receivedAt: string;
}

export interface CallbackLog {
  id: number;
  orderId: string;
  url: string;
  status: CallbackStatus;
  httpStatus: number | null;
  attempts: number;
  nextRetryAt: string | null;
  error: string | null;
  responseBody: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SystemLog {
  id: number;
  level: LogLevel;
  action: string;
  message: string;
  context: unknown;
  createdAt: string;
}

export interface DashboardStats {
  orders: {
    total: number;
    pending: number;
    paid: number;
    notified: number;
    expired: number;
    paidToday: number;
    successRate: number;
  };
  devices: {
    total: number;
    online: number;
  };
  amountPool: {
    occupied: number;
    presetQrCodes: number;
    fallbackAccounts: number;
  };
  callbacks: {
    pending: number;
    failed: number;
  };
}

export interface CreateOrderInput {
  amount: string | number;
  paymentChannel?: PaymentChannel;
  channel?: PaymentChannel;
  merchantOrderId?: string;
  subject?: string;
  callbackUrl?: string;
  callbackSecret?: string;
  redirectUrl?: string;
  redirect_url?: string;
  returnUrl?: string;
  return_url?: string;
  ttlMinutes?: number;
}

export interface AndroidNotificationInput {
  deviceId?: string;
  paymentChannel?: PaymentChannel;
  channel?: string;
  packageName?: string;
  appPackageName?: string;
  appPackage?: string;
  package?: string;
  amount?: string | number;
  actualAmount?: string | number;
  text?: string;
  rawText?: string;
}

export interface HeartbeatInput {
  name?: string;
  appVersion?: string;
  metadata?: unknown;
}

export interface CreateDeviceEnrollmentInput {
  paymentAccountId?: number;
  paymentAccountCode?: string;
  name?: string;
  ttlMinutes?: number;
}

export interface DeviceEnrollment {
  id: number;
  paymentAccountId: number;
  paymentAccountCode: string;
  paymentAccountName: string;
  paymentChannel: PaymentChannel;
  name: string | null;
  token: string;
  pairingUrl: string;
  expiresAt: string;
  createdAt: string;
}

export interface EnrollDeviceInput {
  enrollmentToken: string;
  deviceId: string;
  name?: string;
  appVersion?: string;
  metadata?: unknown;
}

export interface EnrollDeviceResult {
  device: Device;
  deviceSecret: string;
}

export interface CreatePaymentAccountInput {
  code: string;
  name: string;
  paymentChannel: PaymentChannel;
  priority?: number;
  maxOffsetCents?: number;
  fallbackPayUrl?: string | null;
  notificationKeywords?: string[];
}

export interface UpdatePaymentAccountInput {
  code?: string;
  name?: string;
  paymentChannel?: PaymentChannel;
  priority?: number;
  maxOffsetCents?: number;
  fallbackPayUrl?: string | null;
  notificationKeywords?: string[];
}

export type UpdatePaymentPageSettingsInput = Partial<PaymentPageSettings>;

export interface UpsertPresetQrCodeInput {
  paymentAccountId?: number;
  paymentAccountCode?: string;
  amount: string | number;
  payUrl: string;
}

export interface BulkPresetQrCodeInput {
  paymentAccountId?: number;
  paymentAccountCode?: string;
  items: Array<{
    amount: string | number;
    payUrl: string;
  }>;
}

export interface Page<T> {
  items: T[];
  total: number;
  offset: number;
  limit: number;
}
