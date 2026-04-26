# PeerPay

PeerPay 是一个 Bun + SQLite + React + Ant Design 的轻量级收款服务骨架。服务端按 Bun fullstack dev server 形态运行：同一个 Bun 进程同时提供管理台 HTML、React bundle 和 `/api/*` 路由。

## 快速开始

```bash
bun install
bun run dev
```

服务地址：`http://localhost:3000`

管理台入口默认会在首次启动时随机生成，并打印在终端：

```text
PeerPay admin path: http://localhost:3000/admin-xxxxxxxxxxxxxxxxxx
```

也可以部署前用环境变量固定：

```bash
ADMIN_PATH=/admin-peerpay bun run dev
```

首次打开管理台会进入初始化界面，用于设置管理密码。初始化后，管理台和管理 API 需要登录会话。

## 核心流程

```text
创建订单 -> 分配唯一实付金额 -> 返回付款 URL -> 用户扫码支付 -> 安卓上报到账 -> 匹配 pending 订单 -> 发送回调
```

启动时会自动创建 `default` 账户。账户通过 `maxOffsetCents` 控制金额偏移范围，例如订单金额 `10.00`、最大偏移 `99` 分时，会尝试分配 `10.00` 到 `10.99` 中未被 pending 订单占用的金额。

付款 URL 优先使用定额二维码；若该金额没有预设二维码，则使用账户兜底通用收款码，并要求用户手动输入 `actualAmount`。数据默认写入 `data/peerpay.sqlite`。

## 常用接口

创建订单：

```bash
curl -X POST http://localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"accountCode":"default","amount":"10.00","merchantOrderId":"m-10001","callbackUrl":"https://merchant.example/webhook","callbackSecret":"secret"}'
```

返回字段里的 `actualAmount` 是用户实际应付金额，`payUrl` 是售货系统展示给用户扫码的 URL：

```json
{
  "requestedAmount": "10.00",
  "actualAmount": "10.05",
  "payMode": "fallback",
  "amountInputRequired": true,
  "payUrl": "https://pay.example/fallback"
}
```

导入定额二维码：

```bash
curl -X POST http://localhost:3000/api/preset-qrcodes \
  -H 'content-type: application/json' \
  -d '{"accountCode":"default","items":[{"amount":"10.00","payUrl":"https://pay.example/10.00"},{"amount":"10.01","payUrl":"https://pay.example/10.01"}]}'
```

安卓到账上报：

```bash
curl -X POST http://localhost:3000/api/android/notifications \
  -H 'content-type: application/json' \
  -d '{"accountCode":"default","deviceId":"android-main","channel":"alipay","actualAmount":"10.00","rawText":"支付宝到账 10.00 元"}'
```

安卓心跳：

```bash
curl -X POST http://localhost:3000/api/android/heartbeat \
  -H 'content-type: application/json' \
  -d '{"accountCode":"default","deviceId":"android-main","name":"主收款机","appVersion":"0.1.0"}'
```

## 脚本

```bash
bun run dev        # 开发服务
bun run test       # 单元测试
bun run typecheck  # TypeScript 检查
bun run build      # Bun 生产构建
```

## 回调签名

回调请求体包含 `sign` 字段，同时在 `x-peerpay-signature` 头里携带同一个签名。签名算法为 HMAC-SHA256，按字段名排序后拼接 `key=value` 计算，密钥优先使用订单的 `callbackSecret`，否则使用 `PEERPAY_WEBHOOK_SECRET`。
