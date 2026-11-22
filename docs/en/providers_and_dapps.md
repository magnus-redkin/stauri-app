# Providers and dApps

This document records the decisions on how Stauri plugs in third-party data
sources and third-party applications. Some of it is implemented, some stays
as a requirement for future code — the state is listed in §0.

Complements `architecture.md` (overall structure and layer boundaries).

## 0. State as of 2026-11-08

| Decision | Where it lives | State |
|---|---|---|
| "Channel source" category (feed by URL) | `src-tauri/src/providers.rs`, `stores/feedsStore.svelte.ts`, `sections/dapps/` | **Works**: RSS/Atom, Telegram via RSSHub, subscriptions survive restarts |
| SSRF protection | `providers.rs::validate_external_url` | **Works**, 9 tests |
| Origin marker on list rows | `sections/chat/ChatLeft.svelte` | **Works**: always shown, cannot be turned off |
| dApp in a separate window | `src-tauri/src/dapp.rs`, `stores/dappsStore.svelte.ts` | **Works**: own window, no IPC, title carries the host |
| "Store" category (fiat on-ramp) | — | **No.** The Buy tab is disabled |
| Scoped, hash-pinned permissions | — | **No.** Providers are added by an explicit action; permissions as an object do not exist yet |
| UI slots filled by a provider | — | **No.** The provider set and their places are fixed in code |
| Three operation classes | — | **No** at the external-provider level; our own Swap goes its own way (`swap.rs`) |

Section §14 describes the order in which this was done and what is left.

## 1. Terminology

Words matter: two different mechanisms must not share one name, otherwise the
line between "data" and "executable code" blurs before there is a second case
to blur it with.

| Term | Meaning |
|---|---|
| **Provider** | A third-party source that serves data or an address. No code comes into Stauri. |
| **Built-in provider** | Runs on our code: the swap router in status-go, the default MoonPay. We reviewed it. |
| **External provider** | Added by the user by URL. Opens in an isolated window. |
| **Category** | The kind of provider: channel source, store, etc. Determines the slot in the UI and the set of rights. |
| **Catalog** | The list of providers of one category the user picks from. |
| **dApp** | A full external application with its own interface. Opens in an isolated window, has no access to our data. |
| **Slot** | A named place in the Stauri UI that a provider may fill. |

**Provider ≠ dApp.** A provider serves data over a fixed schema; a dApp
brings its own interface. Different trust model, different isolation,
different requirements. "dApp" for a Telegram channel is the wrong word, and
behind the wrong word comes "the dApp can draw a button of its own" later.

## 2. Three levels of extensibility

| What the user adds | Does our code change | Does it need a release |
|---|---|---|
| A provider into a known category (`t.me/news` as a channel source; a ruble store) | no | **no** |
| A new category (say, "exchange rate source") | yes: slot, validation, rights, rendering | yes |
| A dApp (own window, own interface) | no | **no** |

The value of the mechanism is exactly in the first row. If adding a channel
required a release, the mechanism would be useless: the user cannot edit our
code.

A new category adds a little: the registry, storage, permission revocation
and the origin display are shared. What changes is the slot, the validation
and the rendering component.

**The entry point is per category.** In the channel list — "external channel
source", in the store list — "external store". A common "Add provider" button
is not needed: in different places the user has different intent, and a common
button forces asking the category first — reproducing the menu we just
removed. Besides, validation and permissions depend on the category.

The shared part is the mechanism, not the button.

## 3. Category as a string

The category is stored as a string, not an enum in code. That is the path to
extension without changing types.

**Caveat.** A string loses the exhaustiveness check of an enum: a typo
`chanel-source` creates an invisible category, and the provider silently stops
appearing. So the string lives in the data model, but **validation happens at
the boundary**: the app keeps a table of known categories and rejects
unknown ones, or marks them as broken with an explicit message. Silent
failures cannot be debugged.

The fields inside a category will also change. Records created before a new
field appeared must keep reading — so a record needs a schema version.

## 4. Security model

### 4.1. Stating the guarantee

The promise "a dApp sees only the channel list" is unenforceable. We can
guarantee what data we **passed**, but not what the dApp **observed**: it
sees network requests, timings, message sizes.

The honest formulation:

