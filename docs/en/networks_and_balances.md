# Networks and balances: how it works

This document traces the path from backend start to the balance number on the
screen: which calls happen in which order, what gets cached, and where things
break. It was written after debugging the "RPC unavailable, no network returns a
balance" bug.

Two facts about `status-go` drive almost all of the behaviour below, so we start
with them.

1. **The RPC client is cached forever.** `internal/rpc/client.go:200`
   (`getClientUsingCache`) keeps `rpcClients[chainID]` and never resets it when
   network settings change. The client is built from the providers that were in the
   database at the moment of the first request, and it lives until
   `StatusNode.Stop()`.
2. **`wallet_fetchOrGetCachedWalletBalances` is a pure cache read.** The
   `forceRefresh` parameter in `pkg/services/wallet/api.go` is ignored. The cache
   is filled by the background `MultistandardBalanceController`, not by our
   request.

Hence the rule: **providers must be written before `status-go` first touches a
network**, and **balances must be re-read ourselves on a timer**.

---

## 1. Component map

| Component | File | Role |
|---|---|---|
| `rpc_proxy.rs` | `src-tauri/src/core/rpc_proxy.rs` | Local HTTP forwarder `http://127.0.0.1:43057/<secret>/<chainId>` |
| `connection.svelte.ts` | `src/lib/stores/connection.svelte.ts` | `connect` / `login` / `createAccount`, network mode |
| `connectionStore.svelte.ts` | `src/lib/stores/connectionStore.svelte.ts` | Facade: re-exports the same functions for older code |
| `rpcConfig.ts` | `src/lib/stores/rpcConfig.ts` | `configureWalletRpc`: forwarder + providers |
| `walletStore` | `src/lib/stores/walletStore.svelte.ts` | Addresses, balances, metadata, prices, polling |
| `wallet.ts` | `src/lib/status/wallet.ts` | `wallet_*`, `ens_*`, `networks_*` wrappers |
| `http.ts` | `src/lib/status/http.ts` | Transport: `statusFetch` through the auth proxy |
| `statusStore` | `src/lib/stores/statusStore.svelte.ts` | Connection state, WS signal parsing |

`status/api.ts` is a re-export: the wallet wrappers moved to `wallet.ts`, the
chat ones to `messaging.ts`. New code has no reason to import from it.

---

## 2. Startup order

The order is not style; it is a requirement of fact #1. Breaking any pair of
neighbouring steps produces exactly the bug that was debugged.

```
connect()                        — connection.svelte.ts
  start_backend (Tauri)
     ↓
  initializeApplication          — opens the DB, reads the accounts
     ↓
  openWs                         — WS /signals
     ↓
  configureWalletRpc             — forwarder + providers (see §3)
                                 ← BEFORE login

login() / createAccount()
  loginAccount → node.login      — the node starts, the wallet does a full fetch immediately
     ↓
  applyNetworkMode               — settings_saveSetting('test-networks-enabled?')
     ↓
  configureWalletRpc             — again: the networks are registered by now
     ↓
     ├─ modeChanged or wroteProviders?
     │     → logout → node.stopped → loginAccount
     │       → configureWalletRpc → startMessenger
     ↓
  wakuext_startMessenger         — the messenger creates its RPC clients

loadWallet() in walletStore      — when the Wallet section appears
  wallet_startWallet → addresses → balances → prices
     ↓
  poll every 3 s (startWalletPolling)
```

Why `startMessenger` comes **after** `configureWalletRpc`: at start the messenger
touches the network (curated communities, token metadata). The first touch creates
the RPC client — and if only the embedded providers are in the database at that
moment, the client is built from them forever.

Why `configureWalletRpc` is called twice: the first call happens before login and
cannot write providers yet — `networks_*` is not registered
(`initServices` runs after the node starts). It brings up the forwarder; the
providers are written by the second call.

Why the network mode is set only in `login()`: `settings_*` is registered in the
same `initServices`, that is after the node starts, and the node starts inside
`loginAccount`. In `connect()` the call would return "method not found".

### 2.1. Node restart (new profiles only)

The second `configureWalletRpc` call is not enough for a new profile. The node
starts inside `loginAccount`, and its wallet immediately starts
`MultistandardBalanceController` → `TriggerFullFetch` → the first
`EthClient(chainID)` request. The client is cached and lives until
`StatusNode.Stop()`, and the embedded providers are still the only ones in the
database at that point. The providers written by the second call reach only the
next client.

So `configureWalletRpc` returns `{ wroteProviders }` — a flag that the write
actually happened. If it did, login is repeated once:

```
logout → wait for node.stopped → loginAccount → configureWalletRpc → startMessenger
```

Two correctness conditions:

