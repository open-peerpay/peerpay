# PeerPay GitHub 开源结构

`github.com/peerpay` 已经被其他账号占用。当前推荐尝试使用 `open-peerpay` 作为 PeerPay 的 GitHub Organization：

```text
github.com/open-peerpay
├── peerpay
├── peerpay-edge-android
└── peerpay-store
```

如果 `open-peerpay` 创建时提示已被占用，可以改用 `peerpay-project` 或 `peerpay-dev`，然后把本文档里的 owner 统一替换掉。

## 仓库职责

| 仓库 | 职责 |
| --- | --- |
| `peerpay` | 后端服务、管理台、订单创建 API、安卓配对和到账匹配 |
| `peerpay-edge-android` | 安卓端收款监听、设备配对、签名上报到账通知 |
| `peerpay-store` | 开源一口价商店，内置 SQLite，支持商品上架、匿名下单、PeerPay 付款、卡密自动发货、动态上游取货、自助提货和订单查询 |

## 组织首页

在 `open-peerpay` organization 下创建一个特殊仓库：

```text
open-peerpay/.github
```

然后把 [github-profile-readme.md](./github-profile-readme.md) 的内容放到这个仓库的：

```text
profile/README.md
```

GitHub 会把这个文件显示在 `https://github.com/open-peerpay` 的组织首页。

## 本地仓库布局

本地建议三个项目平级放置，每个项目都是独立 Git 仓库：

```text
workspace/
├── peerpay/
├── peerpay-edge-android/
└── peerpay-store/
```

每个仓库独立维护自己的 `.git`、`origin`、分支、tag、issue 和 release。

## 推送方式

是的，本地是独立推送。每个仓库进入自己的目录后单独推送：

```bash
cd peerpay
git remote add open-peerpay git@github.com:open-peerpay/peerpay.git
git push -u open-peerpay main
```

如果确定要把当前仓库的默认推送目标切到 organization，再执行：

```bash
git remote set-url origin git@github.com:open-peerpay/peerpay.git
git push -u origin main
```

```bash
cd ../peerpay-edge-android
git remote add origin git@github.com:open-peerpay/peerpay-edge-android.git
git push -u origin main
```

```bash
cd ../peerpay-store
git remote add origin git@github.com:open-peerpay/peerpay-store.git
git push -u origin main
```

如果本地默认分支不是 `main`，先用下面命令确认：

```bash
git branch --show-current
```

然后把上面命令里的 `main` 替换成实际分支名。

## README 互链

三个仓库的 README 顶部都建议放同一张表：

```md
## PeerPay 仓库

| 仓库 | 说明 |
| --- | --- |
| [peerpay](https://github.com/open-peerpay/peerpay) | PeerPay 后端和管理后台，负责订单创建、收款账号分配、安卓设备配对、到账通知匹配和商户回调 |
| [peerpay-edge-android](https://github.com/open-peerpay/peerpay-edge-android) | 安卓边缘端，监听支付宝/微信到账通知并签名上报给 PeerPay 后端 |
| [peerpay-store](https://github.com/open-peerpay/peerpay-store) | 开源一口价商店，支持商品上架、匿名下单、PeerPay 付款、自动发货和自助查询 |
```

## 当前仓库迁移

当前后端仓库的 `origin` 可以先保留在个人账号仓库，新增一个 organization remote 用来推送：

```bash
git remote -v
git remote add open-peerpay git@github.com:open-peerpay/peerpay.git
git push -u open-peerpay main
```

确认 organization 仓库正常后，再把 `origin` 切过去：

```bash
git remote set-url origin git@github.com:open-peerpay/peerpay.git
git push -u origin main
```

这样三个仓库都会归在 `open-peerpay` 组织下，用户进入组织页就能看到 PeerPay 的完整项目集合。
