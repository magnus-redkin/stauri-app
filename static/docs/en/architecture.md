# Stauri Architecture

This document describes how Stauri is structured as a whole: what layers it
consists of, how they communicate, and why the boundaries are drawn the way
they are. It complements `networks_and_balances.md` (the concrete path from a
balance to the screen), `status_outdated_architecture.md` (why `status-go` is
complex), `auth_and_sync.md` (login, PIN, profile creation and device sync) and
`docs/BUILDING.md` (building `libstatus.so` and `libsds.so`).

The full, more detailed description is in Russian: `docs/ru/architecture.md`.

## 1. The main decision: a library, not a sidecar

Stauri loads `status-go` as a **library inside its own process**
(`libstatus.so` on desktop and Android, `libstatus.dll` on Windows) and calls
its exported C functions directly:

- **Requests** go through `CallRPC(json)` and the lifecycle exports
  (`InitializeApplication`, `CreateAccountAndLogin`, `LoginAccount`, `Logout`);
- **Signals** arrive through a C callback registered with
  `SetSignalEventCallback(void* cb)`.

There is no child process, no `127.0.0.1:<port>`, no WebSocket and no
authentication token. All of that was in place while the backend ran as a
sidecar.

What the change bought:

- **One Rust code base for every platform.** The desktop, Android and Windows
  builds differ in how the library is found and named, not in how it is used.
- **No local attack surface.** There is no loopback port another process or web
  page could reach; the only entry point is a Tauri command.
- **No lifecycle management.** No PID file, no zombie hunting, no restart
  protocol — stopping the node is a `Logout` call.

The price, accepted deliberately:

- **A panic in the library takes the whole app down.** With a sidecar only the
  backend died and the window survived.
- **The backend cannot be updated independently.** `libstatus.so` is built with
  the app, so a new `status-go` means a new Stauri release.
- **Library and `libsds.so` must come from one Nix environment** (same glibc,
  same ABI), otherwise the app dies with `SIGSEGV` while loading `libsds.so`
  (see `docs/BUILDING.md`).

## 2. Library loading and signals

```text
src-tauri/src/inprocess.rs
  library_path()      STAURI_LIBSTATUS, else next to the executable
                      (Android: the bare name, resolved from jniLibs)
  backend()           the Library, loaded once per process
  register_signals()  SetSignalEventCallback(...) → tokio broadcast channel
  call_rpc()          CallRPC on a blocking thread, envelope unwrapped
  direct()            InitializeApplication and the other lifecycle exports
  subscribe()         a receiver for router signals (src/router.rs)
```

`src-tauri/build.rs` copies `libstatus.so` and `libsds.so` from
`src-tauri/binaries/` next to the executable, so `cargo run` and `tauri dev`
work without a manual copy. Release bundles get the same files through
`tauri.conf.json` (resources) and `scripts/release.sh` (AppImage).

Signals carry roughly 100% of what the frontend reacts to. There are two
consumers of one stream:

| Consumer | Where | Signals |
|---|---|---|
| Frontend | `src/stores/ws.ts` → `statusStore.processSignal` | `node.login`, `node.stopped`, `messages.new`, `wallet`, … |
| Rust | `src/router.rs`, subscribes for the duration of an operation | `wallet.router.sign-transactions`, `wallet.router.transactions-sent` |

`src/lib/stores/ws.ts` keeps its old name and shape (`openWs` / `closeWs` /
`isWsOpen`) although no socket exists: it now subscribes to the Tauri event
`status-signal`, which `lib.rs` emits from the callback. Keeping the shape left
every call site untouched.

## 3. Layers

