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
src-tauri/src/core/inprocess.rs
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

## 2.1. The safety core (`src/core/`)

Every file that **holds, protects or moves keys** lives in one folder,
`src-tauri/src/core/`. The folder is a marker, not a lock: Rust has no
per-folder visibility, and code inside `core/` imports the rest of the crate
just as freely. What keeps the boundary honest is process, not the compiler:

- `.github/CODEOWNERS` — any change inside `core/` requires review;
- `src/core/surface.rs` — a contract test that pins the set of files and the
  command surface: a new file in the folder, or a module quietly moved back
  out, fails the build;
- this list, which says what belongs there.

| File | What it does |
|---|---|
| `core/inprocess.rs` | status-go as a library in this process: `library_path`, `backend`, `register_signals`, `call_rpc`, `direct`, `subscribe` |
| `core/backend.rs` | The single named entry point to status-go; wallet and ENS say `Backend` and never touch the library |
| `core/rpc_proxy.rs` | Local HTTP forwarder `127.0.0.1:<port>/<secret>/<chainId>` that status-go uses for RPC; the secret lives in the path, kept in the config directory |
| `core/credentials.rs` | The PIN → Argon2id → AES-GCM envelope per profile, the attempt counter, and the pending-key stash for sync |
| `core/seed.rs` | The seed phrase, held in Rust; the webview sees one word at a time (`seed_word`), verified without revealing the expected word |
| `core/pairing.rs` | Copying a profile to another device: sender and receiver, confirmation codes, `is_valid_connection_string` |
| `core/lanpair.rs` | Finding the other device over the LAN and the six-digit handshake that starts the transfer |
| `core/error.rs` | Typed command errors; the vocabulary everything returns |
| `core/trace.rs` | The in-app trace log with secret scrubbing |

### What deliberately does **not** belong in the core

`transfer`, `ens`, `swap`, `router`, `providers`, `market`, `dapp`, `updater`,
`opener`, `invite`, `config`, `profile`, `commands`. These *use* the core
through its `pub` surface, and they are the parts most likely to be rewritten
in another language or replaced one day. Money movement and the data layer are
clients of the core, not the core: freezing them inside it would defeat the
point.

### Why a polyglot boundary, not "all of Rust is sacred"

A polyglot architecture with Rust at the centre of security does not mean every
Rust file is unchangeable. The line is drawn at **where the keys physically
live**: `inprocess`/`backend` (the status-go FFI holds the private keys),
`credentials` (the PIN envelope), `seed` (the phrase), `pairing` / `lanpair`
(carrying the keys between devices). Anything that merely *calls* `Backend` and
`Router` to move money is business logic — Nim, Go or Rust, as the module's
authors decide.

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
│ core/: inprocess, backend, rpc_proxy, credentials, seed,     │
│        pairing, lanpair, error, trace   ← locked, review     │
│ business: transfer, ens, swap, router, market, providers,    │
│        dapp, updater, …                                       │
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

### 4.4. Network choice — an in-process switch

The network is switched **inside the running process**, with no restart. The
`switch_network` command (`commands.rs`) does, in order: validates the preset
(`mainnet`, `sepolia`, `holesky`) and writes it to `config.json`
(`config::save_network`), calls `Logout`, then `CloseAccounts`, then
`InitializeApplication` on the chosen network's directory — and returns the
chosen network's settings and **its** profile list to the frontend.

Why `CloseAccounts` is needed. `InitializeApplication` opens `accounts.sql`
once per process: `StatusBackend.OpenAccounts` returns immediately after the
first open, so a second call with another `dataDir` would still list the
**first** network's profiles. Meanwhile the accounts-manager root
(`UpdateRootDataDir`) *does* move — the keystore is looked up in the new
directory, which is empty, so a profile shows up that cannot be opened.

`CloseAccounts` is a **patch to `status-go`** without which this API does not
exist (`src-tauri/status-go/`). In the fork it is a single commit; in the app
the library's symbol is optional: an unpatched `libstatus` still loads and runs,
and a network switch returns a clear "rebuild it from `src-tauri/status-go`"
error. Why a patch instead of a process restart: restarting on Android means
killing the process, and the OS will not bring it back from the background
(`BAL_BLOCK`), so the next start would have to be done by hand.

Directories are per-network: `start_backend` and `switch_network` place the
data under `<data>/<network_name>/` (`config.data_dir_suffix()`), so profiles,
history and keystores of mainnet and a testnet never mix.

`CloseAccounts` closes the **unencrypted** `accounts.sql` that holds the
profile list; no keys live there. The keystore moves only because
`InitializeApplication` re-sets `rootDataDir`.

When the network is fixed by `STAURI_NETWORK`, `save_network` returns an error
before anything is closed or re-initialised.

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
