# Login, profile creation and device sync

How a user gets into Stauri and how their profile ends up on a second device: which
secrets exist, where they live, and what happens on creation, recovery from a seed
phrase, and transfer to another device.

Code: `src/lib/entry/entryFlow.ts` (the transition rules), `src/routes/+page.svelte`
(state and handlers), `src-tauri/src/credentials.rs` (PIN and envelope),
`src-tauri/src/pairing.rs` (local pairing).

---

## 1. Three secrets

| Secret | What it protects | Who knows it | Where it lives |
|---|---|---|---|
| **Seed phrase**, 12 words | the right to own the profile anywhere | the user only | nowhere; shown once at creation |
| **Profile password**, 32 characters | encrypts the local status-go database | nobody | encrypted inside the envelope |
| **PIN**, 4–12 digits | the envelope holding the password | the user | nowhere; a key is derived from it |

Two things have to be remembered: the seed phrase, forever, because it moves the
profile to any device, and the PIN, for every launch. The database password is known
to nobody, and that is deliberate rather than an oversight — the app generates it, and
a human never needs it for the entire life of the profile.

The exception is profiles created before this scheme. Those open with a password the
user once chose. On first login such a profile is given a PIN and becomes ordinary
(§6).

### A PIN belongs to the device, not the profile

The same profile has different PINs on a phone and on a desktop, and that is correct.
The envelope is tied to the device; what travels is the profile, not the secret. One
seed phrase, as many PINs as there are devices. A single PIN shared across devices is
neither supported nor planned.

---

## 2. Where things live

Data is split by network: mainnet and testnet profiles do not see each other.

```
<data-dir>/<network>/                                       databases and profile keystores
<data-dir>/credentials/<network>/<keyUid>/envelope.json     PIN and the encrypted password
<data-dir>/credentials/<network>/<keyUid>/attempts.json     wrong-PIN counter
```

`keyUid` is 64 hex characters and is also the keystore directory name. The value is
checked against an allow-list and **normalised to lower case**: without that, `0xAB…`
and `0xab…` would create two directories for one profile, and a PIN stored in one would
not be found in the other. This is a refusal, not sanitising — `../` must be rejected,
not corrected, because these values become path components.

### The envelope

```json
{ "version": 2, "backend": "android-pin", "kdf": {…}, "salt": "…", "nonce": "…", "ciphertext": "…" }
```

- **Argon2id**: 64 MiB of memory, 3 passes, 1 lane. The parameters are recorded inside
  the envelope so a future build can still open an old file after the defaults change.
- **AES-256-GCM**: 16-byte salt, 12-byte nonce, 32-byte key.
- A wrong PIN fails the authentication tag. There is nothing to compare and nothing to
  forge, and from the outside "wrong PIN" cannot be told apart from "corrupt file" —
  which is the point.

Why such an expensive function: a four-digit PIN has ten thousand possibilities, and
with a cheap hash they fall in seconds. A memory-hard KDF turns that into years. The
PIN is weak by construction — it is short because it is typed on a phone — and the KDF
is exactly what pays for it.

When reading the envelope the app trusts none of what is written in it:

- the **version** must match the current one;
- the **backend** must be this platform's (`android-pin` on a phone, `desktop-pin` on a
  desktop) — a file from another platform is refused, not parsed as our own;
- the **KDF parameters** are range-checked. They are input, not constants: a file
  claiming `memory_kib = 4_000_000` would bring the process down on the next PIN entry,
  and one claiming `memory_kib = 8` would make brute force cheap.

Writing is careful for the same reason: the file goes to a temporary name, is flushed
to disk, then renamed over the target, and the directory is synced afterwards. A
half-written envelope is a profile nobody can open; truncating the live file would open
exactly that window. The counter is written **before** the envelope, so a failed second
write cannot leave a fresh envelope behind an exhausted counter.

---

## 3. Entry on a device that already has the profile

```
launch → profile list → PIN → Home
```

1. The app starts status-go and reads the profiles of the **selected network**.
2. The slot state (`credential_pin_state`) decides which screen appears (§3.2).
3. The PIN opens the envelope (`credential_open_pin`), and the password it yields goes
   to `LoginAccount`.
4. The session counts as opened by PIN, which means it can be locked (§7).

No profiles, no PIN pad: there is nothing to lock.

### 3.1. The entry screen

One screen, one topic — which profile to open:

```
Stauri
  Mainnet | Testnet
  ── Profile ──
  [Select Profile & Log in]   (only when profiles exist)
  [Create Profile]
  [Restore or sync]
```

