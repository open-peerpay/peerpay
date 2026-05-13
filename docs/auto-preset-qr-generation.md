# 自动生成定额二维码设计

## 服务端流程

1. 管理台在「自动生成任务」页创建自动生成任务。
2. 输入收款账号、多个整数金额（元）和偏移数量，默认偏移数量为 10。
3. 服务端把每个整数金额展开为分级金额，例如 `10` + 偏移 `10` 展开为 `10.00` 到 `10.09`。
4. 展开后的每个金额写入 `preset_qr_generation_items`，初始状态为 `pending`。
5. Android 设备通过任务长连接接收任务明细；手动心跳接口保留为兼容和诊断入口。
6. Android 上报成功结果后，服务端直接写入 `preset_qr_codes`，`checked = 0`，`remark = 自动生成`。
7. 人工打开检查开关后，该定额码才会参与订单分配。
8. 非执行中的任务可删除；失败任务可重试；待执行或执行中的任务可停止。

## 任务长连接

Android 常驻服务建立长连接：

```text
POST /api/android/task-stream
```

请求体仍是设备心跳元数据，签名规则仍使用现有 Android HMAC。响应为 `application/x-ndjson`，每行一个事件。核心事件：

```json
{
  "type": "heartbeat",
  "time": "2026-05-13T00:00:00.000Z",
  "reason": "connected",
  "device": {
    "deviceId": "android-xxx",
    "presetQrGenerationAssignment": {
      "taskId": 1,
      "paymentAccountCode": "alipay-a",
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
  },
  "presetQrGenerationAssignment": {
    "taskId": 1,
    "paymentAccountCode": "alipay-a",
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

停止事件：

```json
{
  "type": "stop",
  "taskId": 1,
  "reason": "任务已在后台停止"
}
```

没有任务时 `presetQrGenerationAssignment` 为 `null`。`POST /api/android/heartbeat` 继续保留，便于手动触发和旧版本兼容。

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

1. `BackendClient`：建立任务长连接，解析 `heartbeat` / `stop` 事件，并保留结果上报方法。
2. `PresetQrGenerationRunner`：串行消费下发的 `items`，支持后台停止和队列续跑，避免同时操作支付 App。
3. `PaymentAccessibilityService`：提供平台脚本动作，包括启动 App、查找入口、输入金额、点击生成。
4. `QrScreenParser`：支付宝用无障碍截图解析二维码 URL。
5. `GalleryQrReader`：微信点击「保存收款码」后读取最新相册图片并解析二维码 URL。
6. 平台脚本按 `paymentChannel` 分支，支付宝和微信分别维护 package、可访问文本、控件查找规则和超时策略。

执行顺序：

```text
任务长连接拿任务
-> 确认无障碍和相册读取权限
-> 打开对应支付 App
-> 无障碍进入/定位定额收款码页面
-> 输入金额
-> 点击生成/确定
-> 支付宝截图解析；微信保存到相册后解析最新图片
-> 上报 payUrl 或 error
-> 处理下一项
```

服务端已做分配超时保护：下发后 10 分钟未上报会重新排队；同一明细最多尝试 3 次。