- **Waiting for `node.stopped` is mandatory.** Logging in before the node has
  stopped returns the same live node with the old cache. The wait must be
  registered *before* `logout`, otherwise the signal can be missed: the node
  stops asynchronously, and `node.stopped` may arrive before the call returns.
  See `waitForNodeStopped` in `statusStore.svelte.ts`.
- **`isLoggedIn` is reset on `node.stopped`.** Otherwise `waitForLogin`
  resolves at once from the stale flag and the second login waits for nothing.

On later starts the provider is already in the database, `wroteProviders` is
`false`, and there is no restart — no extra seconds on every start.
`InitEmbeddedNetworks` at node start persists the user providers, so the new
client is built with `stauri-rpc`.

`waitForNodeStopped` does not throw on its 15 s timeout: if the signal was lost,
login continues — an infinite wait would block the app.

The forwarder comes up **first** and independently of `status-go`. It is a Tauri
command, always available; the provider from the previous start is already in the
database and may be requested immediately — by that point the proxy must be
accepting.

---

## 3. The local forwarder

### Why

`traffic.PrivateTransport` in `status-go` is a clone of `http.DefaultTransport`
with a keep-alive connection pool. In this channel connections die silently: the
socket stays `ESTAB`, packets go out, no answers come, retransmissions
accumulate to `tcp_retries2`. A request hangs for 20 s (the circuit breaker
timeout) and fails. `curl`, which opens a fresh connection per request, works
fine under the same conditions.

So the provider points not at the network but at a local forwarder that opens a
fresh connection for every request.

### Layout

```
status-go ──HTTP──> 127.0.0.1:43057/<secret>/<chainId> ──reqwest──> upstream
```

- **Fixed port: 43057** (`PREFERRED_PORT`). Mandatory: the provider URL is stored
  in the `status-go` database and survives app restarts. If the port is busy (an
  old instance is alive), the forwarder **does not start** and returns an error
  explaining "close the other copy". Falling back to a random port is not an
  option: the providers in the database point at 43057, and the node's client
  would still go there — to someone else's process.
- **The secret is in the path, not the header:** `/<secret>/<chainId>`. The
  forwarder is called by `status-go`, which cannot add our header. A wrong secret
  and any unknown path get `404`, not `403`: a `403` would confirm that
  something listens on the port and invite guessing.
- **The secret lives in a file**
  (`<config_dir>/<APP_IDENTIFIER>/rpc-proxy.secret`, permissions `0600`), not in
  memory: the URL with the secret is written into the `status-go` database and
  must keep working across restarts.
- **Pooling off:** `reqwest::Client::builder().pool_max_idle_per_host(0)`.
  Each connection lives for one request. That is the point.
- **Routing by path:** `/<chainId>`. The `chainId → URL` table is set by the
  `set_rpc_upstreams` command.
- **Responses:** `200` with the upstream body, `503` when the chain has no
  upstream, `502` with the JSON-RPC error when the upstream did not answer.
  Exactly the JSON-RPC error, not a silent drop: otherwise `ethclient` sees an
  EOF and retries a request whose cause is already known.
- **Limits:** 64 KB headers, 32 MB body.
- **`Connection: close`** on every response — the connection is reused in
  neither direction.

The forwarder does not look at the request body: it passes bytes through.
Authorisation (the API key) lives in the upstream URL, so the key never leaves
the machine — only the request to the provider itself goes out.

### Tauri commands

| Command | Purpose |
|---|---|
| `start_rpc_proxy` | Start the forwarder, return the port |
| `set_rpc_upstreams` | Set `{chainId: url}`, changeable at runtime |
| `stop_rpc_proxy` | Stop (called on exit) |

---

## 4. Provider selection

```ts
// $lib/config/keys.ts
export const PUBLIC_RPC = { 1: 'https://ethereum-rpc.publicnode.com', … };
export const ALCHEMY_HOSTS = { 1: 'eth-mainnet', … };
export function rpcUrlForChain(chainId) { return PUBLIC_RPC[chainId] ?? alchemyUrlForChain(chainId); }
```

Primary is **publicnode**: eleven networks — five mainnets and six testnets
(Sepolia, BSC-testnet, Optimism Sepolia, Base Sepolia, Arbitrum Sepolia, Hoodi).
Alchemy from `VITE_ALCHEMY_KEY` is only a fallback, for the networks in
`ALCHEMY_HOSTS`.

Why: Alchemy returns 403 for L2s not in its plan (`opt-mainnet`,
`base-mainnet`, `arb-mainnet` come back as `403`), and on this machine it also
dies silently — the connection is `ESTAB`, no answers. publicnode answers in
0.12–0.18 s for the same 300 multicall requests.

