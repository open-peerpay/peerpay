export type OrderStatus = "pending" | "paid" | "notified" | "expired";
export type LogLevel = "info" | "warn" | "error";
export type MatchStatus = "matched" | "unmatched" | "parse_failed";
export type CallbackStatus = "pending" | "success" | "failed";
export type PayMode = "preset" | "fallback";
export type PaymentChannel = "wechat" | "alipay";

export interface Account {
  id: number;
  code: string;
  name: string;
  enabled: boolean;
  maxOffsetCents: number;
  maxOffset: string;
  fallbackPayUrl: string | null;
  alipayFallbackPayUrl: string | null;
  wechatFallbackPayUrl: string | null;
  createdAt: string;
}

export interface PresetQrCode {
  id: number;
  accountId: number;
  accountCode: string;
  paymentChannel: PaymentChannel;
  amount: string;
  amountCents: number;
  payUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface AmountOccupation {
  orderId: string;
  accountId: number;
  accountCode: string;
  actualAmount: string;
  actualAmountCents: number;
  requestedAmount: string;
  paymentChannel: PaymentChannel;
  status: OrderStatus;
  expireAt: string;
  payMode: PayMode;
}

export interface Order {
  id: string;
  merchantOrderId: string | null;
  accountId: number;
  accountCode: string;
  requestedAmount: string;
  requestedAmountCents: number;
  actualAmount: string;
  actualAmountCents: number;
  paymentChannel: PaymentChannel;
  payUrl: string;
  payMode: PayMode;
  amountInputRequired: boolean;
  status: OrderStatus;
  subject: string | null;
  callbackUrl: string | null;
  expireAt: string;
  paidAt: string | null;
  notifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Device {
  id: number;
  deviceId: string;
  name: string | null;
  accountId: number | null;
  accountCode: string | null;
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
  accountId: number;
  accountCode: string;
  deviceId: string | null;
  paymentChannel: PaymentChannel | null;
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
  accountId?: number;
  accountCode?: string;
  paymentChannel?: PaymentChannel;
  channel?: PaymentChannel;
  merchantOrderId?: string;
  subject?: string;
  callbackUrl?: string;
  callbackSecret?: string;
  ttlMinutes?: number;
}

export interface AndroidNotificationInput {
  deviceId?: string;
  accountId?: number;
  accountCode?: string;
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
  accountId?: number;
  accountCode?: string;
  name?: string;
  ttlMinutes?: number;
}

export interface DeviceEnrollment {
  id: number;
  accountId: number;
  accountCode: string;
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

export interface UpdateAccountSettingsInput {
  maxOffsetCents?: number;
  fallbackPayUrl?: string | null;
  alipayFallbackPayUrl?: string | null;
  wechatFallbackPayUrl?: string | null;
}

export interface UpsertPresetQrCodeInput {
  accountId?: number;
  accountCode?: string;
  paymentChannel?: PaymentChannel;
  channel?: PaymentChannel;
  amount: string | number;
  payUrl: string;
}

export interface BulkPresetQrCodeInput {
  accountId?: number;
  accountCode?: string;
  paymentChannel?: PaymentChannel;
  channel?: PaymentChannel;
  items: Array<{
    paymentChannel?: PaymentChannel;
    channel?: PaymentChannel;
    amount: string | number;
    payUrl: string;
  }>;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
