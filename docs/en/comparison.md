# Stauri and Status: a comparison

This document answers the question "why another client" — substantively. What is being
compared, the differences, Stauri's advantages and drawbacks, and then separately what
changes with a move to Logos.

Updated 2026-11-22.

Complements `architecture.md` (how Stauri is built).

---

## 1. What exactly is being compared

This is not "Status versus Stauri" in one row. Status has three layers, and Stauri replaces
only one of them.

| Layer | Status | Stauri |
|---|---|---|
| Core: network, crypto, wallet, DB | `status-go`, Go, **linked into the process** | the same `status-go`, **linked into the process** |
| Desktop client | `status-desktop`, Nim + QML | Svelte 5 + TypeScript in Tauri |
| Mobile client | ClojureScript + React Native | Svelte 5 + TypeScript in Tauri |

So "Stauri is an alternative to Status" is imprecise. More precisely: **an alternative
client over the same backend**. Protocol, encryption, identity and wallet are shared; what
differs is the interface layer and how the core is wired to it.

## 2. Architectural differences

### 2.1. The same core, a different way to build a client

Both load `status-go` into the application process: no sidecar, no local port, no proxy in
between. That is a deliberate choice, and its price is named below.

What differs is everything around the core:

- **The interface**: Tauri + Svelte + Tailwind instead of Nix + Nim/QML (desktop) and
  ClojureScript + React Native (mobile). One Rust code base drives desktop and Android.
- **The boundary**: the key material — PIN envelope, seed phrase, pairing, FFI — lives in
  `src-tauri/src/core/`, and a change there requires review (`.github/CODEOWNERS`) and
  passes a contract test (`core/surface.rs`). Business logic sits outside and could one day
  be written in another language.
- **The engine**: upstream `status-go` plus one small documented patch
  (`src-tauri/status-go/`), described in §2.7.

### 2.2. The boundary is explicit, not a convention

In Status the boundary between client and core is blurred: names of Go structures and
fields leak into client code. In Stauri everything goes through `statusFetch`
(`status/http.ts`) — one place holding the transport, error parsing and logging. The wallet
and ENS are isolated in `status/wallet.ts`, the messenger in `status/messaging.ts`.

The practical point: changing the backend means editing one file and its call sites, not
the whole frontend.

### 2.3. Where signing lives

The backend signs in both cases. In Stauri, however, what reaches the webview is an
**intent** ("send 3 USDT"); the sequence "build → sign → send" and the password never leave
Rust (`transfer.rs`, `ens.rs`, `swap.rs`, the shared mechanism in `router.rs`).

That changes the attack surface: a script that lands in the webview gets not a universal
signing machine but a limited set of operations, each shown to the person on a confirmation
screen.

### 2.4. State

Status: QML models on desktop, reactive atoms on mobile. Stauri: Svelte 5 runes, stores as
the only place of mutable state. Cheaper to maintain and test, but far less proven at scale.

### 2.5. Asynchronous results

`status-go` signals arrive through a C callback and are forwarded to the webview as a Tauri
event. Two independent consumers therefore exist:

- the frontend (`statusStore.processSignal`) — `node.login`, `node.stopped`,
  `messages.new`;
- Rust (`router.rs`) — the router round, which takes the hashes to sign.

The second is deliberate: the router hands out hashes for signing, and the webview must not
be trusted with them.

### 2.6. Network switching

Each network has its own data directory, and switching is done in place: the app closes the
engine's account database and reopens it on the chosen directory. Status does not need this
because it has one directory and switches networks through a profile setting instead.

### 2.7. The engine patch

`status-go` opens the account database once per process and answers every later
initialisation from it. Without a way to close it, a network switch in a running process
would list the previous network's profiles while the keystore had already moved — a profile
shown but not openable. The patch adds one function, `CloseAccounts`: two files, about forty
lines, no cryptography and no keys involved.

It lives in a fork with a single branch, and the same patch file is in the repository, so
the build does not depend on the fork staying up. Without the patch the app still runs; only
network switching asks for a restart. The upstream plan: propose the change to
`status-im/status-go`, after which the patch disappears.

## 3. Stauri's advantages

**A protected local contour.** No listening port at all, external addresses checked on
**every** redirect, secrets scrubbed from logs, and CSP in the shipped HTML
(`script-src 'self'` with a bootstrap hash, no `unsafe-inline`). Covered by tests: 160 Rust,
400 frontend as of 2026-11-22.