```text
┌──────────────────────────────────────────────────────────────┐
│ UI (Svelte 5)                                                │
│ routes/+page.svelte, sections/{wallet,profile,chat,…}        │
├──────────────────────────────────────────────────────────────┤
│ Stores (Svelte 5 runes, .svelte.ts)                          │
│ statusStore, connectionStore, walletStore, sendStore,        │
│ ensStore, swapStore, chatsStore, contactsStore, …            │
├──────────────────────────────────────────────────────────────┤
│ status-go boundary (TypeScript)                              │
│ status/http.ts (Tauri commands), status/wallet.ts,           │
│ status/api.ts, status/messaging.ts                           │
├──────────────────────────────────────────────────────────────┤
│ Tauri (Rust)                                                 │
│ inprocess, rpc_proxy, transfer, ens, swap, router, market,   │
│ providers, seed, updater, dapp, …                            │
├──────────────────────────────────────────────────────────────┤
│ libstatus.so in this process · RPC providers · CoinGecko · RSS│
└──────────────────────────────────────────────────────────────┘
```

The boundaries follow lifetime and rate of change:

- **UI** changes constantly and depends only on the stores.
- **Stores** are the only place with mutable state; the UI reads them and calls
  actions.
- **`status/http.ts`** is the only place that turns a request into a Tauri
  command: `status_rpc` for JSON-RPC, `status_call` for lifecycle endpoints. It
  also rebuilds the `{ result }` envelope that callers read.
- **Tauri** owns the library, signatures, windows and external APIs.

## 4. Data flow

### 4.1. Request and reply

```text
UI → store action → status/wallet.ts → http.ts → invoke('status_rpc')
→ inprocess::call_rpc → CallRPC(json) → status-go → JSON-RPC reply
← http.ts rejects an error body, returns { result }
← store updates $state
← UI re-renders
```

`statusFetch` is the single point where:

- a JSON-RPC error becomes an `Error` with the method's message;
- the reply is wrapped back into `{ result }` — Rust already unwrapped the
  envelope, while every caller reads `res.result`;
- **request and reply bodies are never logged.** `settings_getSettings` returns
  the seed phrase in `mnemonic`; only the method name and the duration are
  logged. Error text carries no profile data, because status-go keeps it in a
  separate `error` field.

### 4.2. Signals

```text
status-go → SetSignalEventCallback → tokio broadcast
→ lib.rs emits the Tauri event "status-signal"
→ ws.ts listen() → statusStore.processSignal(rawJson)
→ $state update
```

`processSignal` is synchronous and makes no network calls. Anything it does not
recognise goes into `statusState.events` for diagnostics.

Router signals are parsed in Rust (`router.rs`), not in the webview: the router
can return several transactions (approve + the main one), and
`wallet_signMessage` signs any 32 bytes without knowing what they are. Keeping
hashes, password and the `{r,s,v}` split out of the webview is what prevents a
foreign script from asking for an arbitrary signature.

### 4.3. External APIs

Direct `reqwest` calls from Rust, not through `status-go`:

- `market.rs` — CoinGecko `/coins/markets` for the Market tab, 60 s cache,
  optional `COINGECKO_KEY` from `.env`;
- `providers.rs` — RSS/Atom and Telegram pages for external feeds.

Prices for the **total balance** take a different path: `wallet_fetchPrices` in
`status-go`, which already maps tokens to CoinGecko by `crossChainId`.

## 5. Invariants

1. The UI never calls the `status/*` boundary directly — only through stores.
2. `status/http.ts` is the only place with the transport and error parsing.
3. `status-go` reply bodies are never logged (they contain the seed phrase).
4. `processSignal` is synchronous; asynchronous reactions start separately.
5. `connectionStore` is the only one that knows the startup and login order.
6. Password and signature never leave Rust; the UI hands over an intent.
7. Router signals are parsed in Rust, not in the webview.
8. dApp windows are isolated from the main window.
9. Rust commands are the only way to reach the OS and external APIs.
10. `libstatus` and `libsds.so` come from one Nix environment.
11. The network and its mode (mainnet/testnet) are set **twice**: by the Rust
    config (`STAURI_NETWORK`) and by the `test-networks-enabled?` flag for
    `status-go`. They are different things.
12. Secrets are cleared on logout: the session password and the seed phrase.
