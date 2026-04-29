# PeerPay Store 支付对接文档

本文面向商品后台、商城、售货系统等 store 侧服务。store 只需要负责创建 PeerPay 订单、把付款页展示给用户、接收支付成功回调，并根据回调更新自己的业务订单状态。

## 1. 对接流程

```text
store 创建业务订单
-> store 调用 PeerPay 创建支付订单
-> PeerPay 返回付款页 payUrl 和应付金额
-> store 跳转/展示 PeerPay 付款页
-> 用户扫码付款
-> PeerPay 匹配到账通知并标记 paid
-> PeerPay 付款页自动跳回 store redirectUrl（如已传）
-> PeerPay POST 回调 store callbackUrl
-> store 验签、更新业务订单、返回 2xx
-> PeerPay 标记订单 notified
```

store 侧通常只需要接两个公开能力。创建订单请由 store 后端发起，不要把 `callbackSecret` 放到浏览器或小程序前端。

| 场景 | 方法 | 地址 | 说明 |
| --- | --- | --- | --- |
| 创建支付订单 | `POST` | `/api/orders` | store 后端调用，返回 PeerPay 订单和付款页 URL |
| 查询付款页数据 | `GET` | `/api/pay/:orderId` | 公开付款页使用；自研收银台也可轮询此接口 |

所有 API 都返回 JSON 外壳：

```json
{
  "data": {}
}
```

错误响应也在 `data.error` 中：

```json
{
  "data": {
    "error": "付款方式仅支持微信或支付宝"
  }
}
```

## 2. 接入前准备

PeerPay 管理员需要先在管理台完成这些准备工作：

1. 创建收款账号，例如 `alipay-a`、`wechat-a`。
2. 给账号配置兜底收款码 URL，或导入对应金额的定额二维码。
3. 用安卓监听端扫码配对账号，确保到账通知可以上报。
4. 确认 store 后端能访问 PeerPay 服务地址，例如 `https://pay.example.com`。

store 不需要指定具体收款账号。创建订单时只传付款方式，PeerPay 会自动从账号池里分配一个可用账号和唯一实付金额。

## 3. 创建支付订单

### 请求

```http
POST /api/orders
Content-Type: application/json
```

请求体：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `amount` | `string` 或 `number` | 是 | 业务订单金额，最多两位小数，建议用字符串，例如 `"99.00"` |
| `paymentChannel` | `string` | 是 | `alipay` 或 `wechat`；也兼容字段名 `channel` |
| `merchantOrderId` | `string` | 否 | store 自己的业务订单号，用于回调和排查 |
| `subject` | `string` | 否 | 商品/订单标题，会展示在 PeerPay 付款页 |
| `callbackUrl` | `string` | 否 | 支付成功后 PeerPay 回调 store 的 HTTPS/HTTP 地址 |
| `callbackSecret` | `string` | 条件必填 | 传了 `callbackUrl` 时必须传，用于回调签名 |
| `redirectUrl` | `string` | 否 | 支付页确认成功后浏览器自动跳回的 store 页面，必须是 HTTP/HTTPS 地址；兼容旧字段名 `redirect_url`、`returnUrl`、`return_url` |
| `ttlMinutes` | `number` | 否 | 订单有效期，默认 `15` 分钟，范围会被限制在 `1` 到 `1440` 分钟 |

示例：

```bash
curl -X POST https://pay.example.com/api/orders \
  -H 'content-type: application/json' \
  -d '{
    "paymentChannel": "alipay",
    "amount": "99.00",
    "merchantOrderId": "store-20260428-10001",
    "subject": "会员月卡",
    "callbackUrl": "https://store.example.com/payments/peerpay/callback",
    "callbackSecret": "replace-with-store-order-secret",
    "redirectUrl": "https://store.example.com/orders/store-20260428-10001/result",
    "ttlMinutes": 15
  }'
```

### 响应

成功时 HTTP 状态码为 `201`：

```json
{
  "data": {
    "id": "ord_b4a7c7a69f1e4d568b32d311",
    "merchantOrderId": "store-20260428-10001",
    "paymentAccountId": 1,
    "paymentAccountCode": "alipay-a",
    "paymentAccountName": "支付宝 A",
    "paymentChannel": "alipay",
    "requestedAmount": "99.00",
    "requestedAmountCents": 9900,
    "actualAmount": "99.01",
    "actualAmountCents": 9901,
    "payUrl": "https://pay.example.com/pay/ord_b4a7c7a69f1e4d568b32d311",
    "payMode": "fallback",
    "amountInputRequired": true,
    "status": "pending",
    "subject": "会员月卡",
    "callbackUrl": "https://store.example.com/payments/peerpay/callback",
    "redirectUrl": "https://store.example.com/orders/store-20260428-10001/result",
    "expireAt": "2026-04-28T03:15:00.000Z",
    "paidAt": null,
    "notifiedAt": null,
    "createdAt": "2026-04-28T03:00:00.000Z",
    "updatedAt": "2026-04-28T03:00:00.000Z"
  }
}
```

