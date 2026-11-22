# Stauri Architecture

This document describes how Stauri is structured as a whole: what layers it
consists of, how they communicate, and why the boundaries are drawn the way
they are.

Companion documents: `networks_and_balances.md` (the path of a balance to the
screen), `status_outdated_architecture.md` (why `status-go` is built the way
it is), `providers_and_dapps.md` (external sources and dApps), `akk_scheme.md`
(the Author → Channel → Comments scheme), `auth_and_sync.md` (login, PIN,
profile creation and device transfer), `tests.md` (test levels).

Updated 2026-11-22: network switching is done in-process (§4.4); for that
reason `status-go` is built from upstream plus one patch
(`src-tauri/status-go/`). Earlier: the move from a sidecar to a library; the
safety core moved to `src-tauri/src/core/` (§2.1), the contract pinned by the
`core/surface.rs` test and `.github/CODEOWNERS`.

---

## 1. The main decision: a library, not a sidecar

Stauri loads `status-go` **as a library inside its own process**
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

1. **One Rust code base for every platform.** Desktop, Android and Windows
   differ in how the library is found and named, not in how it is used.
2. **No local attack surface.** There is no loopback port another process or
   web page could reach; the only entry point is a Tauri command.
3. **No lifecycle management.** No PID file, no zombie hunting, no restart
   protocol: stopping the node is a `Logout` call.

The price, accepted deliberately:

1. **A panic inside the library takes the whole app down.** With a sidecar
   only the backend died and the window survived.
2. **The backend cannot be updated independently.** `libstatus.so` is built
   with the app, so a new `status-go` means a new Stauri release.
3. **The library and `libsds.so` must come from one Nix environment** (same
   glibc, same ABI), otherwise the app dies with `SIGSEGV` while loading
   `libsds.so`.

**The backend version.** The library is built from `~/ETH/github.status-go`
(the tested commit `766535cf3`, see `docs/BUILDING.md`). The set of RPC
methods depends on the version, so signatures should be checked against the
sources of that build, or better — with a request to the running app.

## 1.1. Library loading and signals

```text
src-tauri/src/core/inprocess.rs
  library_path()      STAURI_LIBSTATUS, else next to the executable
                      (Android: the bare name, resolved from jniLibs)
  backend()           the Library, loaded once per process
  register_signals()  SetSignalEventCallback(...) → tokio broadcast
  call_rpc()          CallRPC on a blocking thread, the JSON-RPC envelope unwrapped
  direct()            InitializeApplication and the other lifecycle exports
  subscribe()         a receiver for router signals (src/router.rs)
```

`src-tauri/build.rs` copies `libstatus.so` and `libsds.so` from
`src-tauri/binaries/` next to the executable, so `cargo run` and `tauri dev`
work without a manual copy. The release bundle gets the same files through
`tauri.conf.json` (resources) and `scripts/release.sh` (AppImage).

There are two consumers of one signal stream:

| Consumer | Where | Signals |
|---|---|---|
| Frontend | `stores/ws.ts` → `statusStore.processSignal` | `node.login`, `node.stopped`, `messages.new`, `wallet`, … |
| Rust | `router.rs`, subscribed for the duration of an operation | `wallet.router.sign-transactions`, `wallet.router.transactions-sent` |

`stores/ws.ts` keeps its old name and shape (`openWs` / `closeWs` /
`isWsOpen`) although no socket exists: it now subscribes to the Tauri event
`status-signal`, which `lib.rs` emits from the callback. Keeping the shape
left every call site untouched.

## 1.2. The safety core (`src/core/`)

Every file that **holds, protects or moves keys** lives in one folder,
`src-tauri/src/core/`. The folder is a marker, not a lock: Rust has no
per-directory visibility, and code inside `core/` imports the rest of the
crate just as freely. What keeps the boundary honest is process, not the
compiler:

- `.github/CODEOWNERS` — any change inside `core/` requires review;
- `src/core/surface.rs` — a contract test that freezes the set of core files
  and its command surface: a new file in the folder, or a module quietly moved
  back out, fails the build;
- this list says what belongs in the core.

