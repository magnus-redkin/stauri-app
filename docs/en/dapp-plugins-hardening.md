# Hardening the dApp plugin mechanism

> Plan, 2026-11-28. Source documents: `dapp-connect.md` (process and contract), `dapp-plugin.md` (requirements and threat model). Example: [stauri-market-dapp](https://github.com/magnus-redkin/stauri-market-dapp).

## 1. Where we are

Working and verified for real: installation from a third-party repository by manifest URL, SHA-256 of the module and the UI archive, the Extism sandbox (WASI off, `allowed_hosts` empty), one host function `http_get_json` with a permission allowlist, the UI bundle on a loopback server with a session token and a network-less CSP, and the `POST api/call` bridge. Market opens and shows data.

### Negative runs (all pass)

| Scenario | Expectation | Result |
|---|---|---|
| Module hash does not match the manifest | refused, nothing installed | ✓ `hash mismatch`, no directory |
| Hash missing | refused | ✓ `hash is missing` |
| Manifest answers 404 | refused | ✓ `HTTP 404` |
| Matching hash but not a wasm module | refused | ✓ `does not load in the sandbox` |
| Module imports an unknown function | refused at instantiation | ✓ does not load |
| Module imports WASI | refused at instantiation | ✓ does not load |
| Plugin calls `http_get_json` without the permission | host refuses | ✓ `host not allowed` |
| UI archive with `..` or an absolute path | extraction refused | ✓ path check |
| `id`/version with `..` or `/` | refused | ✓ alphabet check |

### What is still missing

- Manifest signature (ed25519) and a publisher in the UI.
- Export validation at install time.
- A wall-clock call timeout (fuel and memory caps exist).
- Updates and rollback in the UI, deleting old versions.
- A CSP derived from the dApp's permissions (images are hardcoded to CoinGecko now).
- Android dApp windows, a name registry and ENS.

## 2. The security model, in detail

### 2.1 Trust boundaries

```
user ── confirms the install ──► Stauri ── downloads ──► HTTPS source
                                     │                    (not trusted)
                                     ├─ verifies the manifest and files
                                     ├─ runs the module in a sandbox ──► plugin (not trusted)
                                     └─ serves the UI on its own origin ──► bundle (not trusted)
```

Stauri trusts only itself: keys, PIN, profile. Everything from the network (manifest, module, UI) is hostile until checked. The plugin cannot harm Stauri; the UI is not trusted by the plugin and receives only what the host hands over.

### 2.2 The install pipeline

1. **Manifest address.** `https` only; reply ≤ 1 MiB; redirects handled by `reqwest` (bounded); loopback addresses bypass the system proxy.
2. **Manifest.** JSON with required `name`, `version`, `wasm[].url`, `wasm[].hash`, `stauri.id`, `stauri.exports`. Unknown fields are ignored, missing ones are a refusal.
3. **Identifiers.** `id` and version: `[a-zA-Z0-9._-]` only, ≤ 64 characters, no `.`, `..`, `/`. Otherwise refused — these become directory names.
4. **Module.** Downloaded over `https`, ≤ 32 MiB, SHA-256 compared with the manifest; an empty hash is a refusal (otherwise the check would be optional).
5. **UI.** A `tar.gz` ≤ 64 MiB, SHA-256 compared; extraction refuses absolute paths, `..` and drive prefixes; at most 5000 entries.
6. **Instantiation.** The staged module is loaded into the same sandbox it will run in. A module that does not load is not installed.
7. **Atomicity.** Everything is written to `.staging`, then renamed; `current` is updated last. A failed install leaves no half-built dApp; previous versions are kept.

### 2.3 The runtime sandbox

- **Engine:** Extism on wasmtime. The module is core WASM without WASI: no files, clock, randomness or processes.
- **Network:** unreachable in the runtime (`allowed_hosts` empty) and outside it — the plugin has no sockets. Only host functions reach out.
- **Memory:** one linear memory, capped by the manifest (`max_pages`, 256 = 16 MiB by default). Verified: at 16 pages the real plugin traps with `oom`, so the cap applies.
- **Computation:** fuel per call (10⁷); exhaustion is a call error, not a hung process.
- **State:** one instance per dApp, created on first call, rebuilt after an error. A wall-clock timeout with `CancelHandle` is planned.
- **Imports:** a module may import only declared host functions; an unknown or WASI import keeps it from loading (verified).

### 2.4 Host functions

The only one in v1 is `http_get_json(url) -> string`:

- `https` only; the URL host must equal a `http:<host>` permission or be its subdomain (`*.host`);
- GET with a 60-second response cache; the reply size limit (`max_http_response_bytes`) is not applied yet and is on the plan;
- User-Agent `Stauri/<version>`, the system proxy, like the rest of the application;
- failures are JSON with the reason: the plugin sees it, the user sees it in the log.

The rule: everything the plugin can observe from outside is declared in `stauri.permissions` and shown at install.

### 2.5 UI isolation

- The UI is served by a loopback server on a random port; the path carries a 32-byte session token, and without it every request gets 403.
- The page lives on its own origin; CSP: `default-src 'self'`, `script-src 'self'`, `connect-src 'self'`, images `'self'` plus an explicit allowlist.
- The bridge is `POST /s/<token>/api/call` with `{function, input}`; the reply is a string from the module. No `invoke()`, no `window.__TAURI__`, no Stauri DOM: the dApp window holds no Tauri permissions.
- Later: bridge methods grow only together with host functions and only by permission.

### 2.6 Secrets and money

Keys, seed, PIN, the main address and balance are unreachable from the plugin and its UI. Future `wallet.*` and `message.send` are performed by Stauri after explicit consent; the plugin gets a result, not authority. A dApp subaccount is a separate derived key, the key stays in Stauri.

### 2.7 Data and lifecycle

`dapps/<id>/<version>/` plus a `current` pointer; previous versions stay for rollback; removal deletes the directory. Future plugin storage (`store.*`) is a separate directory with a quota, cleared on removal at the user's choice.

### 2.8 Observability

Installs and call errors are logged today. Planned: a log of installs/removals, host-function calls (function, dApp, outcome; never message text) and limit stops, with a screen in settings.

### 2.9 Residual risks

- The manifest arrives over HTTPS with the hash inside it: a compromised host substitutes both the file and the hash. A publisher signature closes this.
- Any local process may try to guess the session token; 32 bytes make that infeasible, but the server still listens on loopback.
- Bugs in wasmtime, the webview or Stauri itself.
- Social engineering within the plugin's UI pane.

## 3. The roadmap

Ordered by security value.

### P0. Close the install and run loop (2–3 weeks)

1. **ed25519 manifest signature.** Canonical JSON (JCS or a deterministic key order), a `signature` field, a separate publisher key, verified before install; fingerprint shown; TOFU on key change; refusal without trust.
2. **Export validation.** `wasmparser` before instantiation: names and signatures match `stauri.exports`; extra exports allowed, missing ones refused.
3. **Wall-clock timeout.** `CancelHandle` plus a limit (e.g. 500 ms) per call; the UI gets `timeout`, the instance is rebuilt.
4. **Host reply limit.** Apply `max_http_response_bytes`.
5. **Updates and rollback.** An "Update" button, a version list with rollback; no silent downgrade; a permission diff on update.
6. **Removal and cleanup.** "Remove" deletes every version; a "delete old versions" button.

**Acceptance:** an unsigned manifest is refused; a changed hash in a signed manifest breaks the signature; tests for all of the above; the install log is visible.

### P1. Identity and registry (2–3 weeks)

- A name registry (a file in the repository plus GitHub Releases) and an ENS text record `stauri.manifest` as the source of the manifest address.
- Install screen: publisher, fingerprint, permissions, hash, a "Trust" action.
- Key revocation and revocation lists.

### P2. Capabilities for dApps (3–4 weeks)

- `store.*` with a quota, `message.send` with consent, `wallet.address`/`wallet.transfer` with a subaccount and limits.
- A call log and a permissions screen; revoking rights without removing the dApp.
- `message.received`, `payment.received` events.

### P3. Platforms and packaging (2 weeks)

- Android: a dApp page inside the app (instead of a window) or a window if the platform allows; a device smoke test.
- Size: measure a release with extism, trim wasmtime features; target ≤ +15 MiB.
- CI: build an example plugin and install it into a test directory.

### P4. Examples in other languages (3–4 weeks, after P0–P1)

- **Notes in Nim.** Nim → wasm32 plus a thin C shim over `extism:host/user`; exports `note_list/note_add/note_delete`; permissions `storage`, `messages`; a declarative or bundled UI. Proves language neutrality and the simplicity of connecting.
- **ENS registration in Go.** `go-pdk`, calls through new host functions (`wallet`/`tx` only after P2), verifying `.stateofus.eth` and `.eth`; buying `.eth` is postponed by the registrar's state.
- Repository templates and a "your dApp in an evening" documentation section.

## 4. Extending the security tests

Beyond the current 12:

- signature: wrong, foreign, missing, manifest changed after signing;
- downgrade: installing an older version with protection on;
- huge files and a tar.gz bomb (entry-count and unpacked-size limits);
- a call with `http://` and with a sibling host (`evil.example.com` against an `example.com` permission);
- a plugin that spins forever (fuel and timeout);
- a UI trying to `fetch` another origin (CSP);
- a UI trying to run an inline script (CSP);
- concurrent calls to one dApp and instance rebuild after an error.

## 5. Estimate

P0 — 2–3 weeks, P1 — 2–3, P2 — 3–4, P3 — 2, P4 — 3–4. A "safe install mechanism" (P0+P1) is about a month of one developer; dApps with money and messages, two more; the Nim and Go examples after that.

## 6. Open questions

1. JSON canonicalisation for the signature: full JCS or a custom deterministic order.
2. Where the registry lives: a file in `stauri-app` or a separate repository with a CI signature.
3. The wall-clock timeout: 200, 500 ms or configurable — and what the UI shows when it is exceeded.
4. Key revocation: a list in the registry or an ENS event.
5. Android: a separate window or an embedded dApp page.
