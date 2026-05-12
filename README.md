# PeerPay

PeerPay Backend 是 PeerPay 的后端服务，负责订单创建、金额分配、设备配对、到账上报匹配和回调通知。服务端按 Bun fullstack dev server 形态运行：同一个 Bun 进程同时提供管理台 HTML、React bundle 和 `/api/*` 路由。

## 相关仓库

| 仓库 | 说明 |
| --- | --- |
| [peerpay](https://github.com/open-peerpay/peerpay) | 后端服务和管理台，也就是当前仓库 |
| [peerpay-edge-android](https://github.com/open-peerpay/peerpay-edge-android) | 安卓收款监听端，扫码配对后上报到账通知 |
| [peerpay-store](https://github.com/open-peerpay/peerpay-store) | 开源一口价商店，支持商品上架、匿名下单、PeerPay 付款、自动发货和自助查询 |

## 对接文档

- [Store 支付对接文档](docs/store-payment-integration.md)

## EasyPay 兼容层

PeerPay 已兼容常见易支付（EasyPay/彩虹易支付）对接格式。兼容层只负责协议适配，PeerPay 原生 `/api/orders` JSON 接口会继续保留；底层仍复用 PeerPay 的订单、收款账号池、到账匹配和状态机。

适合这些场景：

- 现有网站、NewAPI、发卡系统或商城已经集成易支付接口。
- 不想为 PeerPay 单独开发新支付插件。
- 希望继续使用易支付的 `pid/key/sign`、`notify_url`、`return_url` 对接模型。

启用前配置一个单商户 `pid/key`：

```bash
EASYPAY_PID=20220715225121
EASYPAY_KEY=replace-with-merchant-key
```

已兼容接口：

| 场景 | 方法 | 地址 |
| --- | --- | --- |
| 页面跳转支付 | `GET`/`POST` | `/submit.php` |
| API 接口支付 | `POST` | `/mapi.php` |
| 查询单个订单 | `GET`/`POST` | `/api.php?act=order` |

兼容规则：

- `type=alipay` 映射为支付宝，`type=wxpay` 映射为微信。
- `out_trade_no` 映射为商户订单号，重复请求会复用同一 PeerPay 订单；若同一 `out_trade_no` 的金额、商品名或支付方式不一致，会返回错误。
- `mapi.php` 返回 PeerPay 付款页 `payurl`，由 PeerPay 页面展示实际应付金额，避免金额防撞偏移后商户页面展示错误金额。
- `notify_url` 是服务器异步通知地址，支付成功后 PeerPay 按易支付 GET 参数通知商户；商户响应正文包含 `success` 才视为通知成功。
- `return_url` 是用户浏览器同步跳转地址，支付成功后会携带 `pid/name/money/out_trade_no/trade_no/param/trade_status/type/sign/sign_type` 参数跳回商户页面。
- 签名算法为易支付 MD5：去除 `sign`、`sign_type` 和空值，按参数名 ASCII 升序拼接 `a=b&c=d`，末尾拼接 `EASYPAY_KEY` 后取小写 MD5。

暂不兼容 `balance` 和 `refund`，因为 PeerPay 当前没有真实余额账户和上游退款执行能力。

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

设备配对二维码和订单支付页 URL 默认按当前请求地址生成。反向代理部署时，请确保代理传入的外部访问地址就是 APK 和用户可以访问的地址。

首次打开管理台会进入初始化界面，用于设置管理密码。初始化后，管理台和管理 API 需要登录会话。

## 核心流程

```text
后台生成设备配对码 -> 通用 APK 扫码加入系统 -> 售货系统创建订单 -> 分配唯一实付金额 -> 返回付款 URL -> 用户扫码支付 -> 安卓签名上报到账 -> 匹配 pending 订单 -> 发送回调
```

PeerPay 使用“收款账号池”模型。每个收款账号只属于一种付款方式：`alipay`（支付宝）或 `wechat`（微信）。多个支付宝账号、多个微信账号可以并行接单，用来提高同金额并发能力。

创建订单时调用方只传付款方式，不指定具体收款账号。服务端会按收款账号优先级先尝试原金额，所有账号的原金额都占用后再逐分偏移；同一偏移值内仍按优先级选择。例如支付宝 A/B 两个账号连续创建 `10.00` 订单，分配顺序是 `A 10.00`、`B 10.00`、`A 10.01`。

`maxOffsetCents` 控制最大偏移范围，默认最大偏移为 `10` 分。只有整元订单允许偏移；若订单金额为 `10.01`，只会在账号池内分配 `10.01`，不会偏移到 `10.02`。金额占用按 `paymentAccountId + actualAmountCents` 隔离，微信和支付宝互不冲突，金额内部以分为最小单位存储。

付款 URL 优先使用该收款账号对应金额且已检查的定额二维码；若该金额没有已检查的预设二维码，则使用该收款账号的兜底通用收款码，并要求用户手动输入 `actualAmount`。没有可用定额码且没有兜底码的收款账号会被分配逻辑跳过。

每个收款账号可以配置到账通知模板。模板仍通过 `notificationKeywords` 字段传递，每条模板必须且只能包含一个金额宏 `__AMOUNT__`，例如 `成功收款__AMOUNT__元`。安卓通知未直接传 `actualAmount` 时，服务端只会从命中的模板宏位置提取金额，不再从全文猜测第一个金额。单个模板最多 200 个字符，最多 30 个模板。

例如同一台设备绑定 `wechat-a` 和 `wechat-b` 后，可以给 `wechat-a` 配置 `["微信收款助手: [店员消息]收款到账__AMOUNT__元"]`，给 `wechat-b` 配置 `["微信支付: 个人收款码到账¥__AMOUNT__"]`。两笔同为 `1.00` 的微信订单会分别匹配：

```text
android.app.Notification 微信收款助手: [店员消息]收款到账1.00元
android.app.Notification 微信支付: 个人收款码到账¥1.00
```

数据默认写入 `data/peerpay.sqlite`。本版重构不迁移旧开发库；如果启动时报旧版 `accounts` 结构不兼容，请删除 `data/peerpay.sqlite*` 后重新启动。

## 常用接口

先在管理台创建收款账号，也可以用管理 API 创建：

```bash
curl -X POST http://localhost:3000/api/payment-accounts \
  -H 'content-type: application/json' \
  -d '{"code":"alipay-a","name":"支付宝 A","paymentChannel":"alipay","priority":10,"maxOffsetCents":10,"fallbackPayUrl":"https://pay.example/alipay-a","notificationKeywords":["支付宝 A 到账 __AMOUNT__ 元"]}'
```

创建订单由售货系统调用，不在后台管理台手动创建。调用方只指定付款方式，服务端自动分配具体收款账号：

```bash
curl -X POST http://localhost:3000/api/orders \
  -H 'content-type: application/json' \
  -d '{"paymentChannel":"alipay","amount":"10.00","merchantOrderId":"m-10001","callbackUrl":"https://merchant.example/webhook","callbackSecret":"secret","redirectUrl":"https://merchant.example/orders/m-10001/result"}'
```

返回字段里的 `paymentAccountCode` 是实际分配的收款账号，`actualAmount` 是用户实际应付金额，`payUrl` 是售货系统展示给用户扫码的 URL。传入 `redirectUrl` 后，PeerPay 付款页在确认支付成功后会自动跳回该商户地址；创建订单时也兼容旧字段名 `redirect_url`、`returnUrl`、`return_url`：

```json
{
  "paymentAccountCode": "alipay-a",
  "requestedAmount": "10.00",
  "actualAmount": "10.05",
  "paymentChannel": "alipay",
  "payMode": "fallback",
  "amountInputRequired": true,
  "payUrl": "https://pay.example/pay/ord_xxx",
  "redirectUrl": "https://merchant.example/orders/m-10001/result"
}
```

导入定额二维码。新导入或 URL 变更后的定额码默认未检查，确认二维码可用后需在后台标记为已检查，才会参与订单分配：

```bash
curl -X POST http://localhost:3000/api/preset-qrcodes \
  -H 'content-type: application/json' \
  -d '{"paymentAccountCode":"alipay-a","items":[{"amount":"10.00","payUrl":"https://pay.example/alipay-a/10.00"},{"amount":"10.01","payUrl":"https://pay.example/alipay-a/10.01"}]}'
```

定额二维码归属于具体收款账号，不再单独选择付款方式。

生成设备配对码需要后台登录，并绑定到具体收款账号。同一个安卓 `deviceId` 可以多次扫码，绑定多个支付宝或微信收款账号。返回的 `pairingUrl` 是一个带当前服务器地址的一次性 URL，管理台会把它渲染成二维码，通用 APK 扫码即可知道要连接哪台私有化服务器：

```bash
curl -X POST http://localhost:3000/api/device-enrollments \
  -H 'content-type: application/json' \
  -d '{"paymentAccountCode":"alipay-a","name":"主收款机","ttlMinutes":30}'
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
  -d '{"packageName":"com.eg.android.alipaygphone","actualAmount":"10.00","rawText":"支付宝到账 10.00 元"}'
```

安卓通知也可以直接传 `paymentChannel`/`channel`。若传 `packageName`，服务端会把 `com.eg.android.alipaygphone` 识别为支付宝，把 `com.tencent.mm` 识别为微信。同一台安卓客户端可同时监听多个 App，服务端只会在该设备已绑定的、同付款方式、且通知模板命中的收款账号范围内按金额匹配 pending 订单。

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

回调请求体包含 `sign` 字段，同时在 `x-peerpay-signature` 头里携带同一个签名。创建订单时如果传入 `callbackUrl`，必须同时传入 `callbackSecret`。签名算法为 HMAC-SHA256，按字段名排序后拼接 `key=value` 计算，密钥使用订单的 `callbackSecret`。回调 payload 会携带 `paymentChannel` 和 `paymentAccountCode`，便于上游排查实际收款账号。