| File | What it does |
|---|---|
| `core/inprocess.rs` | status-go as a library in this process: `library_path`, `backend`, `register_signals`, `call_rpc`, `direct`, `subscribe` |
| `core/backend.rs` | The single named entry point to status-go; the wallet and ENS speak to `Backend` and never touch the library |
| `core/rpc_proxy.rs` | A local HTTP forwarder `127.0.0.1:<port>/<secret>/<chainId>` for status-go's RPC; the secret lives in the path and is kept in the config directory |
| `core/credentials.rs` | The per-profile PIN → Argon2id → AES-GCM envelope, the attempt counter, and the pending-key stash for sync |
| `core/seed.rs` | The seed phrase, held in Rust; the webview sees one word at a time (`seed_word`), verified without revealing the expected word |
| `core/pairing.rs` | Copying a profile to another device: sender and receiver, confirmation codes, `is_valid_connection_string` |
| `core/lanpair.rs` | Finding the other device over the LAN and the six-digit handshake that starts the transfer |
| `core/error.rs` | Typed command errors; the vocabulary everything returns |
| `core/trace.rs` | The in-app trace log with secret scrubbing |

### What deliberately does **not** belong in the core

`transfer`, `ens`, `swap`, `router`, `providers`, `market`, `dapp`, `updater`,
`opener`, `invite`, `config`, `profile`, `commands`. These **use** the core
through its `pub` surface, and they are exactly the layer that may one day be
rewritten in another language or replaced. Money movement and the data layer
should not be frozen inside the core: if the core means "the keys", then
payments are just a client of it.

### Why this core, not all of Rust

A polyglot architecture with Rust at the centre of security does not mean
"all of Rust is irreplaceable". The line is drawn at **where the keys
physically live**: `inprocess`/`backend` (the status-go FFI holds the private
keys), `credentials` (the PIN envelope), `seed` (the phrase),
`pairing`/`lanpair` (carrying the keys between devices). Anything that only
*calls* `Backend` and `Router` to move money is business logic, and it can be
written in Nim, Go or Rust as the module's authors decide.

## 2. The RPC forwarder (`core/rpc_proxy.rs`)

A local HTTP server (preferred port `43057`) between `status-go` and external
RPC providers. The reason: the stuck TCP connections in `status-go`'s pool.
The forwarder opens a fresh connection for every request
(`pool_max_idle_per_host(0)`) and behaves like `curl`, not like
`http.DefaultTransport`. Details: `networks_and_balances.md`.

This is the only proxy that remains. The authorising proxy
(`auth_proxy.rs`) was removed together with the sidecar. The forwarder's
secret sits in the URL path (`/<secret>/<chainId>`) because the caller is
`status-go` itself, which sends no headers. Without the secret, any process
on the machine could use the RPC through `127.0.0.1:<port>`. The secret is
kept in `rpc-proxy.secret` in the config directory and survives restarts:
the provider URLs are already written into `status-go`'s database.