> A dApp **has no access** to keys, contacts, balances and IPC. Everything
> passed to it is listed in the dialog.

The first is checkable, the second is not. An uncheckable guarantee
undermines trust in everything else.

### 4.2. Two warning blocks, not one

Responsibility for the content and for the counterparty — not ours.
Responsibility for "the user confirmed one thing, but something else got
signed" — ours.

| What we show | Whose claim | How it looks |
|---|---|---|
| "You are sending 5000 ₽ to exchange X's address. What you get is the exchange's promise, and we cannot verify it" | the counterparty's | a quote from the dApp, marked as unverified |
| "Stauri passes: address 0xabc…, amount 5000 ₽, nothing else" | ours | a claim in our name, checkable |

Merging them into one "Beware!" loses the only guarantee we can give.

### 4.3. Isolation levels

| Level | What it gives | Protects from leaks |
|---|---|---|
| Shadow DOM | markup and style isolation | **no**: same JS context, same `window`, same `fetch` |
| Separate origin (`<iframe sandbox>` without `allow-same-origin`) | foreign code cannot see our `localStorage`, cookies, objects | partially: the network is visible |
| Separate webview/process | a real boundary | yes, including timings |

**Embedding is not a matter of taste.** The deeper a dApp is plugged in,
the stronger the isolation must be. Embedded content is maximum trust, not a
convenient styling option.

### 4.4. Embedding takes data, not code

A slot is filled with a **structure** our Svelte component renders:

```
{ source: "telegram", title: "…", author: "…", excerpt: "…", url: "…" }
```

No foreign JS in the process, no Shadow DOM needed. It is only needed where a
provider brings its own interface — and then it is a separate window or
iframe, not a row in a list.

The rule that follows: **a dApp with its own form always opens in a window,
not as a row in the UI.**

### 4.5. The signature is always ours

A provider **asks** to sign; it does not sign. The confirmation form is
ours: recipient, amount, token, network, fee in our units. The provider sees
only the result: a hash or a refusal.

This is a one-way decision: if "the provider may sign" ever appears in the
contract, removing it later is impossible without breaking compatibility.

A side consequence: the provider does not draw the amount, so it cannot
substitute it in the confirmation.

## 5. Keys

A provider never receives keys. So signing happens inside Stauri: the
request comes in as an object, Rust parses and signs it, and a hash goes out.

The same device as `auth_proxy`: the secret lives in Rust, the webview does
not know it, and only the result goes out.

## 6. Three operation classes

The key finding of the discussion: "buy" and "swap" are fundamentally different,
and that cannot be hidden behind one dialog.

| Operation | What we hand over | Signature |
|---|---|---|
| Reveal an address (buy, fiat on-ramp) | address + network | **none** |
| Send to an address (deposit to an exchanger) | transfer details | our form |
| Call a contract (on-chain swap) | call parameters | our form |

**Buying crypto with fiat requires no signature.** The user pays by card
outside our system, the seller sends the crypto to the named address
themselves. Our role is to reveal the address. This makes the class fully
safe with respect to signing and lets us implement it first.

A list of exchangers for the third class requires the provider to return
contract call parameters — i.e. a transaction constructor — a new access
level that does not reduce to "show a button". In the first version external
providers do not get this class.

## 7. Permissions

- **Scoped, not "forever".** What is allowed (which channels, which fields),
  until when. Default — until the app closes.
- **Pinned to code, not to a name.** Names get squatted, domains change
  hands. A permission is pinned to a content hash; its change is a fresh
  question. First connection remembers the key and warns on change, like SSH.
- **Revocable.** Revoking removes the elements immediately.

## 8. UI slots

A slot is a named place a provider may fill: `chat.list.item`,
`wallet.providers.buy`, etc.

**UI extensibility is attack-surface extensibility.** Every slot is a place
where foreign touches our trust. So there must be few slots, and each must be
justified.

A slot declares its **class**: "read" or "money". A "money" element must not
look like a "read" element, and the transition between classes must be
visible **before** the click, not after. Otherwise the user learns "clicking
a row is safe" and then the row leads to a purchase.

## 9. Category "channel source"

### 9.1. Invariant: the merge is local

The channel list is assembled in our process: the provider serves its items,
Rust normalizes, Svelte draws them together with native Status.

