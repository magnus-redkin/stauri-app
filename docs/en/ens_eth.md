# `.eth` names inside Stauri — plan

Status: not started. This is the plan for registering, renewing and managing
`*.eth` names in Stauri without a dApp browser.

Today the only name Stauri can register is `<name>.stateofus.eth`, the Status
username, which is a different registrar paid in SNT/STT. A regular `.eth` name
is bought through `app.ens.domains` in a browser wallet, and that is exactly the
flow this plan removes.

## What already exists

- **Arbitrary calldata transactions.** `wallet_buildTransaction` accepts `data`,
  and the chat-key rewrite (`ens.rs`, `update_ens_public_key`) already builds,
  signs and sends a hand-made `setPubkey` call. The machinery for "call this
  contract with these bytes" is in place.
- **keccak256 and namehash** in Rust (`sha3`, `ens.rs::namehash`), verified
  against `cast namehash`.
- **Address validation, password handling, signal waiting** — shared with
  transfers and the Router.

## What is missing

1. **Reads from the chain.** Rust talks to status-go methods only. The ENS
   registrar needs `available`, `rentPrice` and `makeCommitment`, and later
   `ownerOf`, `nameExpires` and record getters. None of them exist in the
   status-go ENS service (it covers `.stateofus.eth` only).
2. **ABI encoding for dynamic types.** The current calldata builders handle
   fixed-size words only. `register(string,address,uint256,bytes32,address,bytes[],bool,uint16)`
   needs a string and a dynamic array.
3. **The registrar service in Rust**: quote, commit, register, renew.
4. **Persistent commit state**: the secret and the commitment must survive a
   restart — the 60-second wait is the contract's, not ours.
5. **The interface**: search, availability, duration, price, commit → countdown
   → register, and the list of owned names with their expiry.
6. **Records**: primary name (reverse record), ETH address (`addr`); text
   records later.
7. **Tests and documentation.**

## Contracts (mainnet)

| Contract | Address |
|---|---|
| ETHRegistrarController (v3) | `0x253553366Da8546fC250F225fe3d25d0C782303b` |
| BaseRegistrar | `0x57f1887a8BF19b14fC0dF6Fd9B2acc9Af147eA85` |
| NameWrapper | `0xD4416b13d2b3a9aBae7AcD5D6C2BbDBE25686401` |
| ENS registry | `0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e` |

Sepolia has its own deployment; `.eth` names are not transferable between
networks, so the flow is mainnet-first and Sepolia is for testing.

## The flow (two transactions)

1. **Quote.** `available(name)`; `rentPrice(name, duration)` → `(base, premium)`;
   `makeCommitment(name, owner, duration, secret, resolver, [], reverseRecord, 0)`
   with a fresh 32-byte secret.
2. **TX1 `commit(commitment)`** — gas only. The controller remembers it for
   seven days.
3. **Wait at least 60 seconds** (the contract enforces a minimum age).
4. **TX2 `register(...)`** with `value = base + premium` — rent in ETH plus gas.
5. **Optionally**: reverse record inside `register` (`reverseRecord = true`),
   or `setAddr`/text records afterwards.

## Stages

**S1 — reads through the forwarder.** A small JSON-RPC client in Rust that
posts `eth_call` to the existing local forwarder
(`http://127.0.0.1:<port>/<secret>/<chainId>`), the same path status-go uses.
No new endpoints, no keys, and the workaround for stuck connections keeps
applying.

**S2 — ABI helpers.** Encoding and decoding for `string`, `bytes[]`, `address`,
`uint256`, `bool`, `bytes32`. Either hand-written with fixtures from `cast`, or
a small crate. Every builder gets a test with a vector produced by `cast`, and
the commitment is additionally checked by `eth_call` to `makeCommitment` before
it is used.

**S3 — the registrar in Rust.** Commands:
`ens_eth_quote`, `ens_eth_commit`, `ens_eth_register`, `ens_eth_renew`.
The price is read immediately before the transaction is built and is never
supplied by the webview; the secret is generated and stored on the Rust side in
the network data directory, next to the RPC secret.

**S4 — the interface.** A "Names" section: search with availability, duration
and price, commit → countdown → register, an explicit gas/fee confirmation, and
errors that say which step failed. Ownership and expiry come from the
BaseRegistrar.

**S5 — records.** `setAddr` and the reverse record first; text records after
that. Wrapped names are the open question here: the node owner is the
NameWrapper, so record changes may have to go through the wrapper — verify
before writing code.

**S6 — tests, docs, release.** Unit tests for encoding and for the state
machine (commit → wait → register, restart in the middle), a manual mainnet
check with a cheap name, and a documentation page.

## Risks

- **Encoding mistakes cost money.** A wrong `owner` or `duration` in the
  calldata registers the name to the wrong place or for the wrong term. Mitigate
  with `cast` vectors and a dry-run `eth_call` of the exact transaction before
  signing.
- **The price moves** between the quote and the send. Read it right before
  building and show it; the contract reverts if the value is wrong.
- **Gas spikes.** Show the fee, never auto-confirm; the user decides.
- **A restart in the middle of the wait.** The commitment stays valid for seven
  days, so the state must be persisted and offered again, not dropped.

## Out of scope for the first version

Subnames, fuses, transferring names, multi-coin records, renewal reminders.
