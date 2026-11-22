# Testing Stauri

This document describes what is tested and how, why these particular tools
were chosen, and where the boundaries between test levels lie.

Current numbers as of 2026-11-22: **160 Rust tests**, **402 frontend tests in
39 files**, 1 E2E scenario.

## 1. Levels

| Level | Tool | What it checks |
|---|---|---|
| Rust unit | `cargo test` | Network configuration, the forwarder, both proxies, signing and routes, feed parsers, secret scrubbing |
| Frontend unit | Vitest + happy-dom | Stores, utilities, `statusFetch` wrappers, error parsing |
| Frontend component | Vitest + `@testing-library/svelte` | Svelte components (forms, lists) |
| E2E | Playwright | Launching Tauri, starting `status-backend`, rendering and entering a password |

The boundary: **unit tests do not start `status-backend`**. Anything that needs
a real backend is either mocked, moved to E2E, or checked by hand (§5).

## 2. Rust unit tests

They live in `#[cfg(test)]` modules next to the code, not in separate files: the
`split_signature` test sits in `router.rs`, the `validate_username` test in
`ens.rs`.

```bash
cd src-tauri
cargo test
```

Coverage by module (🔒 — a file in `src/core/`, the safety core):

| Module | Tests | What it checks |
|---|---|---|
| `transfer.rs` | 17 | Building `sendTxArgs`, ERC-20 `transfer` encoding, amount precision, stripping `0x` from the signature only, identical arguments for fee estimation and sending |
| 🔒 `credentials.rs` | 16 | PIN → password round-trip, different PINs give different keys, a wrong PIN fails the tag |
| 🔒 `pairing.rs` | 16 | The connection string, confirmation codes, refusals on garbage input |
| 🔒 `lanpair.rs` | 8 | Discovery and the six-digit handshake, refusal on a wrong code |
| `logging.rs` | 11 | Scrubbing keys from URLs, JSON fields, `user:pass@`, and splits between `write`s |
| `router.rs` | 11 | Parsing a 65-byte signature, normalizing `v` 27/28 → 0/1, extracting hashes from both signals |
| `swap.rs` | 10 | The network list, `min_amount_out` under slippage, refusing testnets, `tokenKey` |
| `providers.rs` | 13 | SSRF filter (loopback, private, link-local), RSS/Atom and Telegram HTML parsing, the item limit |
| `ens.rs` | 9 | Name validation, different forms of the name for `ens_ownerOf` and `ens_expireAt`, `tokenKey`, route parameters |
| `opener.rs` | 8 | `http(s)`/`mailto` schemes, the `t.me` deeplink for a post, no deeplink for a lookalike host |
| `config.rs` | 11 | Networks, `data_dir_suffix`, fallback RPC URL, `save_network` (the preset is written, other keys are kept, an unknown network creates no file) |
| 🔒 `rpc_proxy.rs` | 6 | JSON-RPC forwarding, 503 with no upstream, 502 from a dead one, the secret in the path, changing the upstream without a restart |
| `invite.rs` | 5 | Parsing SIM links, a varint across a byte boundary, a garbage payload |
| 🔒 `seed.rs` | 3 | Parsing the `settings_getSettings` response, refusing an envelope instead of a phrase |
| 🔒 `error.rs` | 3 | Error kinds, serialization |
| `dapp.rs` | 2 | The window label: stable and safe |
| 🔒 `surface.rs` | 2 | The `core/` file set is unchanged; the command surface did not silently grow |
| `profile.rs` | 6 | Avatar: size, type, writing under the profile directory |
| `commands.rs` | 1 | The `InitializeApplication` body uses `dataDir`, not an invented field |
| 🔒 `backend.rs` | 1 | The library name and lookup |
| `updater.rs` | 1 | camelCase in `UpdateInfo` |

What is not covered (and why):

    Real status-backend behaviour — that is E2E or a manual check.

    Network calls of the Router (route building, signing, sending) — needs a
    live backend with a balance; checked by hand per §5.4.

    `reqwest` to an upstream — only through a mock server in the `rpc_proxy`
    tests.

## 3. Frontend unit tests (Vitest)

Configuration is in the `vitest` section of `vite.config.js`: the `happy-dom`
environment, `setupFiles: ['./src/test-setup.ts']` (a `$lib/i18n` mock that
returns the key instead of the translation).

```bash
pnpm test          # one run
pnpm test:watch    # watch
pnpm test:e2e      # Playwright
pnpm tests         # frontend + rust in a row
```

### 3.1. What is mocked

| Mock | Why |
|---|---|
| `@tauri-apps/api/core` (`invoke`) | Not to run Rust commands |
| `@tauri-apps/plugin-http` (`fetch`) | Not to go to the network |
| `@tauri-apps/plugin-websocket` | Not to open `/signals` |
| `$lib/status/api` / `$lib/status/wallet` | Isolate the store from status-go |
| `$lib/status/messaging` | Isolate the chat list from the backend |
| `$lib/utils/user` | Substitute the "own message" determination |
| `./statusStore.svelte` | Isolate the store from global state |
| `$lib/i18n` | Return the key instead of the translation |

`walletStore.test.ts` mocks **`$lib/status/wallet`**, not `$lib/status/api`:
the wallet wrappers moved to `wallet.ts`, and the `api` mock no longer caught
them — the calls went into the real `statusFetch`. That mistake has already
happened and cost green tests that checked nothing.

### 3.2. What is covered, by file