**The provider learns nothing about the user's chats.** It gets one request
"give me the channel list", not "which channels does the user already have".
The moment the merge moves to the provider's server ("to sort better"),
the whole chat list leaks. This is an invariant, not an optimization.

### 9.2. Item origin

A row from an external channel must not be indistinguishable from a Status
chat. If the provider can substitute an item with the same name as an
existing chat, it can impersonate it.

An item has an immutable source identifier, and our markup shows it
**always** — not a badge that can be switched off, but part of the row.
The user must know where the item comes from, without going into settings.

### 9.3. We set the order

If the provider influenced sorting, it would always be first. Order is
determined by Stauri: a separate group or a fixed place.

### 9.4. Homogeneity

Channels are homogeneous (title, author, excerpt, link), so they do not need
a separate protocol: the built-in type "feed by URL" is enough. A
Telegram channel becomes an instance of it — **there is no Telegram in the
code at all**.

Stores are not homogeneous: their own form, currency, flow. One universal
provider will not cover them — that needs a contract with actions.

**One item format — yes. One whole mechanism — no.**

### 9.5. The risks, specifically

**SSRF.** The URL is entered by the user, the request is made by Rust. On
`127.0.0.1` sit `rpc_proxy` (port 43057) and the auth proxy. A feed with an
address like `http://127.0.0.1:43057/1` makes our Rust talk to its own
infrastructure.

Mandatory: only `http(s)`, block `127.0.0.0/8`, `10.0.0.0/8`,
`172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `::1`.

**Rendering.** Feed content is untrusted HTML. No `{@html}`: text only,
links as separate buttons with the full URL. Limit the response size and the
number of items.

**Privacy.** The fact of the request reveals the subscription to whoever
serves the feed: for `t.me` that is Telegram, for a bridge — the bridge
owner. That is the only "where it goes" in this case, and it must be written
in the connection dialog.

### 9.6. Telegram and RSS

Telegram **does not serve** public channels over RSS. `t.me/s/<channel>` is
HTML, an unofficial interface that changes from time to time. Bridges
(`rsshub.app` and the like) make RSS out of these pages, but then a third
party sees the user's subscriptions.

Three options, different in meaning:

1. Rust parses `t.me/s/<channel>` — no middleman, but fragile.
2. An RSS bridge — simple, but the subscription leaks out.
3. Our own connector with a local proxy — expensive.

## 10. Category "store" (fiat on-ramp)

**No signature.** The user pays by card outside the system, the seller sends
the crypto themselves.

What we do:

- show the address in full, character by character and in groups, so it can
  be checked;
- show the network;
- say that we pass only the address: no balance, no other addresses, no fact
  of account existence;
- **we ourselves** watch for the incoming on this address after the deal.
  That is our function and our advantage over the official client;
- when needed, issue a one-time address from the same seed — then the
  provider cannot link the purchases together.

The main risk here is not technical but address phishing: the user may copy
the address from the seller's email instead of our dialog. So the value of
the screen is that it is the **only** source of the address.

### 10.1. The provider window

The scenario is as in SIM: `moonpay.com/v2/xxx` opens in a separate window.
There is no foreign code in our process here — that is browser navigation,
and the main thing is not to break it.

The rules:

| Rule | Why |
|---|---|
| Only `https`, the host is shown in full | `javascript:`, `data:`, `file://`, lookalike domains |
| A separate webview without IPC, without `window.__TAURI__` | a "foreign window" must be foreign technically |
| Its own ephemeral session | cookies do not survive closing |
| **Our** chrome around the content | the page can draw its own "address field" and logo |
| The default provider is an ordinary entry in the same list | "built in" must not bypass the dialog |

The built-in MoonPay is not "trusted" but **verified**. That is a difference
to keep in the interface: it gets the same address dialog and counterparty
warning.

## 11. Swap

The built-in status-go router builds the route itself (several processors)
and signs locally. It does not show the user a list of exchangers — it is a
router, not a showcase.

A list of exchangers is a **choice** by the user, not an optimal route.
Different functionality; useful where the built-in is weak (no route, bad
rate, a fiat pair needed), and it must not break the simple scenario.

