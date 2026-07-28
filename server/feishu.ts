import type { Order, PaymentChannel } from "../src/shared/types";

export type FeishuWebhookFetch = (
  input: string | URL | Request,
  init?: RequestInit
) => Promise<Response>;

interface FeishuWebhookResponse {
  code?: number;
  msg?: string;
  StatusCode?: number;
  StatusMessage?: string;
}

export interface FeishuNotificationResult {
  ok: boolean;
  httpStatus: number;
  responseBody: string;
  error: string | null;
}

function escapeLarkMarkdown(value: string) {
  return value.replace(/[\\`*_~[\]]/g, "\\$&");
}

function displayValue(value: string | null | undefined) {
  return escapeLarkMarkdown(value?.trim() || "-");
}

function paymentChannelName(channel: PaymentChannel) {
  return channel === "alipay" ? "支付宝" : "微信";
}

function field(label: string, value: string) {
  return {
    is_short: true,
    text: {
      tag: "lark_md",
      content: `**${label}**\n${displayValue(value)}`
    }
  };
}

export function buildFeishuOrderCreatedCard(order: Order) {
  return {
    msg_type: "interactive",
    card: {
      config: {
        wide_screen_mode: true
      },
      header: {
        template: "blue",
        title: {
          tag: "plain_text",
          content: `PeerPay 新订单 ¥${order.actualAmount}`
        }
      },
      elements: [
        {
          tag: "div",
          fields: [
            field("订单号", order.id),
            field("商户订单号", order.merchantOrderId ?? "-"),
            field("应付金额", `¥${order.actualAmount}`),
            field("订单金额", `¥${order.requestedAmount}`),
            field("支付方式", paymentChannelName(order.paymentChannel)),
            field("收款账号", `${order.paymentAccountName} (${order.paymentAccountCode})`),
            field("商品/主题", order.subject ?? "-"),
            field("过期时间", order.expireAt)
          ]
        },
        {
          tag: "hr"
        },
        {
          tag: "note",
          elements: [
            {
              tag: "plain_text",
              content: `创建时间：${order.createdAt}`
            }
          ]
        }
      ]
    }
  };
}

export function buildFeishuOrderPaidCard(order: Order) {
  return {
    msg_type: "interactive",
    card: {
      config: {
        wide_screen_mode: true
      },
      header: {
        template: "green",
        title: {
          tag: "plain_text",
          content: `PeerPay 订单已支付 ¥${order.actualAmount}`
        }
      },
      elements: [
        {
          tag: "div",
          fields: [
            field("订单号", order.id),
            field("商户订单号", order.merchantOrderId ?? "-"),
            field("实付金额", `¥${order.actualAmount}`),
            field("订单金额", `¥${order.requestedAmount}`),
            field("支付方式", paymentChannelName(order.paymentChannel)),
            field("收款账号", `${order.paymentAccountName} (${order.paymentAccountCode})`),
            field("商品/主题", order.subject ?? "-"),
            field("支付时间", order.paidAt ?? "-")
          ]
        },
        {
          tag: "hr"
        },
        {
          tag: "note",
          elements: [
            {
              tag: "plain_text",
              content: "订单款项已到账"
            }
          ]
        }
      ]
    }
  };
}

function parseWebhookResponse(responseBody: string) {
  if (!responseBody) {
    return null;
  }
  try {
    return JSON.parse(responseBody) as FeishuWebhookResponse;
  } catch {
    return null;
  }
}

async function sendFeishuNotification(
  webhookUrl: string,
  card: ReturnType<typeof buildFeishuOrderCreatedCard>,
  fetchImpl: FeishuWebhookFetch = fetch
): Promise<FeishuNotificationResult> {
  const response = await fetchImpl(webhookUrl, {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify(card),
    signal: AbortSignal.timeout(10_000)
  });
  const responseBody = (await response.text()).slice(0, 2000);
  const payload = parseWebhookResponse(responseBody);
  const businessCode = payload?.code ?? payload?.StatusCode;
  const ok = response.ok && (businessCode === undefined || businessCode === 0);
  const error = ok
    ? null
    : payload?.msg
      ?? payload?.StatusMessage
      ?? `飞书 Webhook 响应异常（HTTP ${response.status}）`;

  return {
    ok,
    httpStatus: response.status,
    responseBody,
    error
  };
}

export function sendFeishuOrderCreatedNotification(
  webhookUrl: string,
  order: Order,
  fetchImpl: FeishuWebhookFetch = fetch
) {
  return sendFeishuNotification(
    webhookUrl,
    buildFeishuOrderCreatedCard(order),
    fetchImpl
  );
}

export function sendFeishuOrderPaidNotification(
  webhookUrl: string,
  order: Order,
  fetchImpl: FeishuWebhookFetch = fetch
) {
  return sendFeishuNotification(
    webhookUrl,
    buildFeishuOrderPaidCard(order),
    fetchImpl
  );
}
