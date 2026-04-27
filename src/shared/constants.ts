export const DEFAULT_MAX_OFFSET_CENTS = 10;
export const DEFAULT_PAYMENT_CHANNEL = "alipay";
export const PAYMENT_CHANNEL_OPTIONS = [
  { value: "alipay", label: "支付宝" },
  { value: "wechat", label: "微信" }
] as const;
export const PAYMENT_CHANNEL_LABELS: Record<string, string> = {
  alipay: "支付宝",
  wechat: "微信"
};