"Restore or sync" leads to the choice: recovery phrase, syncing from another device,
Keycard (still off). "Sync **to** another device" is deliberately absent — see §8.1.
When the device has exactly **one** profile, the list is skipped and the PIN is asked
for straight away. A list of one row only added a Back button that led nowhere.

An open session is tracked by its own flag, not only by `isLoggedIn`. The backend can
stop and come back — on the first start after an update it restarts while migrating — and
`isLoggedIn` dips to `false`. A render that trusted only that flag showed the PIN pad
right after a good login. The session flag changes only when a profile is really opened
or closed; on top of it there is a two-and-a-half-second hold for the case where the
backend blinks first.

### 3.2. The slot state decides which screen appears

The keypad is not shown blindly. The state is read **before** it, otherwise "straight to
the phrase once the limit is reached" would not work: the pad would appear, the refusal
would only arrive on a keypress, and the user could not tell a lockout from a typo.

| State | Screen | Why |
|---|---|---|
| `missing` | password | a profile from before the PIN scheme; the user knows the password |
| `ready` | PIN pad | the ordinary case |
| `locked-out` | phrase | the envelope will not open again |
| `damaged` | phrase | an envelope exists but cannot be read |

`damaged` is not "no PIN". The password behind such an envelope was generated by the
app, nobody knows it, so the password screen would be a door that does not open. That
state comes from a corrupt file, and also from a profile received over pairing whose
PIN was never set (§8.5).

### The rules

| Rule | Value | Where |
|---|---|---|
| PIN length | 4–12 digits | `credentials.rs`, mirrored in `entryFlow.ts` |
| attempts before lockout | 10 | `MAX_ATTEMPTS` |
| wrong PIN | counter +1, the message reports the attempts left | `open_pin` |
| correct PIN | the counter resets | `open_pin` |

The counter is written **before** the answer is returned, so a process killed mid-attempt
cannot undo it. Attempts are serialised by a mutex — otherwise ten parallel calls would
read the same value and each write the same plus-one. And a counter that cannot be read
as JSON counts as exhausted: a corrupt file must not hand out ten fresh guesses.

---

## 4. Creating a profile

```
entry → Create Profile → (password generated) → PIN → repeat PIN → profile created → seed phrase → Home
```

1. **The password is generated** in the webview: 32 characters, from
   `crypto.getRandomValues` only, one character of each class (upper case, lower case,
   digit, symbol), then shuffled. Without guaranteed classes the string could by chance
   fail the password rules and the user could not fix it, because they never see it.
2. **The PIN is asked for before the profile exists.** It used to be the other way round,
   and that left debris: the profile was created, nobody knew its password, and walking
   away from the PIN screen left an account that could never be opened. Now nothing is on
   disk until the PIN is confirmed, so abandoning the flow is safe.
3. **`CreateAccountAndLogin`** runs after the PIN. It logs in immediately, which is why
   the screen is held in place by a render condition until the envelope is saved.
4. **If saving the envelope fails**, the profile that was just created is deleted: an
   account with an unknown password is worse than no account.
5. **The PIN is entered twice.** A typo would encrypt the password under a value its
   owner does not know, and nothing can undo that except the seed phrase.
6. **The seed phrase is shown and checked** (`CreateSeed`): words come one at a time
   through `seed_word(index)`, the answers are compared in Rust (`verify_seed_answer`),
   and the whole phrase never reaches the webview. Leaving the screen runs `clear_seed`,
   which wipes it from process memory.
7. **Saving the phrase returns to Home.**

The seed screen is not optional: the PIN cannot be recovered, and the phrase is the only
way back.

---

## 5. Recovery from a seed phrase

```
entry → I already have a profile → Enter recovery phrase → 12 words → password → Home
```

The password here is chosen by the user: recovery creates a new local database, and it
has to be encrypted with something. It is a different password from the one on the
device where the profile was created.

The app distinguishes two cases by the `keyUid` derived from the phrase:

- **the profile is not here** — ordinary recovery through `RestoreAccountAndLogin`;
- **the profile is here, but the password does not open it** — `LocalProfileLockedError`.
  This is not a typo: the profile sits here under a different password, and it cannot be
  guessed. The screen offers to delete the local copy and restore from scratch
  (`resetLocalProfileAndRestore`). Message history and settings on this device are lost
  in the process, and the warning is shown before the press.

A trap for anyone debugging this: `RestoreAccountAndLogin` answers `{"error":""}` on
failure too. The real result arrives as the `node.login` signal. Taking the synchronous
reply for success means one day "successfully" restoring a profile that did not restore.

---

## 6. A profile from before the PIN scheme

