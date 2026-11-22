# status-go: why balances did not work, and why it is built this way

> **State as of 2026-11-08.** The bug is closed: providers point at the local forwarder
> `rpc_proxy.rs`, the node restarts once if providers had to be written, and balances
> arrive on every network. The document is kept as an analysis of causes — it explains why
> the code takes such strange steps, and it will be useful when `status-go` is replaced
> with Logos. The factual side of the fix is in `networks_and_balances.md`; here is why
> there was no other way.
>
> One clarification to the text below: the forwarder now requires a secret in the path
> (`/<secret>/<chainId>`), otherwise any local process could use our RPC. That does not
> change the analysis; the paths in the examples are simply different.

## 1. What an RPC provider is and why it is needed

A blockchain is a distributed database. To learn a wallet balance or send a transaction, an
application must query a node in the network. Running your own full Ethereum node means
hundreds of gigabytes and constant synchronisation. That is why almost every wallet uses RPC
providers — companies that run nodes and sell access to them over an HTTP API.

Stauri (like official Status) does not talk to the blockchain directly. It builds a
JSON-RPC request (for example `eth_getBalance` or `eth_call`) and sends it to the provider's
URL. The provider runs it on its node and returns the result.

Provider examples:
- PublicNode (`ethereum-rpc.publicnode.com`) — free, no key, no guarantees.
- Infura (`mainnet.infura.io/v3/<KEY>`) — commercial, stable, rate-limited.
- Alchemy (`eth-mainnet.g.alchemy.com/v2/<KEY>`) — commercial, stable, rate-limited.
- Grove (Pocket Network) — popular before, but it shut down in 2026 and `rpc.grove.city`
  domains no longer resolve.

The problem is not the providers themselves. It is how `status-go` manages the list of them.

## 2. How status-go is built inside (and why that is hard)

`status-go` has had a long evolution: since 2017 it was an Ethereum node for a DApp browser,
then became a messenger (2018–2020), and the wallet was only added in 2021+. Each new layer
was glued onto an old core that assumed neither multichain, nor user providers, nor L2.

### 2.1. Legacy: a Network with six URL fields

The `params.Network` structure historically had six fields for provider URLs:

```
DefaultRPCURL       string // Deprecated: proxy rpc url
DefaultFallbackURL  string // Deprecated: proxy fallback url
DefaultFallbackURL2 string // Deprecated: second proxy fallback url
RPCURL              string // Deprecated: direct rpc url
OriginalRPCURL      string // Deprecated: direct rpc url if user overrides RPCURL
FallbackURL         string // Deprecated
OriginalFallbackURL string // Deprecated
```

All of them are marked deprecated in new PRs but are still used. The developers admit it
themselves: "It's not clear why we need OriginalRPCURL, OriginalFallbackURL in this
datatype… Provider priority is implicit and not flexible".

Each new requirement (proxy, fallback, direct provider) added another field instead of
rewriting the structure.

### 2.2. setRPCs: token substitution by string match

`setRPCs` in `default_networks.go` takes the network list and `WalletSecretsConfig`
(Infura/Alchemy/Grove tokens passed at login) and pastes the tokens into provider URLs. But
it does so by substring search:

```go
authTokens := map[string]string{
    "infura.io":  request.InfuraToken,
    "grove.city": request.PoktToken,
}
```

A status-go developer writes in an issue: "setRPCs relies on string comparison in URLs which
is unreliable". And adds: "We have more than 10 API tokens configurable in
WalletSecretConfig and only 3 of them are actually respected by the setRPCs function. It
would be great to have other providers available for RPC calls. For example, the Alchemy."

So your Alchemy key is ignored simply because it is not in `authTokens`, and the Infura key
is substituted only into URLs containing `infura.io`.

### 2.3. getClientUsingCache: a cache that lasts forever

`getClientUsingCache` in `internal/rpc/client.go` keeps a `map[chainID]Client` and never
invalidates it when providers change. In issue #5937 a developer calls this "outdated
mechanisms rudiments in rpc/client.go that were added 7 years ago".

This is the key bug. When `status-go` first reaches a network (at messenger start, or by the
background balance refresher), it creates an RPC client built from the providers that were
in the database at that moment. If only a dead `direct-grove` was there, the client remembers
`grove.city` forever. Adding `stauri-rpc` afterwards through
`networks_setChainUserRpcProviders` changes nothing until the node restarts.

### 2.4. The built-in providers died, the config stayed

