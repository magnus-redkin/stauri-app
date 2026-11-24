## 什么是 Web3 即时通讯？

消息不经过公司服务器，而是通过点对点网络传递：没有谁能独占整段历史，也没有谁能在路上读取或删除它。

钱包就在同一个应用里，因为消息背后的身份就是持有资金的那把密钥。服务器上没有账号：密钥对本身就是账号。

[完整文档](en/web3im.md)
[Status](https://status.im)

## 什么是 Status 网络？

Status 是一组开源程序——Status 应用、`status-go` 引擎和 Waku 传输层——组成的同一个网络。节点通过启动列表互相发现，并交换封装的讯息；聊天和钱包都走这张网。

Stauri 连接的是与 Status Desktop 相同的网络。因此 Stauri 用户和 Status 用户可以互相发消息：这是一张网，不是两张网之间的桥。

[架构](en/architecture.md)
[Waku](https://waku.org)

## 密码与助记词

这是两个不同的秘密，把二者混淆是失去访问权限最常见的原因。

**密码**只在本设备上加密资料。它永远不会离开手机或电脑，Status 和 Stauri 的任何人都读不到它。

**助记词**——12 个词——是资料和资金的同一把主密钥，可以在任何设备上恢复一切。丢了密码往往还有救：短 PIN 可以打开，助记词可以恢复资料。丢了助记词则无解：没有客服，没有重置，没有例外。

[认证与同步](en/auth_and_sync.md)

## Stauri 与 Status

Stauri 使用与 Status 相同的引擎和相同的网络。区别有两处：技术栈和用词——外加一个对引擎的小补丁，见下文。

**技术栈。** 用 Tauri + Svelte + Tailwind 取代 Nix + Nim/QML。Status 的各模块是用 Nix 构建的单体。Stauri 改动周期短，桌面和 Android 共用一份 Rust 代码。Rust 目前只在 core 模块（与 Tauri 通信）和加密模块中是必需的；其余部分可以用 Go、Nim、Python 或任何语言编写。

**用词。** Stauri 界面中没有「社区」概念：频道即 ACC——作者/频道/评论。Status 的社区变成一个只含单一频道的技术容器；Stauri 隐藏容器，直接把频道显示出来。

还有两点：dApp 区域不仅可以接 Status 的频道，还可以接入其它来源的 RSS，例如 Telegram；更小的二进制也意味着更省电。

[对比](en/comparison.md)
[Status](https://status.im)
[Logos](https://logos.co)

## status-go 补丁

Stauri 构建的是与 Status 相同的引擎——官方 `status-go`——并加入了一处小改动。引擎在启动时读取一次资料列表并常驻内存；我们需要在不重启应用的情况下读取另一张网络的列表。补丁增加了一个关闭该列表的函数，以便为所选网络重新打开它。

共两个文件、约四十行。不触碰任何加密或密钥：被关闭的列表保存的是资料名称和设置，而不是秘密。补丁和完整 diff 均已公开，理由写在旁边，任何人可读。

没有补丁时 Stauri 照样工作；只是切换网络时会要求重启应用。

[补丁说明](https://github.com/magnus-redkin/stauri-app/blob/main/src-tauri/status-go/README.md)
[完整 diff](https://github.com/status-im/status-go/compare/766535cf336416a11a92f46faf4df5ac6af4a0b8...magnus-redkin:status-go:stauri/close-accounts)

## 如何注册 ENS 名称？

ENS 是地址的可读名称：别人看到 `yourname.eth` 而不是一长串字符，并可以向它付款。

在 Stauri 中：打开资料页，选择 ENS 名称，检查是否可用，查看价格并确认。名称注册在 Status 的子域（`yourname.stateofus.eth`）下，属于您的地址。费用为每年一笔 ETH 加网络手续费。

名称不是用户名：它不帮助人们在聊天中找到您，而是让付钱给您更容易。

[ENS](https://ens.domains)

## 如何同步设备？

同步是把资料（连同密钥和历史记录）从一个设备迁移到另一个设备。两台设备必须在同一个局域网内，例如同一个 Wi-Fi。

在已有资料的设备上，打开资料页并取**同步码**。在空设备上选择「恢复或同步」，输入该码，资料随即到达。码只保留几分钟，不可重复使用。

[认证与同步](en/auth_and_sync.md)

## 已完成与计划

目前可用的功能与下一步计划。列表刻意简短：只列决定产品的项。

**已完成**

- 资料：创建、PIN、登录、助记词、显示名称。
- 聊天、频道、联系人、评论。
- 钱包：资产、发送、接收、兑换；ENS 名称。
- Market、外部信息源、独立窗口中的 dApp。
- 四种主题、四种语言。
- Android 构建；免重启切换网络。

**计划**

- Windows 构建。
- Stauri 中的 `.eth` 名称：注册、续期和设置记录，无需 dApp 浏览器。计划和阶段：[`.eth` 名称](en/ens_eth.md)。
- 法币购买加密货币（目前为占位）。
- dApp 窗口中的 `window.ethereum`。
- 交易历史、NFT、跨链桥。
- Keycard、推送通知。

[计划与架构](en/architecture.md)