Such a profile has no envelope at all, and only the user knows its password.

```
profile list → password → PIN → repeat PIN → Home
```

The password is asked for **once, ever**: right after a successful login the PIN screen
opens, and the profile becomes ordinary. The seed phrase is not shown again — it was
saved when the profile was created.

The same state appears after recovery by phrase (§5): the profile is open on a password
that is not in any envelope. Until the next launch it lives on that password, and on the
following start it takes the same path and gains a PIN.

---

## 7. Locking when the app goes to the background

The PIN protects the launch. The other half protects against someone picking up a device
that is already unlocked: when the app goes to the background, the interface is covered
by the PIN pad.

- **Triggers** are `visibilitychange` (`hidden`) and `blur`, on both platforms. The
  Android WebView does not always report the first, while the second arrives reliably;
  on the desktop a window `blur` is exactly "the user walked away". Locking is
  idempotent, so a double trigger costs nothing.
- **`blur` is too eager, and on Android it is not needed at all.** Dismissing the
  on-screen keyboard fires it, and that happens right after the PIN is entered. On a
  phone, going to the background arrives as `visibilitychange` → `hidden`, so `blur`
  while the page is still visible is ignored outright. The desktop is the opposite: the
  window stays `visible` while losing focus, so there `blur` is the only sign the user
  walked away; it keeps a one-and-a-half-second window after an unlock so that
  dismissing the keyboard does not lock the session.
- **The backend is not logged out.** Logging out is the obvious move, but it stops the
  messenger, so every switch between apps would cost a resync on return. What protects
  the data is the pad in front and the wipe of the session password
  (`clearSessionPassword`): nothing can be signed without the PIN, and the database is
  encrypted on disk anyway.
- **An honest limitation.** The password is erased by assigning an empty string. In
  JavaScript strings are immutable, and wiping the old copy in the heap cannot be
  guaranteed — `TextEncoder` and buffer overwriting change nothing here. What actually
  matters is lifetime: the password exists only while the session is unlocked, and it
  never reaches `localStorage` under any key.
- **Unlocking goes through the same `openPin`**, so the attempt limit is shared:
  restarting the app does not reset it.
- **A profile opened by password** (§6, before it has a PIN) is not locked: asking for a
  PIN that does not exist is a dead end.

---

## 8. Moving a profile to another device

### 8.1. The role follows from state, not intent

| Role | Who that is | What it does |
|---|---|---|
| **Sender** | the device where the profile is open | enters the PIN, shows six digits, hands the profile over |
| **Receiver** | an empty or new device | waits, shows the same six digits, takes the profile in |

The sender is always the logged-in device: what travels is the keys, and only that
device has them. The reverse — a profile arriving on a device that is already logged in —
is not something this scheme supports.

### 8.2. The transport is the local network

Status can find the second device through the global anonymous Waku relay: messages
travel through random nodes on the internet. For a first sync that is a poor channel —
slow, dependent on the carrier's NAT, and the encrypted handshake packets still leave the
house. So for the first transfer Status moves both sides into one local network: an mDNS
beacon, a direct TCP connection, packets that never cross the router. The cryptography is
unchanged; the transport changes, and with it the latency — fractions of a millisecond
instead of seconds, so every handshake step completes without risking a timeout.

Stauri works the same way, with one difference: status-go has no discovery of its own.
`PeerNotifier.Search` returns early on Android with the comment "Sorry Android" — the
mDNS beacon is disabled there. So discovery has to be written on top of that same local
channel rather than taken from the library.

Both sides have one requirement: to be on the same subnet.

- **Wi-Fi** is the ordinary case.
- **A USB cable** is not a transport, it is a wire. It becomes a channel when a modem
  runs over it (USB tethering): the computer and the phone get a private subnet, and from
  there everything behaves exactly as over Wi-Fi. There is no separate "over USB" branch
  in the code: two paths to one screen would mean two sets of bugs.
- **`adb reverse`** is a development trick: it forwards a port from the machine to the
  phone. It is not a user path — it needs USB debugging and a computer — so the interface
  does not offer it.

Local networks break predictably, and every cause looks the same — "waiting for the second
device" and then nothing: client isolation on the router (AP isolation), a guest network
instead of the main one, different SSIDs, a VPN on either side. That is why the waiting
screen names those four causes up front rather than after five minutes of silence.

### 8.3. The connection string is a secret, and nobody sees it

The transfer is carried by status-go's connection string: address, port, public key,
transfer encryption key and installation id, in base58 separated by colons. It is also
what authenticates the channel: the client checks that the server's certificate is signed
by the key inside the string, then pins it.