`default_networks.go` still lists `direct-grove` with URL
`https://<chain>.rpc.grove.city/v1/`. Grove shut down in 2026 and those domains no longer
resolve. In the health report it shows as
`dial tcp: lookup eth.rpc.grove.city: no such host` (366 errors out of 367 requests for
chainId 1).

`direct-infura` performs better (1 successful request for chainId 1), but on L2 (Optimism) it
hits `context deadline exceeded` — the Infura plan does not cover those networks, or the key
is wrong.

### 2.5. Summary: where the bug comes from

`stauri-rpc` (the local forwarder) was added to the config and is present in
`networks_getFlatEthereumChains` with `enabled: true`. But `status-go` does not go through
it, because:

1. the RPC client for each network was created before `stauri-rpc` reached the database;
2. `getClientUsingCache` does not invalidate on provider change;
3. so the client keeps using `direct-grove` (dead) and `direct-infura` (partly working),
   ignoring `stauri-rpc`.

This is not a Stauri bug. It is technical debt in `status-go` that the developers acknowledge
but have not fixed.

## 3. What the status-go developers propose

In issues #5933 and #5937 (opened in 2024–2025) they propose a concrete refactoring:

1. Move providers out of `Network` into a separate `ProviderConfig` type with a one-to-many
   relation (`Network → *ProviderConfig`).
2. Explicit provider priority (today priority is implicit and depends on field order).
3. Different tokens per chainID (today one token for all).
4. Use all available providers in the circuit breaker (today fallback behaves
   unpredictably).

Part of this is done: PR #6151 added an `rpc_providers` table and an `RpcProvider` type with
`type` (user/embedded), `authType`, `enabled`. But integration with `getClientUsingCache` is
not finished, and the cache still is not invalidated.

Developer `friofry` writes in an issue comment: "Removing both rps_limiter and
circuit_breaker and moving the provider logic to the proxy sounds better. (Basically, this
is what the proxy design pattern means)". So they themselves lean towards moving the
fallback/health-check logic out of `status-go` into a separate proxy layer. Our local
forwarder `stauri-rpc` is exactly what they propose, implemented on the client side.

## 4. Possible solutions

### Option A: restart the node after configureWalletRpc

The most reliable, but heavy. Once `stauri-rpc` is written, the node must be stopped and
started again (`stop_backend` + `start_backend`) so that RPC clients are rebuilt — now with
`stauri-rpc`. This is guaranteed to work, because the cache is empty at start.

Drawback: it changes the architecture (the node restarts after login, which is unusual).

### Option B: write stauri-rpc before the first RPC client

The first RPC client is created when `status-go` first reaches a network. That can be:

- the messenger at start;
- the background balance refresher at `wallet_startWallet`;
- `loginAccount` (network check).

If `configureWalletRpc` runs before any of these, the client is built with `stauri-rpc`. The
problem is that the `networks_*` service only becomes available after
`initializeApplication`, while `loginAccount` may create a client earlier.

It has to be checked when `networks_*` becomes available and `configureWalletRpc` called
right after that — before `loginAccount`.

### Option C: patch status-go (not recommended)

Add a direct Infura provider to `default_networks.go` with
`directURL: "https://mainnet.infura.io/v3/"` and make sure `setRPCs` substitutes
`InfuraToken`. About 10 lines of Go and a rebuild. But that treats the symptom: the cache is
still not invalidated, and the bug returns with the next provider change.

The status-go developers themselves say the right solution is a refactoring (providers into
a separate type + cache invalidation), not patches.

## 5. Short summary

| Question | Answer |
|---|---|
| What does a provider do? | A middleman between the application and the blockchain. Takes a JSON-RPC request, runs it on its node, returns the result. |
| Why is status-go complex? | Evolution from an Ethereum node (2017) into a messenger (2018) and a wallet (2021+). Layers were never rewritten. |
| Why does stauri-rpc not work? | `getClientUsingCache` caches the RPC client forever. The client was built before `stauri-rpc` reached the database. |
| Why is Alchemy ignored? | `setRPCs` looks for the substring "infura" or "grove" in the URL. Alchemy is not on the list. |
| Why is Grove dead? | Grove shut down in 2026; `rpc.grove.city` domains do not resolve. |
| What to do? | Either restart the node after `configureWalletRpc`, or write `stauri-rpc` before the first RPC client. |
| Is this growing pains? | No. It is the architectural debt of a mature project that did not refactor its core in time. The developers know about it; the rewrite simply never happened. |
