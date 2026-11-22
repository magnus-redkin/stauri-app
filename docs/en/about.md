## What is Web3 IM?

A messenger where messages travel through a peer-to-peer network instead of a company server: no one holds the whole history, and no one can delete or read it. The wallet lives in the same app, because the identity behind the messages is the same key that holds the funds.

- No account on a server: the key pair is the account.
- The seed phrase of 12 words is the master key for both the profile and the funds.
- Messages are encrypted end to end; nodes relay them without reading them.

[Full document](ru/web3im.md)

## What is the Status network?

Status is a set of open-source programs — the Status app, the status-go engine and the Waku transport — that form one network. Nodes find each other through a boot list (a "fleet") and exchange sealed messages; the same network carries the messenger and the wallet traffic.

- Waku is the transport: it stores and forwards sealed envelopes.
- A fleet is the list of starting nodes; Status runs a public one.
- status-go is the engine; Stauri loads it as a library and draws its own interface.

[Full document](en/architecture.md)

## Stauri vs Status.im

Stauri uses the same engine and the same network as Status Desktop. The differences are two: the stack, and the vocabulary.

1. **Tauri + Svelte instead of Nix + Nim/QML.** The interface is a web front end in Svelte: a short edit cycle, one Rust code base on desktop and Android, and isolated windows for external dApps. Status Desktop is one monolith built with Nix in Nim and QML.
2. **No "Community" in the interface; channels are ACC.** A Status community is a technical container with one channel. Stauri hides the container and shows channels (ACC) directly as the entity a user recognises.

[Full document](ru/comparison.md)

## TODO / DONE

What works today and what is planned next. The list is short on purpose: only the items that shape the product.

**DONE**

- Profile: create, log in, seed phrase.
- Chats, channels, contacts, comments.
- Wallet: assets, send, receive, swap.
- ENS name in the profile.
- Market, external feeds, dApps in separate windows.
- Four themes; four languages.

**TODO**

- Android build; Windows build.
- Buy crypto for fiat (placeholder now).
- window.ethereum in dApp windows.
- Transaction history, NFTs, bridge.
- Keycard, push notifications.