The testnets in the table are not "just in case": with
`test-networks-enabled?` on, `status-go` counts exactly them active, and a
network without a URL has no provider at all — no balance comes for it.

Providers are written only for active networks:

```ts
if (!chainId || !chain.enabled || !chain.isActive) continue;
```

**The field names are `enabled` and `isActive`**, as in `params.Network`. There
is no `active` field; filtering on it silently selects 0 networks and no
providers appear at all. This mistake already cost one full debug cycle.

Writing the provider:

```ts
const url = `http://127.0.0.1:${proxyPort}/${proxySecret}/${chainId}`;
await setChainUserRpcProvider(port, chainId, 'stauri-rpc', url);
```

The name `stauri-rpc` is also used to check "already added": before writing,
**both the name and the URL** are compared. The provider may be a leftover from
an earlier configuration with a dead address on this machine — then it must be
rewritten, not accepted.

The write goes through `networks_setChainUserRpcProviders`.
`status-go`'s validation (`pkg/services/networks/validate.go`) checks only the
auth fields; `http://` and loopback are not forbidden. `InitEmbeddedNetworks`
persists the user providers on login (`network.go:168`) and does not clobber
them. `Find()` reads the database on every call, so a write before the first
`EthClient` is picked up.

---

## 5. Wallet addresses

This is where the main bug lived. A profile has several addresses, and they are
not equivalent:

| Field | Example | A wallet? |
|---|---|---|
| `wallet-root-address` (from `settings_getSettings`) | `0xf538b590…` | **no** |
| `address` (the root account) | `0x4c9ce7e3…` | no |
| `dapps-address` | `0x8d5a8c80…` | no |
| the account with `chat = false` | `0x8d5a8c80…` | **yes** |

The balance controller computes for addresses from `keypairs_accounts` with the
filter `chat = 0 AND removed = 0`
(`internal/db/multiaccounts/accounts/database.go`, `GetWalletAddresses`). In a
profile these are the regular accounts — the ones the UI shows as "Account 1".

A request for `wallet-root-address` returns **an empty result**: that address
simply has no key in the cache. An empty answer is easy to mistake for "all
balances errored" and go fix providers that are not involved.

So addresses come from `accounts_getAccounts`, with `chat` filtered out:

```ts
const accounts = await getAccounts(port);
const addresses = accounts.filter(a => a && a.address && !a.chat).map(a => String(a.address));
```

and **all** of them are passed to the balance request: the answer carries an
entry for every requested address, and tokens are collected across all of them.

---

## 6. Balances

### Response format

```jsonc
{
  "0x8d5a…": [
    { "tokenAddress": "0x0000…", "tokenChainId": 1, "rawBalance": "1000000000000000000", "hasError": false }
  ]
}
```

`StorageToken` carries **no `symbol` and no `decimals`**. Without them a balance
cannot be signed or converted to human units. Metadata comes from a separate
`wallet_getTokensForActiveNetworksMode`, matched on the
`(chainId, tokenAddress)` pair:

```ts
function tokenKey(chainId: number, address: string) { return `${chainId}:${address.toLowerCase()}`; }
```

`rawBalance` is in the smallest unit (wei). `formatBalance` in the UI expects
exactly that.

### `hasError`

It means "the RPC did not answer", not "the balance is zero". Three states are
kept apart:

| Situation | What we show |
|---|---|
| 0 tokens | "Token catalog is empty" — fix networks/tokens, not providers |
| All tokens `hasError` | "RPC unavailable" — fix the providers |
| Some `hasError` | A label on the specific tokens |
| All clean | Nothing extra |

Zero balances are **not** discarded: otherwise an unavailable network looks like
an empty wallet, and a genuinely zero balance looks like an error. Sorting:
non-zero first, then by symbol (`groupAssets` in `utils/assetGroups.ts`).

### Polling

`wallet_fetchOrGetCachedWalletBalances` reads the cache; `forceRefresh` is
ignored. The cache is filled by the background controller, so the UI re-reads it
every 3 s (`startWalletPolling`). `wallet_startWallet` is called **once per
session** (`walletState.loaded`); repeated calls are meaningless.

`rpcError` is **not cleared at the start of a poll** — it is only overwritten
by the answer. Otherwise every tick removes the banner for an instant and the UI
flickers between the error and a list of zeros.

### Prices and total balance

The wallet total (`utils/totalBalance.ts`) is computed from the same balances
and separately loaded prices — there is no separate balance request.

Prices come from `wallet_fetchPrices`, not CoinGecko directly: `status-go`
already matches tokens to CoinGecko via `crossChainId`.

Two silent traps:

- **The price token key uses a hyphen:** `"{chainId}-{lowercased address}"`.
  Everywhere else (metadata, the store's `tokenKey`) it is a colon. Only the
  price key is hyphenated; with a colon the backend returns emptiness without an
  error.
- **Only mainnet tokens are requested** for prices, non-zero balance, no
  `hasError`: `mapTokensToIds` drops everything that is not mainnet, so testnet
  tokens get no prices at all.

The total includes only the five mainnet networks (Ethereum, Optimism, BNB
Chain, Base, Arbitrum). Tokens without a price are not dropped but labelled
("some tokens have no price") — otherwise a wallet with a new token would show
`≈ $0`.

### When the token catalog is empty

`wallet_getAllTokens` = 0, `wallet_getAllTokenLists` = "Community tokens" only,
`wallet_getBlockchainHealthStatus` → `statusPerChain: {}` (no requests to the
network). The catalog was not filled, and the controller has nothing to
request. This is **not** an RPC error; the symptom is 21 tokens with
`hasError` while network requests remain unfulfilled.

---

## 7. Debugging

Start with the catalog. It answers "did any request happen at all?":

```bash
P=$(ps -o args= -p $(pgrep -f 'status-backend -address') | grep -oE '127\.0\.0\.1:[0-9]+' | cut -d: -f2)
call() { curl -s --noproxy '*' -X POST "http://127.0.0.1:$P/statusgo/CallRPC" \
  -H 'Content-Type: application/json' -d "$1"; }

call '{"jsonrpc":"2.0","id":1,"method":"wallet_getAllTokens","params":[]}' | head -c 200
```

Signs that distinguish the causes:

| Observation | Cause |
|---|---|
| `wallet_getAllTokens` = 0 | Token catalog not filled — providers are not involved |
| Catalog full, `statusPerChain: {}` | Never reached the network |
| Log shows `dial tcp: lookup …rpc.grove.city: no such host` | Embedded providers in use, ours was not written |
| `stauri-rpc` present, `enabled=True`, no connections to 43057 | The RPC client was built before the provider write (see fact #1) |
| All tokens `hasError`, connections to 43057 present | The upstream is down, not `status-go` |

Connection counter to the forwarder:

```bash
ss -tnp | grep "pid=$(pgrep -f 'status-backend -address')" | grep -c :43057
```

The forwarder itself, bypassing `status-go`. The path must include the secret —
without it (and with a wrong one) the forwarder answers `404`:

```bash
S=$(cat ~/.config/com.magnus.stauri-app/rpc-proxy.secret)
curl -s --noproxy '*' -X POST "http://127.0.0.1:43057/$S/1" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

Provider health per network:

```bash
call '{"jsonrpc":"2.0","id":1,"method":"wallet_getBlockchainHealthStatus","params":[]}'
```

### Debug traps

- **The profile log stops being written.**
  `…/mainnet/status.log/<key>.log` can "freeze": an unchanged file size does
  not mean "nothing is happening". You cannot rely on the absence of lines
  there. The pre-login log is a separate file,
  `~/.config/Status/logs/pre_login.log`.
- **Cached answers.** `wallet_fetchOrGetCachedWalletBalances` returns the same
  thing until the controller overwrites the cache. Comparing answers before and
  after a "fix" is pointless.
- **A stale process.** Check the process start time against the file edit time:
  a store edit does not apply to an already running app.
- **`wallet-root-address` ≠ the account address.** See §5.
- **An empty result ≠ an error.** An empty answer for a foreign address looks
  like every network failed.

---

## 8. Invariants, in short

1. The forwarder listens on the fixed port `43057`; providers point only at
   `http://127.0.0.1:43057/<secret>/<chainId>`. A busy port is an error, not a
   reason to move to a random one.
2. The forwarder comes up before every network request and does not depend on
   `status-go` readiness.
3. Providers are written **before** `wakuext_startMessenger` — otherwise the
   RPC client is built from the embedded providers forever.
4. If providers had to be written (`wroteProviders`) **or** the network mode
   changed (`modeChanged`), the node restarts once: `logout` → `node.stopped` →
   `loginAccount`. On later starts this does not happen.
5. The network filter is `enabled && isActive`.
6. Balance addresses are accounts with `chat = false`, not
   `wallet-root-address`.
7. `symbol` and `decimals` come from `wallet_getTokensForActiveNetworksMode`
   and are matched on `(chainId, tokenAddress)` — with a **colon**. The key for
   `wallet_fetchPrices` — with a **hyphen**. Swapping them means a silent empty
   result.
8. Balances are re-read on a timer; `forceRefresh` does not work.
9. Zeros are shown, `hasError` is not hidden, the three states (empty catalog /
   RPC unavailable / all fine) are kept apart in the UI.
10. Response bodies do not enter the logs, and keys in URLs and parameters are
    scrubbed (`logging::redact`).