From the frontend's point of view these are commands (`start_rpc_proxy`,
`set_rpc_upstreams`, `stop_rpc_proxy`). The frontend does not know that it is
`reqwest` inside.

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
│ status/http.ts (Tauri commands), status/wallet.ts (wallet+ENS), │
│ status/api.ts (re-export), status/messaging.ts (chats)       │
├──────────────────────────────────────────────────────────────┤
│ Tauri (Rust)                                                 │
│ core/: inprocess, backend, rpc_proxy, credentials, seed,     │
│        pairing, lanpair, error, trace   ← the core, do not  │
│        change                                               │
│ business: transfer, ens, swap, router, market, providers,    │
│        dapp, updater, …                                       │
├──────────────────────────────────────────────────────────────┤
│ libstatus.so in this process · RPC providers · CoinGecko · RSS│
└──────────────────────────────────────────────────────────────┘
```

The boundaries follow **lifetime** and **rate of change**:

- **UI** changes constantly and depends only on the stores.
- **Stores** are the only place with mutable state; the UI reads them and
  calls actions.
- **`status/http.ts`** is the only place where a request becomes a Tauri
  command; it also does the logging and JSON-RPC error parsing.
- **`status/wallet.ts`** is the boundary of the wallet and ENS. When
  `status-go` is replaced by Logos, it is this file and its callers that must
  change, not the whole frontend.
- **Tauri** owns the `status-go` library, the windows, signing, requests to
  external APIs.
- **`status-go` in this process** is a "black box" with its own state and
  caches.

## 4. Data flow

### 4.1. Request–reply

```text
UI → store action → status/wallet.ts → http.ts → invoke('status_rpc')
→ inprocess::call_rpc → CallRPC(json) → status-go → JSON-RPC → reply
← http.ts parses the error and returns { result }
← the store updates $state
← the UI re-renders
```

`statusFetch` is the single place where:

- a JSON-RPC error (`error.message`) becomes an `Error` with the text;
- the reply is wrapped back into `{ result }`: Rust already unwrapped the
  JSON-RPC envelope, and every caller reads `res.result`;
- **request and reply bodies are never logged.** The first 200 characters of
  a reply used to be printed, and `settings_getSettings` returns the seed
  phrase in the `mnemonic` field — the phrase went into the webview console
  every time that screen was opened. Now the log carries the method name,
  the duration, the body length and, on error, the HTTP status without the
  body;
- scrubbing the password from the logs is not done yet (an open TODO).

Stores do not know about Tauri commands or JSON-RPC. If the transport
changes, the fix is in one file.

### 4.2. Signals: two consumers

`status-go` calls the C callback registered through
`SetSignalEventCallback`. Rust forwards every signal into a broadcast
channel (`tokio::sync::broadcast`) and into the webview as the Tauri event
`status-signal`. There are two consumers of one stream:

| Consumer | Where | Signals |
|---|---|---|
| Frontend | `stores/ws.ts` → `statusStore.processSignal` | `node.login`, `node.stopped`, `messages.new`, `wallet`, … |
| Rust | `router.rs`, subscribed for the duration of an operation | `wallet.router.sign-transactions`, `wallet.router.transactions-sent` |

The frontend:

```text
status-go → callback → broadcast → lib.rs emit("status-signal")
→ ws.ts listen() → statusStore.processSignal(rawJson) → $state update
```

`processSignal` is **synchronous** and makes no network calls. Everything
else it silently ignores (except the push into `statusState.events` for
diagnostics). The trace writes only the signal type and counters, no content:
messages and the profile are not needed in the log.

Rust (`router.rs`):

```text
backend.subscribe()                   ── a receiver for the duration of the operation
wallet_getSuggestedRoutes(params)     → route + uuid (synchronously)
wallet_buildTransactionsFromRoute(uuid) → the reply arrives as a signal
   ⟶ we wait for wallet.router.sign-transactions by our uuid
wallet_signMessage(hash, from, password)  × N
wallet_sendRouterTransactionsWithSignatures({uuid, signatures})
   ⟶ we wait for wallet.router.transactions-sent
```

The subscription is opened **before** the first call: otherwise the signal
can arrive before the receiver exists and is lost.

**Why router signals are parsed in Rust, not the frontend.** The router can
return several transactions (approve + the main one), and
`wallet_signMessage` signs any 32 bytes without knowing what they are. If
the hashes went into the webview, a foreign script could ask to sign any of
them. That is why the hashes, the password and the `{r,s,v}` parsing of the
signature do not leave Rust.

### 4.3. External APIs

Direct requests from Rust (`reqwest`), not through `status-go`:

- `market.rs` — CoinGecko `/coins/markets` for the Market tab, a 60 s cache,
  an optional `COINGECKO_KEY` from `.env`;
- `providers.rs` — RSS/Atom and Telegram pages for external feeds.

Prices for the **total balance** take a different path —
`wallet_fetchPrices` inside `status-go` (see §5.3), because it already maps
tokens to CoinGecko by `crossChainId`.

### 4.4. State

All state lives in the stores' `$state` objects:

| Store | What it holds |
|---|---|
| `statusState` | Connection, login, accounts, network, signals |
| `connectionState` | The connection process, the chosen network |
| `walletState` | Address, balances, prices, metadata, `rpcError` |
| `sendStore` | A transfer: step, session password, fee, hash |
| `ensStore` | Name registration: price, deposit, owner |
| `swapStore` | A swap: tokens, amount, quote |
| `walletView` | The open wallet tab |
| `chatsState`, `contactsState` | Chats and contacts |

The rules:

- **No state in components** except local UI state (is a modal open, the
  text in a field).
- **No direct calls to the boundary from the UI** — only through store
  actions.
- **A store does not know about the UI.** It returns data and error codes;
  the UI decides how to show them.

## 5. Key subsystems

### 5.1. Startup and login

The order is not style, it is a requirement of `status-go`'s RPC client
caches (detailed in `networks_and_balances.md`):

Connecting (`connect()` in `connection.svelte.ts`) and logging in
(`login()`) are two different sequences:

```text
connect()
  start_backend → initializeApplication → setAccounts
  → openWs → configureWalletRpc (forwarder + providers)   ← BEFORE login

