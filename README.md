# Stauri (Status client on Tauri)

[`README_ru.md`](README_ru.md)

**Stauri** is a lightweight desktop client for the Status ecosystem, being developed as an actively growing alternative to the official `status-desktop`.

Built on **Tauri (Rust)** and **Svelte 5**, Stauri runs `status-go` as a **library inside its own process**. The same Rust code drives the desktop and Android builds: no child process, no local port, no separate backend to keep alive. This preserves the full power of `status-go` while providing a modern, fast, and flexible user interface.

## 🔧 Two things worth knowing before you trust the binary

**1. `status-go` is upstream + one small patch.** The build uses the pinned commit
`766535cf3` plus [`src-tauri/status-go/stauri-close-accounts.patch`](src-tauri/status-go/stauri-close-accounts.patch)
(2 files, 39 added lines) and nothing else. The patch adds one export,
`CloseAccounts`, which lets the app reopen the account database when it changes its
data directory — that is what makes switching networks instant instead of a restart.
Read the whole diff in the fork:
[`magnus-redkin/status-go:stauri/close-accounts`](https://github.com/status-im/status-go/compare/766535cf336416a11a92f46faf4df5ac6af4a0b8...magnus-redkin:status-go:stauri/close-accounts).
It touches no crypto, no transport, no storage format; it closes the **unencrypted**
`accounts.sql` that holds profile metadata. An unpatched library still runs — only the
network switch then reports that it needs a rebuild. Rationale, verification steps and
the upstream plan: [`src-tauri/status-go/README.md`](src-tauri/status-go/README.md).

**2. The key material lives in its own folder.** [`src-tauri/src/core/`](src-tauri/src/core/)
holds the PIN envelope (Argon2id + AES-GCM), the seed phrase, pairing, the RPC forwarder
and every status-go FFI call. Everything else — chats, wallet screens, market, dApps — is
business logic that sits outside it. The folder is a marker, not a compiler lock: what
enforces it is `.github/CODEOWNERS` (every change there needs review) and
`core/surface.rs`, a test that fails if the set of core files or the command surface
changes silently. Details: [`docs/en/architecture.md`](docs/en/architecture.md) §1.2.

## ✨ Expected advantages over `status-desktop`

- **Modern stack (Svelte 5 + Tailwind CSS):** Provides a faster and more responsive UI compared to the Nim/QML stack, significantly improving development speed and usability.
- **Modular architecture:** Clear separation of responsibilities (Chat, Wallet, dApp browser). This simplifies maintenance of the codebase, its extension, and adaptation to new features.
- **Security through isolation:** dApps open in isolated Tauri WebView windows, reducing the attack surface compared to a monolithic QML application. A future update will add safe `window.ethereum` injection with granular permissions.
- **Native cross-platform support:** Tauri provides native support for Windows, macOS, and Linux "out of the box" with a minimal bundle size.
- **Extensibility by design:** The separation of UI and the Rust backend makes it easy to plug in custom extensions and features without touching the core of the Status protocol.

## ⚙️ Network configuration

By default, Stauri connects to **Ethereum Mainnet** and the **Production Waku fleet**. However, you can easily switch to testnets or use custom RPCs for development.

### 🛡️ Data isolation
Each network has its own directory: mainnet lives in `.../stauri/mainnet/`, testnets in
`.../stauri/sepolia/` and `.../stauri/holesky/`. Profiles, history and keystores never
mix, and switching networks re-points the backend at the chosen directory in place (no
restart) — see the patch note above.

### 🖥️ UI indication
When connected to a testnet, Stauri provides clear visual cues:
- An orange warning banner at the top of the app.
- Detailed network information (Network name, Chain ID, RPC URL, Waku Fleet) shown in the left sidebar under Profile.

## 📚 Documentation

All documents live in [`docs/en/`](docs/en/).

- [`docs/en/architecture.md`](docs/en/architecture.md) — overall architecture, layers, data flow, the safety core, the network switch.
- [`docs/en/web3im.md`](docs/en/web3im.md) — Web3, wallets and distributed messengers without jargon.
- [`docs/en/comparison.md`](docs/en/comparison.md) — Stauri and Status: what is compared, differences, trade-offs, Logos.
- [`docs/en/auth_and_sync.md`](docs/en/auth_and_sync.md) — PIN, envelopes, profiles, pairing.
- [`docs/en/networks_and_balances.md`](docs/en/networks_and_balances.md) — the path from the backend to a balance on screen, the RPC forwarder, where it breaks.
- [`docs/en/providers_and_dapps.md`](docs/en/providers_and_dapps.md) — external data sources, stores, dApp isolation.
- [`docs/en/akk_scheme.md`](docs/en/akk_scheme.md) — the Author → Channel → Comments scheme and how it maps onto `status-go`.
- [`docs/en/status_outdated_architecture.md`](docs/en/status_outdated_architecture.md) — why `status-go` is built the way it is (reference).
- [`docs/en/nix-qml_vs_tauri-svelte.md`](docs/en/nix-qml_vs_tauri-svelte.md) — the two toolchains compared.
- [`docs/en/tests.md`](docs/en/tests.md) — test levels, what is covered, what is checked by hand.
- [`docs/BUILDING.md`](docs/BUILDING.md) — building `libstatus.so` and `libsds.so` in Nix, the patch, and how the app loads them.

## 🧩 What is already implemented

### 💼 Wallet

The main wallet screen — 5 tabs: **Assets / Send / Receive / Buy / Swap**.

- **Assets** — token list grouped by `(symbol, chainGroup)`, where `chainGroup` = EVM (Ethereum, Optimism, Arbitrum, Base), BSC (Binance), or chainId. Icons come from `cryptocurrency-icons` (by symbol), with fallback to Trust Wallet Assets (by contract address) cached in `localStorage`, and a final fallback to the first letter. Zero balances are not discarded; `hasError` is shown as a label.
- **Send** — token, recipient, amount, fee estimate, then build → sign → send through the local RPC forwarder; the signature never leaves Rust.
- **Receive** — address and QR code (via `api.qrserver.com`), with a "Copy" button.
- **Buy** — placeholder; OnRamp providers are planned.
- **Swap** — quote and swap through the Router, with slippage and fee display; mainnet only (testnet liquidity does not exist).

In the left column — account info (`All accounts`, token count, shortened address) and a **Manage accounts** link (Wallet icon + pencil).

### 📈 Market

A separate module that **does not depend on `status-go`**:

- `src-tauri/src/market.rs` — Tauri command `fetch_market_data`, which calls CoinGecko (`/coins/markets`) via `reqwest`, passes `x-cg-demo-api-key` from `.env`, and caches the response for 60 seconds.
- `MarketMain.svelte` — top-50 coin table (price, 24h, volume, market cap), icons from CoinGecko (`image` URL).
- The `COINGECKO_KEY` is read via `dotenv` on Rust startup. If missing — Market shows the error "COINGECKO_KEY is not set".

Why this way: `status-go` can return market data, but that pulls in a dependency on `market-proxy` and its caches. For Stauri it's simpler and cleaner to call CoinGecko directly from Rust.

### 💬 Chat and contacts

- Chat list (`ChatLeft`), message window (`ChatMain`), search, sending.
- Contacts (`ContactsLeft`, `ContactsMain`), adding by public key, accepting requests.
- Unread request badge in the sidebar.

### 🔐 Profile

- Account info (Profile ID, Public Key, Network, Chain ID, RPC, Waku Fleet).
- Profile editing (Display Name).
- ENS name registration (`name.stateofus.eth`) from the profile, with availability and price checked before signing.
- Seed phrase screen: the phrase is held in Rust and shown word by word; nothing leaks into the webview.
- PIN per profile (Argon2id → AES-GCM envelope), a profile picker on the entry screen, and "Code for sync" to move a profile to another device over the LAN.
- Disconnect.

### 🖥️ Settings

- Language: **English / Русский / 中文 / Español**.
- Theme: **Maroon / Light / Dark / Green**.
- Font size (12–20 px).
- Update check at start and hourly; a coloured "Update Stauri to <version>" badge when a release is available.

### 📰 External feeds

RSS/Atom and Telegram channels through `providers.rs`, shown in the chat list with their source.

### 🌐 dApp windows

`open_dapp_window` creates an isolated Tauri WebView window with an external URL. A future update will add safe `window.ethereum` injection with granular permissions.

## ⚠️ Known limitations and challenges

- **Nix build of the libraries:** `libstatus.so` and `libsds.so` must be built **in the same Nix environment** (same glibc, same ABI). A mismatch crashes the app with `SIGSEGV` when `libsds.so` is loaded. See `BUILDING.md` for details.
- **`CGO_LDFLAGS`/`CGO_CFLAGS`:** local variables (vosk, whisper, portaudio, onnxruntime) inject system libraries (e.g., `libmp3lame` built against glibc 2.43) and break the Nix build. Before `make statusgo-shared-library` in the Nix shell, run `unset CGO_LDFLAGS CGO_CFLAGS`.
- **Nix interpreter in `libstatus.so`:** the library carries a `/nix/store` `RUNPATH`, so on a machine without that store it fails to load its own dependencies. `release.sh` rewrites it with `patchelf` to an `$ORIGIN`-relative `RPATH`.
- **AppImage and Nix glibc:** an AppImage built with Nix-built libraries may crash on systems with a different glibc (e.g., Ubuntu 26.04). The release build needs a pipeline that avoids Nix for production binaries.
- **A library, not a process:** a crash or an unrecovered panic inside `status-go` now takes the whole app down, and the backend cannot be updated independently of the UI. This was an accepted trade-off: the price is one shared build pipeline instead of two, and identical Rust code on desktop, Android and Windows.
- **Relay peers before sending:** a message published before the node has Waku relay peers is dropped silently, while the send RPC still returns success. A contact request sent seconds after login can therefore never arrive.
- **`status-go` caches:** RPC clients are cached forever; the balance cache is not invalidated. This requires a specific startup order and a local RPC forwarder (see [`docs/en/networks_and_balances.md`](docs/en/networks_and_balances.md)).
- **Feature completeness:** Buy, history, NFT, bridge and Keycard are still missing; `window.ethereum` injection is planned.

## 🚀 Current status

Stauri is in an active prototyping phase. The following key features already work:

- `status-go` loaded in-process from `libstatus.so`; per-network `dataDir` isolation stays.
- Signals from status-go through a C callback, forwarded to the webview as a Tauri event (`node.login`, `node.stopped`, `messages.new`).
- Account creation and login, PIN per profile, profile picker, LAN pairing.
- Switching networks in place, without restarting the app (with the patched library).
- Messenger and wallet service initialization.
- Wallet address retrieval (`accounts_getAccounts`, filter `chat = false`).
- Balance loading with token metadata (`wallet_getTokensForActiveNetworksMode`) and grouping by network.
- Local RPC forwarder (`127.0.0.1:43057`) and user provider registration `stauri-rpc`.
- Node restart when providers change (only when `wroteProviders`).
- 5 wallet tabs (Assets / Send / Receive / Buy / Swap), token grouping, icons, cache; ENS registration.
- Market via CoinGecko (Rust command, 60 s cache, key from `.env`).
- Chat and contacts (list, search, send, accept requests), communities, external feeds.
- Profile (info, editing, seed phrase, ENS, sync code).
- Settings (languages: en/ru/zh/es, themes: maroon/light/dark/green, font size, update check).
- Opening dApps in isolated Tauri WebView windows.
- Dynamic network configuration via environment variables or JSON.

**Goal:** to build a fully featured, lightweight, and extensible client that uses this modular architecture to deliver all the necessary Status features.

## 🛠 Building from source

Stauri requires a prebuilt `libstatus.so` and `libsds.so` from the Status Go repository, built **from upstream plus the Stauri patch**, in the **same Nix environment**.

Detailed instructions are in [docs/BUILDING.md](docs/BUILDING.md). Briefly:

```bash
# 1. Build the library in Nix: pinned upstream + one patch
git clone https://github.com/status-im/status-go.git ~/ETH/github.status-go
cd ~/ETH/github.status-go
git checkout 766535cf3
git apply ~/ETH/stauri/stauri-app/src-tauri/status-go/stauri-close-accounts.patch

env -u CGO_LDFLAGS -u CGO_CFLAGS -u LD_LIBRARY_PATH -u LIBRARY_PATH \
  nix develop --extra-experimental-features 'nix-command flakes' \
  --command make statusgo-shared-library

# 2. Copy into Stauri
cp ~/ETH/github.status-go/build/bin/libstatus.so.0 \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/libstatus.so
cp /nix/store/<hash>-nim-sds-.../lib/libsds.so \
   ~/ETH/stauri/stauri-app/src-tauri/binaries/libsds.so

# 3. Run
cd ~/ETH/stauri/stauri-app
pnpm install
pnpm tauri dev

# 4. Build AppImage
./scripts/release.sh 0.5.0
