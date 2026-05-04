# PeerPay

PeerPay 是一套面向个人和小团队自部署场景的收款协作系统，重点服务中国用户常见的支付宝、微信收款流程。它由后端服务、安卓边缘端和开源商店项目组成，用来完成订单创建、收款通知识别、签名上报、回调发货和异常介入。

## 仓库

| 仓库 | 说明 |
| --- | --- |
| [peerpay](https://github.com/open-peerpay/peerpay) | PeerPay 后端和管理后台，负责订单创建、收款账号分配、安卓设备配对、到账通知匹配和商户回调 |
| [peerpay-edge-android](https://github.com/open-peerpay/peerpay-edge-android) | 安卓边缘端，运行在收款设备上，监听支付宝/微信到账通知并签名上报给 PeerPay 后端 |
| [peerpay-store](https://github.com/open-peerpay/peerpay-store) | 开源一口价商店，内置 SQLite，支持商品上架、匿名下单、PeerPay 付款、卡密自动发货、动态上游取货、自助提货和订单查询 |

## 系统流程

```text
用户在商店下单
  -> peerpay-store 创建本地订单
  -> PeerPay 创建支付订单并分配收款方式
  -> 安卓边缘端监听支付宝/微信到账通知
  -> PeerPay 验证并匹配到账
  -> peerpay-store 接收回调并自动发货或标记人工处理
```

## 快速体验顺序

1. 启动 `peerpay` 后端并进入管理后台。
2. 安装并配对 `peerpay-edge-android`。
3. 启动 `peerpay-store`，在后台配置 PeerPay 服务地址和商品。
4. 从商店首页下单，跳转 PeerPay 完成付款。
5. PeerPay 收到安卓端到账通知后回调商店，商店完成发货或记录异常。

## 适用场景

- 小规模数字商品、卡密、会员兑换码等一口价售卖。
- 需要自部署、可审计、可二次开发的收款链路。
- 需要把支付宝/微信到账通知和业务订单自动关联，并在异常时保留人工介入入口。