login()
  loginAccount → node.login
  → applyNetworkMode (settings_saveSetting('test-networks-enabled?'))
  → configureWalletRpc (again)
  → [if modeChanged or wroteProviders] logout → node.stopped → loginAccount
  → startMessenger

loadWallet() in walletStore — separately and later:
  wallet_startWallet → getAccounts → balances → prices
  → polling every 3 s
```

The providers are written **before** login on purpose: status-go's RPC
clients are cached by `chainID` and never invalidated, so a client created
before the write would keep the old URL. The second call after login covers
the case where the node started inside `loginAccount` and managed to build
the client first.

The network mode (`applyNetworkMode`) is the only thing that cannot be done
in `connect()`: `settings_*` is registered in `initServices`, that is after
the node starts, and the node starts inside `loginAccount`. Without this, a
profile started as "sepolia" would treat the mainnet networks as its own.

`connectionStore.svelte.ts` is a facade: it re-exports `connectionState`,
`connect`, `switchNetwork`, `login`, `createAccount`, `disconnect` from
`connection.svelte.ts`, plus `configureWalletRpc` (`rpcConfig.ts`) and the
socket work (`ws.ts`). It is also the only caller of `loginAccount`; neither
the UI nor `walletStore` does it.

#### Network choice — an in-process switch

The network is switched **inside the process**, without a restart. The
`switch_network` command (`commands.rs`) does, in order: validates the preset
(`mainnet`, `sepolia`, `holesky`) and writes it to `config.json`
(`config::save_network`), calls `Logout`, then `CloseAccounts`, then
`InitializeApplication` on the chosen network's directory — and returns to
the frontend the network's settings and **its** profile list.

Why `CloseAccounts` is needed. `InitializeApplication` opens
`accounts.sql` once per process: `StatusBackend.OpenAccounts` returns
immediately after the first open, so a second call with another `dataDir`
would list the **first** network's profiles. Meanwhile the accounts-manager
root (`UpdateRootDataDir`) has moved — the keystore is looked up in the new
directory, which does not exist, so a profile shows up but cannot be
opened.

`CloseAccounts` is a **patch to `status-go`** without which this API does not
exist (`src-tauri/status-go/`). In the fork it is a single commit; in the
app the library's symbol is optional: a vanilla `libstatus` loads and runs,
and a network switch returns the clear "rebuild it from
src-tauri/status-go" error. Why a patch instead of a process restart: on
Android a restart means killing the process, and the OS will not bring the
app back from the background (`BAL_BLOCK`), so the next start would have to
be done by hand.

The directories are separate: `start_backend` and `switch_network` put the
data under `<data>/<network_name>/` (`config.data_dir_suffix()`), so the
profiles, history and keystore of mainnet and a testnet never mix.

`CloseAccounts` closes the **unencrypted** `accounts.sql` with the profile
list; no keys live there. The keystore moves only because
`InitializeApplication` re-sets `rootDataDir`.

When the network is fixed by `STAURI_NETWORK`, `save_network` returns an
error before anything is closed or re-initialised.

### 5.2. The wallet: reading

`walletStore` is the most complex store, because it depends on two caches of
`status-go` (the RPC clients and the balances cache) and on the token
metadata.

- **Addresses** come from `accounts_getAccounts` (the `!chat` filter), not
  from `wallet-root-address`.
- **Metadata** (`symbol`, `decimals`) come from
  `wallet_getTokensForActiveNetworksMode` (a reply of ~4.6 MB, cached for
  the session), matched on `(chainId, tokenAddress)`.
- **Polling** is on a timer: `forceRefresh` in
  `wallet_fetchOrGetCachedWalletBalances` is ignored; the only working way to
  re-fetch balances is `wallet_restartWalletReloadTimer`.
- **Three states** are distinguished in the UI: empty catalog / RPC
  unavailable / normal.

The wallet tabs: **Assets / Send / Receive / Buy / Swap** (Buy is still
disabled, Swap works on mainnet only). A separate "Accounts" tab is opened
from the left panel. The ENS name lives in the profile
(`EditProfile` → `EnsNameBlock`), not in the wallet: it is a property of the
identity, not of the account.

Assets groups tokens by `(symbol, chainGroup, decimals)`, where
`chainGroup` = EVM (Ethereum, Optimism, Arbitrum, Base), BSC (Binance) or
`chainId`. Unknown and testnet networks get their **own** group by number:
before, all of them fell into `OTHER`, and five testnet ETHs summed into one
row.

### 5.3. The total balance

The total over the main networks (Ethereum, Optimism, BNB Chain, Base,
Arbitrum) is shown in the wallet header with a "≈". It is computed in
`utils/totalBalance.ts`:

- **testnets are excluded entirely** — sepolia ETH is not converted into
  ETH;
- tokens **without a price are not dropped**, but labelled ("some tokens
  have no price"), otherwise a full wallet with a new token would show
  `≈ $0`;
- tokens with `hasError` are not counted as zero;
- the balance is divided by `10^decimals` in `bigint`, and only then
  converted to a number — a `number` loses precision already at 16
  significant digits.

Prices come from `wallet_fetchPrices`. The key there is
`chainId-address` with a **hyphen**, not a colon as in the rest of the
code: with a colon the backend silently finds nothing.

### 5.4. Signing: all of it in Rust

The three money operations have the same shape: an **intent** sticks out,
while the sequence of calls, the password and the signature stay in Rust.

| Operation | Command | File |
|---|---|---|
| ETH/ERC-20 transfer | `send_transfer`, `estimate_transfer_fee` | `transfer.rs` |
| ENS registration | `register_ens_name`, `get_ens_quote` | `ens.rs` |
| Swap | `swap_tokens`, `get_swap_quote` | `swap.rs` |

A transfer is three synchronous calls:

```text
wallet_buildTransaction(chainID, sendTxArgs)   → messageToSign, txArgs
wallet_signMessage(messageToSign, from, pass)  → the signature
wallet_sendTransactionWithSignature(chainID, "WalletTransfer", txArgs, sig)
```

Registration and swap go through the Router — their common mechanism
(subscribing to the library's signals, waiting for the right signal by
`uuid`, splitting the signature into `{r,s,v}`) is factored out into
`router.rs`. Duplicating it in two modules would guarantee a divergence.

**Why this is a principle.** `wallet_signMessage` signs any 32 bytes with
the wallet key and does not know what the bytes are. If this sequence lived
in the webview, any XSS would have the password and a universal signing
machine: a foreign script could sign a transaction it built, "send
everything to this address". The same principle is applied to the seed
phrase (`seed.rs`) and to updates (`updater.rs`).

**The password** comes from the frontend once per session (as in mobile
Status), is kept in the store's memory, is not written to disk and is wiped
on logout of the account. In Rust it lives only inside the call.

### 5.5. The network fee

`estimate_transfer_fee` builds the transaction with the same code as sending
(`send_args`) and reads `gas` and `gasPrice` from it — the numbers are
exactly what will go out. There is no separate estimation method in
`status-go` for this path.

A known limitation: on testnets `eth_estimateGas` underestimates the limit
(21000 against the real ~204 600), so in the UI the amount is signed as an
estimate. For a swap and registration the fee comes from the built route
(`TxTotalFee`); when the route is not built, it shows `null` — "unknown",
not zero.

### 5.6. Market

`market.rs` (Rust) + the Market tab. Unrelated to `status-go`:
`fetch_market_data` does a `reqwest` to CoinGecko, caches for 60 seconds,
returns `Vec<MarketCoin>`. The numeric fields are `f64` (CoinGecko gives
floats), and `#[serde(default)]` protects against a missing
`price_change_percentage_24h`.

