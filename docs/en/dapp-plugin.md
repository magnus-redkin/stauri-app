# Stauri dApp plugins: sandbox and binary contract

> Draft for discussion, 2026-11-27. Nothing is implemented; everything below is a proposal except section 0.
>
> The runtime is chosen — **Extism**; the module contract and the connection process are in `dapp-connect.md`. Sections 3–5 below are the original requirements, superseded by `dapp-connect.md`.

## 0. Decisions already made

1. A connected dApp runs **only in a sandbox**. Native processes with access to the Stauri API are not supported: no security can be promised for an arbitrary binary running with the user's rights.
2. The host Svelte framework is **not reused**. A plugin either describes its interface declaratively or ships its own static UI bundle, which Stauri only displays in isolation.
3. The dApp language and framework are free. Stauri checks **only the module contract** (the structure of the WASM binary); it never reads or reviews source code.
4. An ordinary native application, Tauri included, can be launched as an external app: a separate window, no Stauri API. That is not a "connected dApp", just a program.
5. Everything a dApp does with messages and money goes through Stauri's capability broker with user consent. Keys, seed and PIN are never available to the plugin.

Consequence of 1 and 4: a "connected dApp" is a WASM module plus an optional web UI. A native program cannot be connected, however much it wants to: it has no sandbox, and therefore no guarantees.

## 1. What a dApp consists of

A package (what gets downloaded and installed):

```
manifest.json      description, permissions, hashes, publisher signature
module.wasm        logic; the contract is described in §3
ui/                optional: static HTML/JS/CSS
```

The manifest holds: id, name, version, publisher key, module URL and SHA-256, the permission list, the ABI version, the minimum Stauri version, and, when present, the UI files and their hashes. The name is a label; the real identity is the publisher key.

**Why not "a native binary in an OS sandbox".** One could run an ordinary executable under bwrap/AppContainer/seatbelt, but the guarantees differ across the three platforms, and the network and filesystem still have to be closed separately and incompletely; for a Tauri app with its own webview and network access this is almost impossible. WASM gives one identical and checkable boundary on every platform, which is why v1 is WASM; a native sandbox remains a possible future mode, but with an honestly different level of guarantees.

## 2. Install and registry

Flow: the user enters a name → Stauri fetches the manifest → shows publisher, version, permissions and hash → downloads and verifies → validates the module contract → installs → the dApp appears in the list.

- **Name source, v1:** an HTTPS registry (or GitHub Releases) keyed by name. **v2:** an ENS text record `stauri.manifest` — `notes.stauri.eth` points to the manifest URL and its hash. ENS fits because Stauri already works with it and the Logos community uses it, but it is not a security boundary: trust rests on the publisher signature.
- **Signature:** ed25519, as a separate file or a manifest field. Stauri shows the key fingerprint; a key change for the same name triggers a separate explicit warning and confirmation (TOFU).
- **Integrity:** SHA-256 of the module and UI files taken from the signed manifest; HTTPS only; atomic install; versions stored separately (`dapps/<id>/<version>/`) with rollback.
- **Updates:** manual by default. Automatic updates are allowed only while the permission set is unchanged; any new permission requires fresh consent. A downgrade is an explicit user action.
- **Uninstall:** removes the code and, at the user's choice, the dApp data (`store.*`).

## 3. The binary contract

This is the only thing Stauri checks about a dApp.

**Format:** core WebAssembly, `wasm32`. One linear memory with a declared maximum (64 MiB proposed). Forbidden: shared memory, threads, any WASI imports, any import other than one host call.

