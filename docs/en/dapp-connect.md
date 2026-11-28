# Connecting a dApp plugin to Stauri

> Draft, 2026-11-28. Nothing is implemented in Stauri yet; the process follows the Android spike and the first plugin — [stauri-market-dapp](https://github.com/magnus-redkin/stauri-market-dapp).

Complements `dapp-plugin.md`: that document holds the requirements and the threat model, this one the concrete connection process and the runtime contract. The runtime is chosen — **Extism** (on wasmtime). Sections 3–5 of the older document (a hand-written ABI) are superseded by "The contract" below.

## 1. What a dApp consists of

| Part | What it is | Who runs it |
|---|---|---|
| Module | `*.wasm`, a core WebAssembly module built from Rust/Go/Nim/C/… | Stauri in the Extism sandbox |
| UI (optional) | a static bundle: `index.html` + JS/CSS of any framework | Stauri in an isolated webview |
| Manifest | version, hash, permissions, module address, publisher signature | Stauri verifies and shows it |

Only a dApp with a manifest and a WASM module is *connected*. An ordinary application (Rust, Tauri, anything) runs as an external program: a separate window, no Stauri API.

## 2. The connection process

1. **Name.** The user enters a name (`market`, `notes.example.eth`). v1: an HTTPS registry or a GitHub Release address; v2: an ENS text record `stauri.manifest` with the manifest URL and its hash.
2. **Manifest.** Stauri downloads it and verifies the publisher signature (ed25519 over the canonical manifest JSON).
3. **Presentation.** The user sees the name and publisher (key fingerprint), version, permissions, module hash and size. Installing is an explicit action.
4. **Module download.** HTTPS; the module's SHA-256 is compared with the manifest before anything is written to disk — the same `wasm[].hash` Extism itself checks.
5. **Contract check.** Stauri reads the module's exports with `wasmparser` and compares them with `stauri.exports` (`market_list`). Source code is never read.
6. **Install.** Atomically into the data directory: `dapps/<id>/<version>/{module.wasm,ui/,manifest.json}`. Previous versions are kept for rollback.
7. **Run.** The plugin is created when its page is opened: `PluginBuilder` with limits, WASI off, `allowed_hosts` empty. The instance lives while the dApp page is open.
8. **UI.** The bundle is served from the dApp directory in a separate webview (its own origin, no Tauri IPC, no Stauri DOM); it talks to the host only through a `postMessage` bridge with an allowlist.

Updates follow the same path; new permissions need fresh consent, a publisher key change needs a separate confirmation. Uninstall removes the code and, optionally, `store.*` data.

## 3. The module contract

- Format: core WebAssembly (`wasm32`), built with an Extism PDK or by hand.
- Host functions are declared in the `extism:host/user` namespace; Market has exactly one, `http_get_json(url) -> string`.
- Exports: `#[plugin_fn]` functions (Market: `market_list`), byte input and output, usually JSON.
- Rejected at install: exports beyond the manifest, a module over the size limit, a hash mismatch, a module that fails to load in a limited test instance.
- Limits: `memory.max_pages` (Market: 256, 16 MiB), fuel per call (10⁷ in the dev host), a call timeout via `CancelHandle`, one call at a time.

## 4. Host functions

Permissions come from the manifest's `stauri.permissions` and are shown at install.

| Function | Permission | Consent | What is reachable |
|---|---|---|---|
| `http_get_json(url)` | `http:<host>` | no | only addresses on the listed hosts; the reply is text; cache and UA live in Stauri |
| `log(msg)` | — | no | Stauri's log, tagged with the dApp |
| `store.get/set/delete` | `storage` | no | its own KV, with a quota |
| `message.send` | `messages` | always | send as the user |
| `wallet.address` | `wallet` | no | its own subaccount address |

v1 implements and exercises only `http_get_json` (Market); the rest arrives as needed. The plugin has no network of its own: `allowed_hosts` stays empty and every request goes through a host function, where the proxy, User-Agent, cache and limits live.

## 5. The UI bundle

- Built with any framework into static files (`index.html`, JS, CSS); Market uses Svelte 5 + Vite.
- Loaded from the dApp directory, not the network; the CSP forbids external scripts, fonts and the network; images only from explicitly allowed hosts (CoinGecko's coin images).
- Bridge: `postMessage` with `call`, `getState`, `close`; results are JSON. No `invoke()`, `window.__TAURI__` or Stauri DOM access.
- Theme: Stauri passes CSS tokens so the plugin looks native; Market repeats them in `app.css`.

## 6. Developing a plugin

[stauri-market-dapp](https://github.com/magnus-redkin/stauri-market-dapp) is the template:

```
plugin/      Rust + extism-pdk: market_list() -> JSON
ui/          Svelte 5 + Vite: one page
dev-host/    the same host Stauri uses: sandbox, http_get_json, /api/market
manifest.json
scripts/build.sh
```

`cargo run --release -- --once` in `dev-host/` prints exactly what Stauri receives from the plugin; without the flag it serves `http://127.0.0.1:8099` with the UI and `/api/market`. The plugin and its interface are tested before they exist in Stauri, against a host that matches the real one.

Install hash: `scripts/build.sh` builds the module and writes its SHA-256 into `manifest.json`; release v0.1.0 carries that artifact, and the hash in the manifest and in the release match.

## 7. Market as a built-in section

Stauri's Market section stays until the `market` plugin is installed. After that the section renders the plugin's UI bundle and takes data from `market_list`; the built-in `fetch_market_data` and `MarketMain.svelte` can then be removed. This is the first case of a built-in page being replaced by a plugin; other sections follow the same template.

## 8. Security — what is checked and what is guaranteed

- Manifest signature + module SHA-256: MITM and file substitution are closed.
- Sandbox: no WASI, no network, no files; only declared host functions; fuel, memory and time are bounded.
- UI: isolated origin, network-less CSP, allowlisted bridge.
- Money and messages: outside the plugin's reach; later through host functions with consent.
- Audit log: installs, updates, host-function calls, limit stops.

Not guaranteed: that the dApp is useful, that its UI is honest within its pane, that the publisher is well-intentioned; nor that Stauri, the webview or wasmtime are free of bugs.

## 9. Android

The spike confirmed it: Extism 1.41 runs on `aarch64-linux-android` — the host was built with the NDK, and the plugin ran on the device both from the shell and in the app domain (`run-as`). Requirements: rustc ≥ 1.96 for extism 1.41 (Stauri is on 1.94 — bump the toolchain on integration), the NDK linker and `CC_aarch64_linux_android`. Costs: size (the unstripped host with wasmtime is ≈ 26 MB; a stripped application build is smaller), and Android is Tier 3 for wasmtime — keep a device smoke test in CI.

## 10. Open questions

1. Manifest signature format and JSON canonicalisation (one Rust implementation for the host and for `scripts/`).
2. The name registry: HTTPS in v1, ENS in v2; who holds publisher keys and how they are revoked.
3. The UI bridge API: a fixed minimum (`call`, `getState`) or derived from `stauri.exports`.
4. `http:*` permissions: per-dApp host lists; whether to show concrete addresses to the user.
5. Lifecycle: one window/page per dApp; background calls are deferred.
6. A module signature separate from the manifest (Extism checks `hash`; a signature is ours).