Market data does **not** go through `status-go`: it can serve it, but that
pulls in `market-proxy` and its caches.

### 5.7. dApp windows

`open_dapp` creates a separate window with `WebviewUrl::External`. That is
isolation: the dApp has no access to the main window's
`window.__TAURI__`, and its crash does not drag Stauri down. External links
are opened by the system handler (`opener.rs`), not inside the webview.

### 5.8. Build and release

`scripts/release.sh` builds the AppImage:

1. `pnpm tauri build`. Bundling is turned on by the script itself: in
   `tauri.conf.json` there is `"targets": []`.
2. The `AppDir` is assembled by hand: `libstatus.so` into `usr/bin/` (next
   to the executable, exactly where `library_path` looks), `libsds.so` into
   `usr/lib/`, the library's `RPATH` patched to an `$ORIGIN`-relative path,
   and an `AppRun` with a scrubbed `LD_LIBRARY_PATH`.
3. `linuxdeploy` runs with `NO_STRIP=1`.
4. It is checked that `libsds.so` is inside the AppImage and that
   `libstatus.so` loads under the inherited `LD_LIBRARY_PATH` (through
   `ctypes`).

`libstatus.so` and `libsds.so` are **not rebuilt** in `release.sh` — they
must be built in Nix beforehand and live in `src-tauri/binaries/`.