**Layer isolation as a property, not an intention.** `status/wallet.ts` and
`status/messaging.ts` are a real boundary; `api.ts` is kept only as a re-export for
compatibility. It is visible in the imports, not in README promises.

**Speed of iteration.** In one session: ENS registration through the router, token swap,
total balance across networks, prices from CoinGecko, the ENS name shown in the profile. On
Nim/QML such a cycle is noticeably longer.

**Decisions documented where they live.** Why `tokenKey` uses a hyphen for prices and a
colon for metadata; why `ens_ownerOf` and `ens_expireAt` hash the name differently; why a
swap takes two rounds. That directly lowers the cost of a move to Logos: the reasons will
not have to be reconstructed.

**A deliberately small trusted core.** `src-tauri/src/core/` holds keys and FFI; everything
else can be rewritten without a security review of the same weight.

**Isolated windows for dApps** — the absence of a permission in `capabilities/default.json`,
not a convention in code.

## 4. Drawbacks

**Feature coverage is not comparable.** No transaction history, NFTs, bridge, Keycard,
push, or a mobile client. Swap works on mainnet only. Buy is a placeholder. There is no
search by ENS name: a name works as a recipient address, not as a way to find a person.

**The boundary is thinner than it looks.** The claim is "when switching to Logos, replace
`wallet.ts`". In reality the wallet semantics live in Rust: `transfer.rs`, `ens.rs`,
`swap.rs`, `router.rs` — around 1,900 lines tied to specific RPC methods, `SendType`, the
`tokenKey` format and the router's behaviour. On a backend change this is rewritten, not
swapped behind a wrapper.

Honest phrasing: the boundary runs where the foreign contract puts it, not where it is
convenient.

**Dependence on the unverified behaviour of a foreign binary.** Three cases in one session:
`forceRefresh` is ignored; `WR-005` means "no swap handler", not "no route"; LiFi builds the
swap transaction only after `approve` is mined. Each discovery is a bug in production and a
fix after real money.

**A library, not a process.** A crash or an unhandled panic inside `status-go` now takes the
whole app down, and the backend cannot be updated independently of the UI. This was an
accepted trade-off: one build pipeline instead of two, and identical Rust code on desktop,
Android and Windows.

**One developer.** This is not about code but about risk: no second reader, no review, no
community that would notice a regression. That is exactly why the third step of the plan is
a conversation with the Status team, not another feature.

## 5. What changes when moving to Logos

We rely on the published intent (a modular runtime, Waku for messages, separate modules for
storage and the blockchain), not on implementation details: those are still moving.

### 5.1. What plays in Stauri's favour

**The explicit boundary is exactly what a runtime change needs.** A module with a
documented contract can be replaced; a monolith with leaked types cannot.

**A small trusted core is portable.** The `core/` boundary is the part a migration would
touch first, and it is already separated and reviewed.

**The habit of writing down reasons.** The expensive part of a migration is recovering why
things are the way they are; here that work is already done.

### 5.2. What works against it

**The UI layer is not reusable.** Logos applications are Qt/QML. The Svelte frontend must
either be kept as it is (Stauri then becomes a client over Logos through a local protocol)
or thrown away. This is the largest risk, and it should be named plainly rather than
postponed.

**Wallet logic in Rust is a debt, not an asset.** It is tied to `status-go`, not to an
abstraction. To make a migration cheap, it should be shaped as "intent → result" through our
own interface rather than raw RPC methods. The first step towards that is a `Backend` with
two implementations.

**There is no ecosystem effect.** Status has authors, reviews and a community. Stauri has
one person so far. In a conversation with the SIM/Logos authors this is the main argument
against, and it is not about code.

## 6. Conclusion

Stauri wins on what can be checked: local access safety, layer isolation, readability and
documented decisions. It loses on what is measured in coverage and people.

For Logos, its strong side is not Svelte or Tauri but the habit of drawing boundaries and
recording reasons. Its weak side is that the wallet half of those boundaries still runs
inside Rust rather than at the junction with the backend.

## 7. References

- `architecture.md` — Stauri's design: layers, data flow, subsystems.
- `networks_and_balances.md` — the path from balance to screen, caches, the forwarder.
- `status_outdated_architecture.md` — why `status-go` is complex.
- `web3im.md` — an explanation without terms, for newcomers.