**Imports:** exactly one — `stauri.host_call(ptr: i32, len: i32) -> i64` (packed `ptr << 32 | len` for the host's reply).

**Exports:**

| Function | Signature | Purpose |
|---|---|---|
| `stauri_abi_version` | `() -> i32` | ABI version, currently 1 |
| `stauri_alloc` | `(i32) -> i32` | allocate a buffer for host data |
| `stauri_free` | `(i32, i32) -> ()` | free a buffer |
| `stauri_call` | `(i32, i32) -> i64` | handle a request, return the reply |
| `stauri_event` | `(i32, i32) -> i32` | accept an event from the host |

Payloads are UTF-8 JSON. Request: `{"id","method","params"}`. Reply: `{"id","result"}` or `{"id","error":{"code","message"}}`. Event: `{"event","data"}`. Everything is copied through the module's memory; host pointers are never handed to the plugin.

**What Stauri's validator checks:** the wasm magic and version; exactly one allowed import with the exact signature; the required exports with exact signatures (extra exports are allowed — they grant no access); one memory without `shared` and within the limit; no forbidden sections; file size; SHA-256 matching the manifest. Nothing else: no style, dependencies or source.

**Limits:** fuel/instructions per call, a 100 ms wall clock per call, 64 MiB of memory, a 1 MiB reply, one call at a time, a bounded event queue. A violation rejects the call; repeated violations stop the dApp.

**Versions:** the ABI is versioned; a module with an unknown ABI is rejected by the installer with a clear error. `hello` returns host and module versions and the granted permissions.

## 4. Host API (capabilities)

| Method | Manifest permission | Consent | What the dApp sees |
|---|---|---|---|
| `hello` | — | no | versions, id, permission list |
| `log` | — | no | Stauri log tagged with the dApp, rate-limited |
| `store.get/set/delete` | `storage` | no | its own KV store, 1 MiB quota |
| `time.now` | — | no | current time, ms |
| `wallet.address` | `wallet` | no | its own subaccount address |
| `wallet.balance` | `wallet` | no | balance of its **own** subaccount only |
| `wallet.transfer` | `wallet.spend` | always | transfer; per-transaction and daily limits, optional allowlist |
| `message.send` | `messages` | always | send a message as the user |
| `events` (host → guest) | `messages` / `wallet` | at install | `message.received`, `payment.received`, `network.changed`, `lifecycle.suspend/resume` |

Not in the v1 API, and not going to be: the contact list, other chats, the main balance or address, arbitrary signing, network RPC, the filesystem, the network, time beyond `time.now`, randomness beyond the host's.

Calling a method without its permission is an error. The audit log records method, dApp and outcome; message text is never logged.

## 5. Wallet and messages

**Wallet.** The proposal is a separate derived subaccount per dApp (a deterministic path from the profile seed; Stauri keeps the key). The plugin gets the address and balance of its own subaccount, never the key. Receiving funds is just the address and a `payment.received` event. A transfer always shows the user the amount, recipient and dApp name; consent is mandatory; limits and an allowlist cap the damage from a bug or a compromise. The main account is unreachable.

**Messages.** Sending happens as the user, with consent and the exact text and recipient shown; the plugin cannot substitute what the user sees. Receiving in v1 is limited to the dApp's own thread (open question §11): the plugin does not read the user's conversations and gets no contact list.

## 6. Interface

The host Svelte framework is not used — a deliberate decision. There are two safe modes:

1. **Declarative UI.** The manifest carries a screen schema (text, list, form, buttons, QR, status); Stauri renders it with its own components and theme tokens. No plugin code runs in the interface at all; it looks native; enough for Notes.
2. **Its own static bundle.** `ui/` is plain HTML/JS/CSS built with any framework (Svelte, React, Vue, anything). Stauri shows it in a separate webview/iframe: its own origin, `sandbox="allow-scripts"` without `allow-same-origin`, a CSP that forbids network, fonts and remote scripts; the bridge is `postMessage` only, with an allowlist of methods; there is no Tauri API and no access to Stauri's DOM. Data flows only through the same host API.

The UI never gets more rights than the WASM module: the bridge calls the same methods with the same permissions and consents. A shared CSS token set can be provided so the interface matches the theme.

## 7. Security

| Threat | Mitigation |
|---|---|
| MITM during download | HTTPS + SHA-256 from the signed manifest + ed25519 signature |
| Publisher impersonation | identity is the key; key changes need explicit confirmation, the fingerprint is visible |
| Malicious module | WASM sandbox without WASI or network, host API only, fuel/memory/time limits |
| Confused deputy | manifest permissions, consent for money and messages, limits, allowlist, audit log |
| UI phishing | isolated origin, the dApp cannot draw outside its pane, dApp badge, network disabled |
| Call replay/spoofing | request ids, one call at a time, no long-lived tokens |
| DoS | per-call, rate and reply-size limits; stopped on violations |
| Data exfiltration | no filesystem or network; UI without network; declared methods only |
| Update attack | signature and hash, no downgrade without consent, new permissions need fresh consent |
| Name impersonation | the name is a label; publisher and fingerprint are always shown next to it |

**Honest limitations.** The sandbox protects against the dApp's code, not against bugs in Stauri, the webview or Wasmtime; timing channels are not fully closed; WASM memory is not guaranteed to be zeroed; the UI can still attempt social engineering within its pane. All of this belongs in the threat model rather than being glossed over.

## 8. What is guaranteed

- The dApp never gets keys, seed or PIN and cannot sign anything without Stauri.
- The dApp cannot read files, other chats, contacts or the main account.
- No transfer or message leaves without user consent.
- dApp code never runs in Stauri's context and has no network.
- Install and update are bound to the publisher signature and hash.

What is not guaranteed: that the dApp is useful, that its UI does not try to deceive, that the publisher will not lose the key. That is the job of reputation, the registry and warnings.

## 9. Example: Notes

A minimal vertical slice that exercises everything at once.

- Package: `manifest.json`, `notes.wasm`, declarative UI.
- Permissions: `storage`, `messages` (send only), `wallet` (address and receive).
- Methods: `note.list`, `note.add`, `note.delete` in its own KV; `note.share` → `message.send` with consent; `tip.address` → the subaccount address for tips.
- What it demonstrates: the connect page, the contract check, the sandbox, the storage quota, message consent and an address for receiving.
- Order: Rust first (fastest to debug the contract), then Nim — the same ABI, a thin C shim, proof of language neutrality. Rust can be skipped, but the first iteration is cheaper on it: one new layer to debug instead of two.
- The ENS registrar example is postponed: buying `.eth` is currently blocked by the registrar's state, while Notes exercises the same capabilities.

## 10. Phases and estimate

One experienced developer, full-time, excluding polish:

| Phase | Weeks |
|---|---|
| ABI, manifest and threat-model specification | 1–2 |
| WASM runtime, contract validator, limits | 3–4 |
| Install, registry, signatures, versions, updates | 3–4 |
| Host API, subaccount, messages, consents, audit | 4–6 |
| Declarative UI (for Notes) | 2–3 |
| Isolated UI bundle (second mode) | 2–3 |
| Rust SDK + Notes | 1–2 |
| Nim SDK + Notes | 2–3 |
| Templates, documentation, demo | 1–2 |
| Hardening: validator fuzzing, limits, review | 3–4 |

MVP (Rust Notes, declarative UI, signed HTTPS install): **10–14 weeks**. The full version with Nim, the UI bundle and hardening: **5–7 months**. The most expensive risk is not the protocol but the trust registry and the quality of the validator.

## 11. Open questions

1. **dApp subaccount:** should it be a status-go account or a key inside Stauri? How does it recover from the seed, and how is it shown in the wallet?
2. **The messages "own thread":** a separate chat per dApp, a tag on messages, or a separate key? What exactly reaches the plugin, and how is that explained to the user?
3. **Declarative UI:** is a fixed block set enough; do we need the bundle-only mode in v1?
4. **WASM component model (WIT)** instead of the JSON ABI: better types and tooling, weaker Nim/Go support; keep JSON in v1, WIT as a v2 candidate.
5. **Registry:** ENS or HTTPS in v1; who holds publisher keys and how are compromised ones revoked.
6. **Money limits:** fixed or configurable; how the daily remainder is shown to the user.
7. **Storage:** quota, backup during profile transfer, and what happens when a dApp is removed.
8. **Background work:** in v1 a dApp lives only while its screen is open — confirm that this is enough.
9. **Contract checking:** the validator's test set and fuzzing; should it be part of the safety core with its own review?