### 5.9. Updates

Checking and installing are in Rust (`updater.rs`), not in a JS plugin:
the webview is the most vulnerable place, and `updater:default` would give
the page the right to run the installation itself. The permission is absent
in `capabilities/default.json`; the frontend goes through
`check_for_update` and `install_update`.

The release order: generate a key (`pnpm tauri signer generate`), put the
public half into `tauri.conf.json`, build with
`TAURI_SIGNING_PRIVATE_KEY_PATH`, upload the `AppImage`, the `.sig` and the
`latest.json`. `release.sh` builds a `latest.json` with the key
`linux-x86_64` — that is the platform name in `tauri-plugin-updater`, and
the key must not be changed.

On Linux the file is replaced in place, so a restart is needed after the
installation.

## 6. The window's permissions and limits

The CSP **is set**, but not in Tauri, in SvelteKit — `svelte.config.js` →
`kit.csp`. In `tauri.conf.json` the `"csp"` is `null` on purpose: Tauri with
a non-null `csp` rewrites the HTML through `set_csp`, and two policies
multiply under the CSP rules, where Tauri's `script-src 'self'
'unsafe-inline'` would nullify the SvelteKit hash.

`mode: 'auto'`: in production SvelteKit hashes the inline bootstrap and
inserts a `content-security-policy` meta tag into `build/index.html`; in
dev it stamps nonces. The active directives:

- `script-src 'self'` + the bootstrap hash — **without** `unsafe-inline`,
  so a foreign script from a `status-go` reply or a feed will not execute;
- `style-src 'self' 'unsafe-inline'` — needed for Tailwind and Svelte's
  inline styles;
- `img-src` — only `self`, `data:`, `blob:` and two CDNs (token logos,
  Market images);
- `connect-src` — `127.0.0.1` (HTTP and WS), GitHub, `ipc:`;
- `object-src 'none'`, `base-uri 'self'`.

The second layer is `capabilities/default.json`: `core:default` and closing
the window. No `websocket`, `http` or `shell` plugin in capabilities: the
webview does not open network connections itself, everything goes through
Tauri commands.

The `127.0.0.1` in `connect-src` is a leftover of the sidecar architecture.
The webview no longer calls it, so the entry can be removed in a separate
fix.

A practical consequence we already tripped over: a resource from a CDN not
listed in `img-src` (say, a QR generation service) will not load in the
webview, and it looks like a "broken feature". That is why the QR is drawn
locally, and token logos are loaded by Rust and served through the
`img-src`-allowed domains or as locally drawn data.

**What the CSP does not cover.** It forbids executing a foreign script, but
it does not protect from a script that is already inside our bundle or
arrived through an allowed channel. That is why the session password and the
seed phrase remain the compromises described in §5.4: they are available to
the code that runs in the webview, and that is deliberate.

## 7. Why exactly this way (alternatives)

| Alternative | Why it was not chosen |
|---|---|
| Run `status-go` as a sidecar (the old way) | Two processes, a local port and a token; a separate lifecycle and PID files. The move was chosen for one code base on every platform |
| Link `status-go` as a library | Chosen: a backend crash = an app crash, the versions are hard-coupled. The price is accepted (§1) |
| Call `status-go` from JS directly | No `reqwest`/`tokio`, no process management, no signing in a safe place |
| Keep all state in one store | The stores start to depend on each other; the tests get harder |
| Sign transactions in the webview | An XSS gets the password and a universal signing machine |
| Talk to the blockchain directly from the UI | No keystore, no multichain; `status-go` is still needed for the messenger |
| Use the ready `status-desktop` | A QML monolith; no modularity, no dApp isolation, no Svelte |
| Take market data from `status-go` | It pulls in `market-proxy` and its caches |
| Fork `status-go` | Too much criticism from the SIM/Logos authors; living on the public contract is simpler |

## 8. Invariants

1. The UI does not call the `status/*` boundary directly — only through
   stores.
2. `status/http.ts` is the only place where a call becomes a Tauri command
   and an error is parsed.
3. `status-go` reply bodies are never logged (the seed phrase is in them).
4. `processSignal` is synchronous; asynchronous reactions start separately.
5. `connectionStore` is the only one that knows the startup and login order.
6. The password and the signature do not leave Rust; an intent sticks out.
7. Router signals are parsed in Rust, not in the webview.
8. dApp windows are isolated from the main window.
9. Rust commands are the only way to talk to the OS and to external APIs.
10. Market does not depend on `status-go`; it can be disabled without
    breaking the wallet.
11. `libstatus.so` and `libsds.so` come from one Nix environment.
12. The network and its mode (mainnet/testnet) are set **twice**: by the
    Rust config (`STAURI_NETWORK`) and by the `test-networks-enabled?` flag
    for `status-go`. They are different things, and forgetting the second
    has already happened.
13. External addresses are checked on **every** hop: the original
    `validate_external_url` and each redirect separately
    (`fetch_following_redirects`). Checking only the first address is
    decorative — the built-in redirect following of `reqwest` would go
    anywhere.
14. Secrets are cleared on logout of the account: the password
    (`resetSend`) and the seed phrase (`clear_seed`). The phrase must not
    survive a change of profile.

## 9. What to change when adding a feature

**If the fix touches `src-tauri/src/core/`** — that is not an ordinary fix.
The core holds the keys, so:

1. the change requires review (`.github/CODEOWNERS`);
2. a new file in the folder or a new command in the core — add it to
   `core/surface.rs` (its test fails until the list is updated);
3. if the contract changes (commands, their arguments) — check that the
   frontend goes through `status/*.ts`, not a direct `invoke`.

**A `status-go` method that answers with a result** (say, a new read):

1. a wrapper in `status/wallet.ts` (or `messaging.ts` for chats).
2. an action in the store.
3. the UI reads the store.
4. tests: unit tests of the utility/store, and where needed — a
   `statusFetch` test.

**A method that answers with a signal:** the signal is parsed where the
operation is orchestrated. If it is a money operation — in Rust
(`router.rs`), following the pattern of `ens.rs` and `swap.rs`. If it is a
UI event (`messages.new`) — in `processSignal`.

**An external API:**

1. `src-tauri/src/<module>.rs` — a command with `reqwest` and a cache.
2. `invoke('<command>')` from the store (top-level arguments — **camelCase**,
   fields inside `request` — snake_case per serde).
3. the UI renders.
4. tests: pure logic — with unit tests, the request — by a manual check.

**A money operation:** a Rust command returning only the result
(hash/amount). No "sign this" sticks out.

## 10. References

- `networks_and_balances.md` — the path of a balance to the screen, the
  caches, the forwarder.
- `status_outdated_architecture.md` — why `status-go` is built the way it is.
- `providers_and_dapps.md` — external sources, stores, dApps.
- `akk_scheme.md` — the Author → Channel → Comments scheme.
- `tests.md` — the test levels.
