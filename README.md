# PeerPay

PeerPay Backend 是 PeerPay 的后端服务，负责订单创建、金额分配、设备配对、到账上报匹配和回调通知。服务端按 Bun fullstack dev server 形态运行：同一个 Bun 进程同时提供管理台 HTML、React bundle 和 `/api/*` 路由。

## 相关仓库

| 仓库 | 说明 |
| --- | --- |
| [peerpay](https://github.com/open-peerpay/peerpay) | 后端服务和管理台，也就是当前仓库 |
| [peerpay-edge-android](https://github.com/open-peerpay/peerpay-edge-android) | 安卓收款监听端，扫码配对后上报到账通知 |
| [peerpay-store-examples](https://github.com/open-peerpay/peerpay-store-examples) | 商品后台示例，用于联调创建订单、展示付款 URL、接收回调和更新订单状态 |

## 快速开始

```bash
bun install
bun run dev
```

服务地址：`http://localhost:3000`

管理台入口默认会在首次启动时随机生成，并打印在终端：

```text
PeerPay admin path: http://localhost:3000/a1b2c3d
```

也可以部署前用环境变量固定：

```bash
ADMIN_PATH=/peerpay1 bun run dev
```

设备配对二维码默认按当前请求地址生成。反向代理或内网部署时，如果 APK 需要访问另一个公网地址，可以显式配置：

```bash
PEERPAY_PUBLIC_URL=https://pay.example.com bun run dev
```

首次打开管理台会进入初始化界面，用于设置管理密码。初始化后，管理台和管理 API 需要登录会话。

## 核心流程

```text
后台生成设备配对码 -> 通用 APK 扫码加入系统 -> 售货系统创建订单 -> 分配唯一实付金额 -> 返回付款 URL -> 用户扫码支付 -> 安卓签名上报到账 -> 匹配 pending 订单 -> 发送回调
```

启动时会自动创建 `default` 账户。账户通过 `maxOffsetCents` 控制金额偏移范围，默认最大偏移为 `10` 分。只有整元订单允许偏移，例如订单金额 `10.00`、最大偏移 `10` 分时，会尝试分配 `10.00` 到 `10.10` 中未被 pending 订单占用的金额；若订单金额为 `10.01`，则只会分配 `10.01`，不会继续偏移到 `10.02`。金额占用按付款方式隔离，当前固定支持 `alipay`（支付宝）和 `wechat`（微信）。

付款 URL 优先使用对应付款方式的定额二维码；若该金额没有预设二维码，则使用该付款方式的账户兜底通用收款码，并要求用户手动输入 `actualAmount`。数据默认写入 `data/peerpay.sqlite`。

## 常用接口

创建订单由售货系统调用，不在后台管理台手动创建：

```bash
curl -X POST http://localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"accountCode":"default","paymentChannel":"alipay","amount":"10.00","merchantOrderId":"m-10001","callbackUrl":"https://merchant.example/webhook","callbackSecret":"secret"}'
```

返回字段里的 `actualAmount` 是用户实际应付金额，`payUrl` 是售货系统展示给用户扫码的 URL：

```json
{
  "requestedAmount": "10.00",
  "actualAmount": "10.05",
  "paymentChannel": "alipay",
  "payMode": "fallback",
  "amountInputRequired": true,
  "payUrl": "https://pay.example/fallback"
}
```

导入定额二维码：

```bash
curl -X POST http://localhost:3000/api/preset-qrcodes \
  -H 'content-type: application/json' \
  -d '{"accountCode":"default","paymentChannel":"alipay","items":[{"amount":"10.00","payUrl":"https://pay.example/alipay/10.00"},{"paymentChannel":"wechat","amount":"10.00","payUrl":"https://pay.example/wechat/10.00"}]}'
```

生成设备配对码需要后台登录。返回的 `pairingUrl` 是一个带当前服务器地址的一次性 URL，管理台会把它渲染成二维码，通用 APK 扫码即可知道要连接哪台私有化服务器：

```bash
curl -X POST http://localhost:3000/api/device-enrollments \
  -H 'content-type: application/json' \
  -d '{"accountCode":"default","name":"主收款机","ttlMinutes":30}'
```

APK 扫码后向 `pairingUrl` 发起注册，服务端只返回一次 `deviceSecret`。APK 需要本地保存该密钥，后续心跳和到账上报都用它签名：

```bash
curl -X POST 'http://localhost:3000/api/android/enroll?token=PAIRING_TOKEN' \
  -H 'content-type: application/json' \
  -d '{"deviceId":"android-main","name":"主收款机","appVersion":"0.1.0"}'
```

安卓到账上报需要携带设备签名头：

```bash
curl -X POST http://localhost:3000/api/android/notifications \
  -H 'content-type: application/json' \
  -H 'x-peerpay-device-id: android-main' \
  -H 'x-peerpay-timestamp: TIMESTAMP' \
  -H 'x-peerpay-nonce: NONCE' \
  -H 'x-peerpay-signature: SIGNATURE' \
  -d '{"packageName":"com.eg.android.AlipayGphone","actualAmount":"10.00","rawText":"支付宝到账 10.00 元"}'
```

安卓通知也可以直接传 `paymentChannel`/`channel`。若传 `packageName`，服务端会把 `com.eg.android.AlipayGphone` 识别为支付宝，把 `com.tencent.mm` 识别为微信，同一台安卓客户端可同时上报两个 App 的通知。

安卓心跳：

```bash
curl -X POST http://localhost:3000/api/android/heartbeat \
  -H 'content-type: application/json' \
  -H 'x-peerpay-device-id: android-main' \
  -H 'x-peerpay-timestamp: TIMESTAMP' \
  -H 'x-peerpay-nonce: NONCE' \
  -H 'x-peerpay-signature: SIGNATURE' \
  -d '{"name":"主收款机","appVersion":"0.1.0"}'
```

安卓请求签名算法为 HMAC-SHA256 hex。待签名内容按以下 5 行拼接，密钥为配对接口返回的 `deviceSecret`：

```text
HTTP_METHOD
URL_PATH
TIMESTAMP
NONCE
SHA256_BODY_HEX
```

其中 `URL_PATH` 示例为 `/api/android/notifications`，`TIMESTAMP` 为秒级时间戳，`NONCE` 在 5 分钟窗口内不能重复。

## 脚本

```bash
bun run dev        # 开发服务
bun run test       # 单元测试
bun run typecheck  # TypeScript 检查
bun run build      # Bun 生产构建
```

## 回调签名

回调请求体包含 `sign` 字段，同时在 `x-peerpay-signature` 头里携带同一个签名。签名算法为 HMAC-SHA256，按字段名排序后拼接 `key=value` 计算，密钥优先使用订单的 `callbackSecret`，否则使用 `PEERPAY_WEBHOOK_SECRET`。
