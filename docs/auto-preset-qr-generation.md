# 自动生成定额二维码设计

## 服务端流程

1. 管理台在「定额二维码」页创建自动生成任务。
2. 输入收款账号、多个整数金额（元）和偏移数量，默认偏移数量为 10。
3. 服务端把每个整数金额展开为分级金额，例如 `10` + 偏移 `10` 展开为 `10.00` 到 `10.09`。
4. 展开后的每个金额写入 `preset_qr_generation_items`，初始状态为 `pending`。
5. Android 设备心跳时，服务端只给已绑定该收款账号的设备下发任务明细。
6. Android 上报成功结果后，服务端直接写入 `preset_qr_codes`，`checked = 0`，`remark = 自动生成`。
7. 人工打开检查开关后，该定额码才会参与订单分配。

## 心跳下发

Android 继续请求：

```text
POST /api/android/heartbeat
```

响应里的 `data` 保持设备字段，同时新增：

```json
{
  "presetQrGenerationAssignment": {
    "taskId": 1,
    "paymentAccountId": 10,
    "paymentAccountCode": "alipay-a",
    "paymentAccountName": "支付宝 A",
    "paymentChannel": "alipay",
    "items": [
      {
        "itemId": 100,
        "amount": "10.00",
        "amountCents": 1000,
        "attempts": 1
      }
    ]
  }
}
```

没有任务时该字段为 `null`。

## Android 上报

成功：

```text
POST /api/android/preset-qrcode-generation-results
```

```json
{
  "taskId": 1,
  "itemId": 100,
  "amount": "10.00",
  "payUrl": "https://qr.alipay.com/..."
}
```

失败：

```json
{
  "taskId": 1,
  "itemId": 100,
  "amount": "10.00",
  "error": "未识别到二维码"
}
```

请求签名仍使用现有 Android HMAC 规则。

## Android 执行器建议

Android 端可按以下模块拆分：

1. `BackendClient`：解析心跳里的 `presetQrGenerationAssignment`，并新增结果上报方法。
2. `PresetQrGenerationRunner`：串行消费下发的 `items`，避免同时操作支付 App。
3. `PaymentAccessibilityService`：提供平台脚本动作，包括启动 App、查找入口、输入金额、点击生成。
4. `ScreenCaptureActivity`：申请 `MediaProjection` 录屏权限，把授权结果交给常驻服务。
5. `QrScreenParser`：截图后用 ZXing 从 bitmap 中解析二维码 URL。
6. 平台脚本按 `paymentChannel` 分支，支付宝和微信分别维护 package、可访问文本、控件查找规则和超时策略。

执行顺序：

```text
心跳拿任务
-> 确认无障碍和录屏权限
-> 打开对应支付 App
-> 无障碍进入/定位定额收款码页面
-> 输入金额
-> 点击生成/确定
-> 截图并解析二维码
-> 上报 payUrl 或 error
-> 处理下一项
```

服务端已做分配超时保护：下发后 10 分钟未上报会重新排队；同一明细最多尝试 3 次。