In the first version no external providers are added to swap. Our own Swap
(`src-tauri/src/swap.rs`, the `WalletSwapTab`) is built differently and is not
covered by this section: it does not ask the user about a provider, it hands
the route to the processor status-go chose. Slippage is hardcoded at 1%, not
made configurable. It works on mainnet only: providers have no liquidity on
testnets.

## 12. dApp

A separate class. Own window, own interface, no access to our data.

Implemented in `src-tauri/src/dapp.rs`: a window with `WebviewUrl::External`,
the capabilities entry only for the main window, so `invoke` from a foreign
page does not work — that is an absence of a permission, not a convention.
The window title carries the host.

- A toy, a contract analyzer, Solidity/Foundry — open in an isolated
  window.
- No signature needed or involved: there is nothing to sign, because there is
  no access.
- Responsibility for the content is not ours, but the visible frame with the
  source is mandatory and cannot be turned off. Everything we draw ourselves
  (seed forms, transaction confirmations) never appears inside a foreign
  frame.
- The address passes the same filter as feeds (`validate_external_url`):
  only `http(s)`, no loopback and no private ranges. Here it is not about
  SSRF (the request is made by the foreign window) — it stops a dApp string
  from opening our own interface or a local service inside a foreign frame.
- **A console dApp** (executing arbitrary JS) — a separate level, requiring a
  separate conversation about what is available, visible and on the network.
  Not in the first stage.

## 13. Provider lifecycle

A provider is a state, not a once-configured thing: enabled, disabled,
unavailable. Elements disappear immediately on disable.

What is done for feeds:

- one broken source does not break the list: 15 s timeout, 512 KB body
  limit, at most 50 items per source;
- a refresh error is visible on the list row ("Update failed: …"), not lost
  in the log;
- subscriptions are stored in `localStorage` under a schema version; records
  of an older version are re-fetched from the server, because a parser fix
  cannot repair them;
- the log shows which source gave what — otherwise the incident cannot be
  unpacked;
- a provider code update = fresh consent (see §7) — **not yet**: permissions
  as an object do not exist.

## 14. Implementation order

1. **Chat / channels / communities** — native, no providers. **Done.**
2. **Send / Receive** — including watching for incoming. **Send and Receive
   exist**; watching a specific incoming payment does not (there is a general
   balance poll).
3. **Category "channel source"** — the built-in type "feed by URL".
   **Done**, verified on live RSS and a Telegram channel via RSSHub.
4. **Category "store"** — address reveal, external window, watching the
   incoming. **Not started.**
5. **dApp window** — isolated webview, frame with the source. **Done.**
6. Later: new data categories, console dApp, on-chain swap.

The first stage deliberately has **no signing at all** — only reading and
address reveal. The mechanism settles on the simple case before it gets access
to money.

### 14.1. What turned out differently in practice (feeds)

Three things were not as the discussion assumed:

* **Telegram is not served over RSS directly.** `t.me/s/<name>` is HTML,
  and parsing it is fragile. The working path is the RSSHub route
  (`…/telegram/channel/<name>`), and the public `rsshub.app` closed program
  access: a plain request gets `403`, a browser User-Agent gets a Cloudflare
  page. So addresses with that host are rewritten to a mirror
  (`RSSHUB_MIRROR`) — hardcoded temporarily and changeable in one place.
  The Rust `t.me/s/` parser is kept and works, but it is not the main path.
* **Not all mirror routes work.** `telegram/channel/<name>` serves the feed,
  while `twitter/user/<name>` and `discord/channel/<id>` answer `503` — they
  need keys, and the mirror does not substitute them. That is a bridge
  limitation, not our fault.
* **The excerpt must not be truncated in storage.** The first version cut
  `summary` at 400 characters with a "…" inside the row, and expanding it on
  click was impossible — no text remained. Now the row stores the whole text
  (up to 4000 characters), and truncation is the display's job.

## 15. What is forbidden

- Calling a provider a dApp or vice versa.
- Embedding foreign code in the main interface; in an embedded slot — data
  only.
- Allowing a provider to sign or to draw the signing form.
- Merging lists on the provider's side.
- Hiding or switching off the item origin marker.
- Giving an external provider a transaction constructor in the first
  version.
- A common "Add provider" button instead of per-category entry points.