关键字段：

| 字段 | 说明 |
| --- | --- |
| `id` | PeerPay 订单号，后续回调里的 `orderId` |
| `merchantOrderId` | store 创建订单时传入的业务订单号 |
| `payUrl` | PeerPay 付款页 URL，store 可直接跳转或展示给用户打开 |
| `requestedAmount` | store 原始订单金额 |
| `actualAmount` | 用户实际应付金额，可能因并发防撞被微调 |
| `paymentChannel` | 实际付款方式：`alipay` 或 `wechat` |
| `paymentAccountCode` | PeerPay 实际分配的收款账号编码，便于排查 |
| `payMode` | `preset` 表示定额码，`fallback` 表示通用码 |
| `amountInputRequired` | 为 `true` 时用户必须在付款 App 手动输入 `actualAmount` |
| `status` | `pending`、`paid`、`notified`、`expired` |
| `redirectUrl` | 创建订单时传入的支付成功后浏览器跳转地址，可能为 `null` |
| `expireAt` | 订单过期时间，ISO 8601 字符串 |

注意：`merchantOrderId` 当前用于关联和排查，不做唯一约束，也不提供幂等去重。store 遇到网络超时后应避免盲目重复创建，建议在自己的业务订单中记录 PeerPay `id` 和 `payUrl`。

## 4. 展示付款页

推荐 store 直接使用创建订单响应里的 `payUrl`，把用户跳转到 PeerPay 付款页：

```text
https://pay.example.com/pay/ord_b4a7c7a69f1e4d568b32d311
```

PeerPay 付款页会自动：

1. 展示二维码。
2. 展示 `actualAmount`。
3. 在 `amountInputRequired=true` 时提示用户手动输入精确金额。
4. 每 3 秒轮询订单状态，支付成功后展示已支付。
5. 如果创建订单时传了 `redirectUrl`，支付成功后自动跳回该地址。

如果 store 要自研收银台，可以调用付款页数据接口：

```http
GET /api/pay/:orderId
```

响应示例：

```json
{
  "data": {
    "orderId": "ord_b4a7c7a69f1e4d568b32d311",
    "merchantOrderId": "store-20260428-10001",
    "paymentAccountName": "支付宝 A",
    "paymentAccountCode": "alipay-a",
    "paymentChannel": "alipay",
    "requestedAmount": "99.00",
    "actualAmount": "99.01",
    "targetPayUrl": "https://pay.example.com/alipay-a",
    "payMode": "fallback",
    "amountInputRequired": true,
    "status": "pending",
    "subject": "会员月卡",
    "redirectUrl": "https://store.example.com/orders/store-20260428-10001/result",
    "expireAt": "2026-04-28T03:15:00.000Z",
    "notice": null
  }
}
```

自研收银台必须遵守：

1. 二维码内容使用 `targetPayUrl`，不是创建订单返回的 `payUrl`。
2. 页面主金额使用 `actualAmount`，不是 `requestedAmount`。
3. `amountInputRequired=true` 时必须显著提示用户手动输入 `actualAmount`。
4. 订单 `status` 不是 `pending` 后应停止引导付款。

## 5. 支付成功回调

创建订单时传入 `callbackUrl` 后，PeerPay 在匹配到到账通知并把订单标记为 `paid` 时，会向该地址发送 `POST` 请求。

请求头：

```http
Content-Type: application/json
X-PeerPay-Signature: <sign>
```

请求体：