Inside it is the AES-256 key that encrypts the whole transfer. So the string is not an
address but a key, and everything true of keys is true of it: whoever reads it while the
server is up can take the profile.

Hence the rule: the string is never shown and never copied. Four hundred base58
characters copied off a screen or sent to yourself in a messenger are a key that has been
through everyone it passed, and by the time it is used more than two people have seen it.

The string travels **inside an already established session** (§8.4), and only after both
people have compared the digits. Before that comparison it does not exist: the server
that issues it has not started. A substituted counterpart never receives it at all.

Of the five calls the library offers, this scheme needs one:

```rust
GetConnectionStringForBootstrappingAnotherDevice     // sender: issue the string
InputConnectionStringForBootstrapping                // receiver: take the profile in with it
ValidateConnectionString                             // check without starting anything
```

The other two (`GetConnectionStringForBeingBootstrapped`,
`InputConnectionStringForBootstrappingAnotherDevice`) serve the reversed direction, which
does not suit us (§8.9).

### 8.4. The handshake and the six digits

1. The receiver announces itself on the local network. The announcement carries a
   one-time public key (X25519) and a port. There is no secret in it: the key lives until
   the attempt ends and is never used again.
2. The sender finds the announcement and answers with its own one-time key.
3. Both sides compute the Diffie-Hellman shared secret. It is not on the wire: someone
   who captured the announcements has two public keys and nothing else.
4. From the shared secret and the transcript — both ephemeral keys, in the order they
   were made — a session key is derived (HKDF-SHA256). The six digits come from it too.
   The transcript matters: the digits promise not "some shared secret" but this exact
   exchange.
5. The same six digits appear on both screens at once. They are compared by eye; they are
   never typed anywhere, and the interface says so.
6. They match — each side presses Sync. The transfer starts when both have pressed:
   consent to the move comes from two devices, not only from the one holding the profile.
7. After that the channel is encrypted with keys from the same secret, the sender sends
   its connection string, starts the server and hands the profile over.

If the digits differ, nobody presses anything. That is the protection against a man in the
middle: he shares no secret with either side, so he has to run two separate exchanges, one
with each, and the digits the two people see diverge. He does not get the string
afterwards either: it goes out only once both sides have pressed Sync.

The computation lives in Rust, not in the webview: a second implementation in JavaScript
would be a second way to get it wrong, and a mismatch would look like an attack.

Six digits rather than Status's eight. The difference is small: the code can only be
guessed live, inside a five-minute window, and after the first failure the person simply
closes the screen.

The receiver has nothing to lock, so it chooses its own PIN right after the profile
arrives (§8.5), not before the handshake: a password for a door that does not exist yet is
not protection. On the sender the PIN comes before every other step: the code must not
appear on a phone left on a table.

### 8.5. The password arrives with the profile

The status-go payload (`LocalPairingPayload.password`) carries the **sender's password**,
and the receiver stores the keys under it. It does not come back in the call's reply but
arrives as the `received-account` signal:

```json
{"type":"localPairing","event":{"type":"received-account","data":{"account":{…},"password":"…","chatKey":"…"}}}
```

That is why the signal subscription is set up **before** the transfer starts: the event
can arrive before the call returns, and a subscriber that shows up afterwards would wait
five minutes for something that already happened.

The password **never reaches the webview**. `pairing_receive` parks it in an in-memory
slot in Rust, and the frontend receives only `key_uid` and the name. Once the user picks
a PIN, `credential_save_pin_from_pending` is called — the only path the password takes to
disk, already encrypted. The page then reads it back through `openPin`: if the PIN really
opens the envelope, that is also the proof that it was stored correctly.

Walk away from the PIN screen without setting one and the password is dropped
(`credential_forget_pending`). The profile stays on disk, but nothing can open it: that
is the `damaged` state from §3, and the only way back is the seed phrase.

Showing the password to the user would be pointless in any case: nobody retypes 32 random
characters.

### 8.6. Message history is a choice

The `messageSyncingEnabled` field in the sender config turns on transferring the
conversation. It is off by default, and the checkbox on screen says so: every message on
this device travels, with no date limit.

The checkbox sits on the PIN screen, before the server starts, and it cannot live on
the receiving side. status-go prepares the payload when the server starts — before the
receiver exists — so the receiving device can no longer choose what travels. The sender
decides first, and that is also why the checkbox must not look like part of the screen
that displays the code.