| File | Tests |
|---|---|
| `stores/chatsStore.test.ts` | 51 |
| `stores/connectionStore.test.ts` | 30 |
| `entry/entryFlow.test.ts` | 20 |
| `utils/amount.test.ts` | 19 |
| `status/api.test.ts` | 18 |
| `utils/assetGroups.test.ts` | 18 |
| `stores/feedsStore.test.ts` | 16 |
| `utils/password.test.ts` | 16 |
| `utils/totalBalance.test.ts` | 16 |
| `stores/statusStore.test.ts` | 14 |
| `utils/tokens.test.ts` | 14 |
| `status/credentials.test.ts` | 12 |
| `stores/navStore.test.ts` | 12 |
| `sections/home/aboutSections.test.ts` | 11 |
| `status/messaging.test.ts` | 11 |
| `status/http.test.ts` | 10 |
| `stores/walletStore.test.ts` | 10 |
| `utils/explorer.test.ts` | 8 |
| `utils/format.test.ts` | 8 |
| `sections/auth/PasswordInput.test.ts` | 7 |
| `sections/auth/ProfileLoginBlock.test.ts` | 7 |
| `status/profile.test.ts` | 6 |
| `stores/sendStore.test.ts` | 6 |
| `sections/auth/NetworkPicker.test.ts` | 5 |
| `status/channelRights.test.ts` | 5 |
| `status/contactState.test.ts` | 5 |
| `stores/contactsStore.test.ts` | 5 |
| `utils/displayName.test.ts` | 5 |
| `utils/markdown.test.ts` | 5 |
| `locales.test.ts` | 4 |
| `sections/auth/MainEntryScreen.test.ts` | 4 |
| `sections/profile/NetworkInfo.test.ts` | 4 |
| `i18n-locale.test.ts` | 3 |
| `sections/contacts/ContactsLeft.test.ts` | 3 |
| `status/channelKind.test.ts` | 3 |
| `status/invite.test.ts` | 3 |
| `sections/chat/ChatLeft.test.ts` | 2 |
| `sections/home/aboutMarkdown.test.ts` | 2 |
| `status/akk.test.ts` | 2 |

What matters in the covered parts:

    walletStore — addresses from accounts_getAccounts (!chat), metadata from
    getTokensForActiveNetworksMode, zero balances not discarded, three
    rpcError states, reset, price keys.

    connectionStore — startup order, wroteProviders, node restart, recovery,
    `switchNetwork` (the profile list and the network are replaced from the
    command's answer; on failure the state is not touched),
    createAccount with and without keyUid.

    totalBalance — mainnet networks, a price without a token and a token
    without a price, bigint precision, the key separator.

    sendStore — failure classification: six distinguishable texts instead of
    "Failed".

    statusStore — processSignal (node.login, node.stopped, messages.new),
    resetState, setNetworkInfo.

    http — success, an empty response, an HTTP error, invalid JSON, an error
    as a string and as an object.

### 3.3. Writing rules

    One test — one assertion (or one logical group).

    Mocks in beforeEach, vi.clearAllMocks() — so tests do not affect each
    other.

    Do not test internals, only the public behaviour of the store.

    If a test requires status-backend, it is not a unit test — it is E2E or a
    manual check.

    Sorts — only with a comparator: `.sort()` without one sorts
    lexicographically, and `[1, 10, 56]` stays in the same order, so the test
    "passes" checking nothing. That has already happened twice.

## 4. E2E test (Playwright)

Configuration is in `playwright.config.ts`. It launches `pnpm tauri dev`, waits
for `http://localhost:1420`, and works with the window.

```bash
pnpm test:e2e
pnpm test:e2e:ui
```

One scenario is covered (`tests/e2e/app-flow.spec.ts`): the app comes up, the
"Stauri" heading appears, the password input is visible, a password is entered,
the action button is available.

What is not covered (and why):

    A full login with a real status-backend — slow and unstable: the first
    entry restarts the node.

    Wallet, sending, ENS, Swap — need a profile and money.

## 5. Manual checks

Some things cannot be checked automatically without a real `status-backend`
and a network. They are checked by hand.

### 5.1. A clean profile

    Delete ~/.local/share/com.magnus.stauri-app/mainnet.

    pnpm tauri dev, create an account, log in.

    Look for [restart], node.stopped, configureWalletRpc in the logs.

    Open Wallet: balances must have no hasError.

### 5.2. Logging in again

    Without deleting dataDir, restart the app.

    The logs must not show a node restart (the provider is already in the DB,
    wroteProviders === false).

    Balances must load at once.

### 5.3. The forwarder

```bash
S=$(cat ~/.config/com.magnus.stauri-app/rpc-proxy.secret)
curl -s --noproxy '*' -X POST "http://127.0.0.1:43057/$S/1" \
  -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
```

It must return `{"result":"0x..."}`. Without the secret in the path — `404`,
and that is the correct behaviour.

### 5.4. Money operations

Checked only with real money, step by step:
ETH transfer → ERC-20 transfer (`decimals ≠ 18`) → swap → name registration.

They cannot be automated: the result depends on the network, and the cost of a
mistake is real funds. So the path is checked first with a minimal amount.

## 6. What is missing (TODO)

    An integration test for the startup order with a real status-backend
    (currently — mocks only).

    A test for `waitForNodeStopped` on timeout: the function does not throw,
    but there is no test for it.

    Tests for `swapStore` and `ensStore`: currently they are covered only
    through Rust tests and a manual check.

    `rpc_proxy` coverage against a real upstream (currently — a mock server).

    A full login E2E scenario, at least on a testnet.

## 7. Invariants

    Unit tests do not start status-backend.

    E2E does not check business logic — only rendering and basic input.

    Everything that depends on the network and status-go caches is checked by
    hand.

    Mocks — only at the boundaries (`api.ts`, `wallet.ts`, `http.ts`, `invoke`),
    not inside the store.

    A test that passes on broken code is worse than none: before changing a
    test, check that it fails on the old version.