```json
{
  "orderId": "ord_b4a7c7a69f1e4d568b32d311",
  "merchantOrderId": "store-20260428-10001",
  "paymentAccountCode": "alipay-a",
  "paymentChannel": "alipay",
  "status": "paid",
  "requestedAmount": "99.00",
  "actualAmount": "99.01",
  "paidAt": "2026-04-28T03:02:10.000Z",
  "sign": "4b1a..."
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `orderId` | PeerPay 订单号 |
| `merchantOrderId` | store 业务订单号，可能为 `null` |
| `paymentAccountCode` | 实际收款账号 |
| `paymentChannel` | `alipay` 或 `wechat` |
| `status` | 当前固定为 `paid` |
| `requestedAmount` | store 原始金额 |
| `actualAmount` | 用户实际付款金额 |
| `paidAt` | PeerPay 匹配到账时间 |
| `sign` | 回调签名 |

store 回调处理建议：

1. 先验签，签名不通过直接返回 `401` 或 `400`。
2. 用 `merchantOrderId` 或 `orderId` 找到本地业务订单。
3. 校验本地订单金额与 `requestedAmount` 一致。
4. 校验本地记录的 PeerPay `orderId` 与回调 `orderId` 一致。
5. 幂等更新业务订单为已支付。
6. 返回任意 `2xx` 状态码表示回调成功。

PeerPay 只有在收到 `2xx` 响应后才会把订单状态从 `paid` 更新为 `notified`。非 `2xx` 或请求异常会记为失败并重试，默认最多尝试 5 次。

## 6. 回调签名算法

签名算法为 `HMAC-SHA256`，输出小写 hex。密钥是创建订单时传入的 `callbackSecret`。

计算步骤：

1. 从请求体中取出除 `sign` 以外的所有字段。
2. 按字段名升序排序。
3. 拼接成 `key=value`，字段之间用 `&` 连接；`null` 按空字符串处理。
4. 使用 `callbackSecret` 计算 HMAC-SHA256 hex。
5. 同时校验 body 里的 `sign` 和请求头 `x-peerpay-signature`。

以上面回调为例，待签名字符串类似：

```text
actualAmount=99.01&merchantOrderId=store-20260428-10001&orderId=ord_b4a7c7a69f1e4d568b32d311&paidAt=2026-04-28T03:02:10.000Z&paymentAccountCode=alipay-a&paymentChannel=alipay&requestedAmount=99.00&status=paid
```

Node.js 验签示例：

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function signPeerPayPayload(payload, secret) {
  const canonical = Object.keys(payload)
    .filter((key) => key !== "sign")
    .sort()
    .map((key) => `${key}=${payload[key] ?? ""}`)
    .join("&");

  return createHmac("sha256", secret).update(canonical).digest("hex");
}

function verifyPeerPayCallback(body, headers, secret) {
  const expected = signPeerPayPayload(body, secret);
  const bodySign = body.sign || "";
  const headerSign = headers["x-peerpay-signature"] || "";
  const expectedBuffer = Buffer.from(expected);
  const bodySignBuffer = Buffer.from(bodySign);
  const headerSignBuffer = Buffer.from(headerSign);

  return bodySignBuffer.length === expectedBuffer.length
    && headerSignBuffer.length === expectedBuffer.length
    && timingSafeEqual(expectedBuffer, bodySignBuffer)
    && timingSafeEqual(expectedBuffer, headerSignBuffer);
}
```

PHP 验签示例：

```php
function peerpay_sign(array $payload, string $secret): string {
    unset($payload['sign']);
    ksort($payload);

    $pairs = [];
    foreach ($payload as $key => $value) {
        $pairs[] = $key . '=' . ($value ?? '');
    }

    return hash_hmac('sha256', implode('&', $pairs), $secret);
}

function peerpay_verify(array $body, array $headers, string $secret): bool {
    $expected = peerpay_sign($body, $secret);
    $bodySign = $body['sign'] ?? '';
    $headerSign = $headers['x-peerpay-signature'] ?? $headers['X-PeerPay-Signature'] ?? '';

    return hash_equals($expected, $bodySign) && hash_equals($expected, $headerSign);
}
```

## 7. 状态机

| 状态 | 含义 | store 处理 |
| --- | --- | --- |
| `pending` | 等待用户付款 | 继续展示付款页或等待回调 |
| `paid` | PeerPay 已匹配到账，但回调尚未成功 | store 可能已收到回调或等待重试 |
| `notified` | 回调已收到 `2xx` 响应 | store 应已完成业务订单更新 |
| `expired` | 超过有效期未支付，金额占用已释放 | store 可提示重新下单或重新创建支付订单 |

store 以回调为准更新业务订单。自研收银台轮询到 `paid` 或 `notified` 时，只能用于用户界面提示，不建议单独作为发货依据。

## 8. 常见错误

| HTTP 状态码 | 场景 | 处理建议 |
| --- | --- | --- |
| `400` | 金额格式无效、付款方式不支持、传了 `callbackUrl` 但缺少 `callbackSecret` | 修正请求参数 |
| `404` | 查询的 PeerPay 订单不存在 | 检查 `orderId` 或重新创建支付订单 |
| `409` | 没有可用收款账号，或该金额在偏移范围内已被占满 | 稍后重试、切换付款方式，或让管理员增加账号/二维码/偏移范围 |
| `500` | 服务端内部错误 | 保留业务订单为待支付，稍后重试或人工排查 |

## 9. Store 接入清单

上线前请确认：

1. store 后端调用的是 PeerPay 外部可访问域名，返回的 `payUrl` 用户也能打开。
2. 每个业务订单保存了 PeerPay `id`、`payUrl`、`actualAmount`、`paymentChannel`。
3. 回调接口支持幂等，重复回调不会重复发货、重复加余额或重复核销。
4. 回调验签使用订单对应的 `callbackSecret`。
5. 自研收银台使用 `targetPayUrl` 生成二维码，并展示 `actualAmount`。
6. `expired` 后不会继续引导用户付款旧订单。
7. 生产环境限制 `/api/orders` 的调用来源，例如只允许 store 后端或内网/API 网关访问。
