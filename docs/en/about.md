## What is Web3 IM?

A messenger where messages travel through a peer-to-peer network instead of a company's server. Nobody holds the whole history, and nobody can delete or read it on the way.

The wallet lives in the same app, because the identity behind the messages is the same key that holds the money. There is no account on a server: the key pair *is* the account.

[Full document](web3im.md)
[Status](https://status.im)

## What is the Status network?

Status is a set of open programs — the Status app, the `status-go` engine and the Waku transport — that together form one network. Nodes find each other through a boot list and exchange sealed messages; the messenger and the wallet travel over the same network.

Stauri connects to the same network as Status Desktop. That is why Stauri users and Status users can write to each other: it is one network, not a bridge between two.

[Architecture](architecture.md)
[Waku](https://waku.org)

## Password and seed phrase

These are two different secrets, and mixing them up is the most common way to lose access.

The **password** encrypts the profile on this device. It never leaves the phone or the computer, and nobody at Status or Stauri can read it.

The **seed phrase** — twelve words — is the master key for both the profile and the money. It restores everything on any device. Losing the password can often be survived: a short PIN unlocks it, and the seed phrase restores the profile. Losing the seed phrase cannot: no support service, no reset, no exception.

[Auth and sync](auth_and_sync.md)

## Stauri vs Status

Stauri uses the same engine and the same network as Status. The differences are two: the stack, and the vocabulary — plus one small patch to the engine, described below.

**The stack.** Tauri + Svelte + Tailwind instead of Nix + Nim/QML. Status modules are monoliths built through Nix. Stauri has a short edit cycle and one Rust code base on desktop and Android. Rust is required only for the core modules that talk to Tauri and for cryptography; the rest can be written in Go, Nim, Python or anything else.

**The vocabulary.** There is no "Community" in Stauri's interface: channels are ACC — Author, Channel, Comment. A Status community becomes a technical container with one channel; Stauri hides the container and shows the channels directly, as the thing a person recognises.

Two more differences: the dApps section can carry not only Status channels but also RSS feeds from other sources, for example Telegram; and a smaller binary means less battery.

[Comparison](comparison.md)
[Status](https://status.im)
[Logos](https://logos.co)

## The status-go patch

Stauri builds the same engine as Status — the official `status-go` — with one small addition. The engine reads the list of profiles once at start and keeps it in memory; we needed it to be able to read another network's list without restarting the app. The patch adds one function that closes that list, so it can be opened again for the chosen network.

It is two files and about forty lines. It touches no cryptography and no keys: the list it closes holds profile names and settings, not secrets. The patch and the whole diff are published — anyone can read them, and the reason is written next to them.

Without the patch Stauri still works; only switching networks asks to restart the app.

[The patch, explained](https://github.com/magnus-redkin/stauri-app/blob/main/src-tauri/status-go/README.md)
[The whole diff](https://github.com/status-im/status-go/compare/766535cf336416a11a92f46faf4df5ac6af4a0b8...magnus-redkin:status-go:stauri/close-accounts)

## How do I get an ENS name?

ENS is a human-readable name for an address: instead of a long string of characters, people see `yourname.eth` and can send to it.

In Stauri: open Profile, choose the ENS name, check whether it is free, look at the price, and confirm. The name is registered in the Status subdomain (`yourname.stateofus.eth`) and belongs to your address. It costs a yearly fee in ETH plus network commission.

A name is not a username: it does not help anyone find you in the messenger, it makes payments to you easier.

[ENS](https://ens.domains)

## How do I sync devices?

Syncing moves a profile — with its keys and history — from one device to another. Both devices must be on the same local network, for example the same Wi-Fi.

On the device that already has the profile, open Profile and take the **Code for sync**. On the empty device choose "Restore or sync", enter that code, and the profile arrives. The code lives for a few minutes and cannot be reused.

[Auth and sync](auth_and_sync.md)

## TODO / DONE

What works today, and what is next. The list is short on purpose: only what shapes the product.

**DONE**

- Profile: create, PIN, log in, seed phrase, display name.
- Chats, channels, contacts, comments.
- Wallet: assets, send, receive, swap; ENS name.
- Market, external feeds, dApps in separate windows.
- Four themes, four languages.
- Android build; network switching without restart.

**TODO**

- Windows build.
- Buying crypto for fiat (a placeholder now).
- `window.ethereum` inside dApp windows.
- Transaction history, NFTs, bridge.
- Keycard, push notifications.

[Plans and architecture](architecture.md)