It is **on** by default: a profile without its conversations is a profile with empty
chats, and someone syncing a device usually wants the familiar picture back. Anyone who
does not want the whole history untick it — the cost is stated right there. status-go's own source calls this a privacy
decision the user has to make deliberately — and that is not boilerplate: there is no
"last N days" window, batches of a hundred messages go out from the whole database.

Attachments are not transferred separately: media lives on a CDN, and messages carry
links and metadata.

The flag is read only on the server side, which is the device with the profile. That is
also why the direction stays as it is: the logged-in device shows the code. Swapping the
roles would lose the history without patching the library.

### 8.7. The code expires

The transfer lives for five minutes: `serverConfig.timeout` in the sender config, in
milliseconds. The clock starts when the server starts, which is the moment both sides
pressed Sync, and the server closes itself when it runs out — a transfer already under
way is not cut short, but a new string will not be accepted from that moment.

The receiver's announcement lives just as long. After five minutes the waiting screen
returns to its starting state and offers to begin again, rather than sitting there
looking like it is working.

For the user this means: while the digits are on screen the attempt is live; walk away or
dawdle and you start again.

Five minutes is not arbitrary: it is the value status-go uses in its own pairing tests.

### 8.8. The sequence

**Sending (the device with the profile):**

Profile → "Sync with another device" → PIN on the same keypad used everywhere → "Waiting
for the second device" → six digits → compare with the receiver's screen → Sync.

One screen, one action: there is no separate "show the code" step, because entering the
PIN is the confirmation. The history checkbox sits under the keypad — it is decided
before the server starts, since after that nothing about the payload can change.

**Receiving (the new device):**

Entry → "Restore or sync" → "Sync from another device" → "Waiting for the second
device" → six digits → compare → Sync → the profile arrives → set the PIN twice → Home.

The receiver picks its own PIN at the end, when there is something to lock. Inventing it
earlier would mean asking for a password to a door that does not exist yet.

### 8.9. What is not possible yet

- **Stopping the server on demand.** The status-go export for it is not wired up, and the
  back button does not stop it. A started send is either finished or the app is
  restarted.
- **Reversing the direction.** The new device shows the code and the primary enters it —
  that is how Signal and Status do it. Ours is the other way round because with the roles
  swapped the empty device becomes the server, and the history flag is only read there;
  history would not travel (§8.6).
- **Transferring when the devices cannot see each other.** Both need a shared subnet;
  over the internet there is no path. That is a property of the channel, not of the
  implementation, and it is exactly what makes Wi-Fi and a USB modem suitable for a first
  transfer: the packets never leave the house.
- **A QR code.** It would cover the case where there is no shared subnet at all — but the
  string would have to go into it whole, showing the secret again, which is what this
  scheme moves away from. How to solve that is an open question, not a forgotten
  checkbox.

---

## 9. Debugging

The trace goes to `bridge-trace.log` in the app's data directory. Passwords and seed
phrases never appear there — only lengths and outcomes.

```
credential pin saved network=mainnet key=0xcbae7ed2
credential pin open network=mainnet key=0xcbae7ed2 ok=false
credential pin saved from pairing key=0xcbae7ed2
note {"kind":"create","len":32,"sha256_16":"…"}
note {"kind":"login","len":32,"sha256_16":"…"}
pairing sender started key=0xcbae7ed2 stringLen=412 syncMessages=true
pairing received account key=0xcbae7ed2 passwordLen=32
```

Reading `note`: `len` is the password length (32 means generated, shorter means typed),
and `sha256_16` is the first sixteen characters of its hash, enough to tell one value
from another without revealing either.

On Android:

```
adb logcat -s stauri
```

A release build is not debuggable, so `run-as` will not reach the trace file — on a
release APK logcat is the only way to read it.

The absence of `credential pin` lines during a live login means the profile went down the
password path. That is the first question to ask whenever "the profile does not open".

---

## 10. Still to do

1. **A live transfer between two devices has not been run.** What is verified: the build,
   the parsing of the string and of the events, and the absence of crashes. The local
   discovery and the handshake of §8.2–8.4 are not in the build yet: that is the next
   step. Until then the string is still passed by hand, by copying — a temporary path
   that goes away with it.
2. **Fingerprint unlock.** Planned as an accelerator on top of the PIN: a key in the
   Android Keystore with `setUserAuthenticationRequired(AUTH_BIOMETRIC_STRONG)` unlocks
   the envelope, and the PIN stays as the fallback. Not instead of the PIN — losing a
   fingerprint must not mean losing the profile.
3. **Changing the PIN.** An envelope can only be created or deleted along with the
   profile.
4. **A QR code** — see §8.9.
5. **Stopping the pairing server** and **reversing the direction** — see §8.9.
