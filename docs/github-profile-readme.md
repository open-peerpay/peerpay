# PeerPay

PeerPay is a lightweight payment coordination system for private deployments. It connects a backend service, an Android edge client, and merchant-side examples for end-to-end order and payment notification testing.

## Repositories

| Repository | Description |
| --- | --- |
| [peerpay](https://github.com/open-peerpay/peerpay) | Backend API, admin console, order allocation, Android enrollment, payment notification matching, and webhook delivery |
| [peerpay-edge-android](https://github.com/open-peerpay/peerpay-edge-android) | Android edge client that listens for payment notifications and reports signed payment events to the backend |
| [peerpay-store-examples](https://github.com/open-peerpay/peerpay-store-examples) | Example merchant backend for creating orders, displaying payment URLs, receiving callbacks, and updating order status |

## System Flow

```text
Merchant Store Example
  -> PeerPay Backend
  -> Android Edge Client
  -> Payment App Notification
  -> PeerPay Backend
  -> Merchant Callback
```

## Quick Start Order

1. Start `peerpay`.
2. Pair `peerpay-edge-android` with the backend.
3. Run `peerpay-store-examples`.
4. Create an order from the store example and complete the payment notification flow.
