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
2. Tapping a profile asks for the slot state (`credential_pin_state`).
3. The PIN opens the envelope (`credential_open_pin`), and the password it yields goes
   to `LoginAccount`.
4. The session counts as opened by PIN, which means it can be locked (§7).

No profiles, no PIN pad: there is nothing to lock.

### The slot state decides which screen appears

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
PIN was never set (§8.4).

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
entry → Create Profile → (password generated) → PIN → repeat PIN → seed phrase → Home
```

1. **The password is generated** in the webview: 32 characters, from
   `crypto.getRandomValues` only, one character of each class (upper case, lower case,
   digit, symbol), then shuffled. Without guaranteed classes the string could by chance
   fail the password rules and the user could not fix it, because they never see it.
2. **`CreateAccountAndLogin`** creates the profile and logs in immediately. That is why
   the PIN screen is held in place by a separate render condition — otherwise it would
   vanish before the user typed anything.
3. **The PIN is asked for after creation**, not before: `keyUid` is only known from
   status-go's reply, and the envelope is filed under it.
4. **The PIN is entered twice.** A typo would encrypt the password under a value its
   owner does not know, and nothing can undo that except the seed phrase.
5. **The seed phrase is shown and checked** (`CreateSeed`): words come one at a time
   through `seed_word(index)`, the answers are compared in Rust (`verify_seed_answer`),
   and the whole phrase never reaches the webview. Leaving the screen runs `clear_seed`,
   which wipes it from process memory.
6. **Saving the phrase returns to Home.**

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
- **`blur` is too eager on its own.** Dismissing the on-screen keyboard fires it too —
  and that happens right after the PIN is entered. So for the first one and a half
  seconds after a successful unlock, `blur` is ignored, and only while the page is still
  visible. Going to another app arrives as `hidden` and locks immediately, no grace
  period.
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
| **Sender** | the device where the profile is open | shows the code, hands the profile over |
| **Receiver** | an empty or new device | enters the code, takes the profile in |

The sender is always the logged-in device: what travels is the keys, and only that
device has them. The reverse — a profile arriving on a device that is already logged in —
is not something this scheme supports.

### 8.2. The connection string is the only channel

status-go exposes five calls, and each is used exactly once:

```rust
GetConnectionStringForBootstrappingAnotherDevice     // sender: produce the code
GetConnectionStringForBeingBootstrapped              // receiver: produce the code
InputConnectionStringForBootstrapping                // receiver: read the other one's
InputConnectionStringForBootstrappingAnotherDevice   // sender: read the other one's
ValidateConnectionString                             // check without starting anything
```

The string is a few hundred base58 characters separated by colons: address, port, public
key, encryption key, installation id. It is also what authenticates the transfer: the
client checks that the server's certificate is signed by the key inside the string, then
pins it. A stranger on the same Wi-Fi cannot pose as the other device without it.

**There is no device discovery, and that is not an oversight.** In status-go
`PeerNotifier.Search` returns early on Android with the comment "Sorry Android": the
mDNS beacon is disabled there. A "searching for devices" screen on a phone would find
nothing. So one side always shows the string and the other types it in.

Delivery is a display with a copy button and a plain input where the string is pasted by
long-press. There is deliberately no separate "paste" button:
`navigator.clipboard.readText()` in a WebView needs a permission and stays silent when
it is refused, instead of reporting the failure.

The "over Wi-Fi" and "over USB" choices are presentation only. status-go always connects
over TCP on the local network; the only difference is how the string gets from one screen
to the other.

### 8.3. Six digits that people compare

The string is a secret, not just an address. Whoever reads it while the server is up can
take the profile. So both sides show six digits derived from the encryption key inside
the string, and a human compares them.

- Both sides compute the same thing over the same bytes. It is implemented in Rust
  (`pairing.rs`), not in the webview: a second implementation in JavaScript would be a
  second way to get it wrong, and a mismatch would look like an attack.
- A string substituted on its way across yields different digits. If they differ, the
  transfer is not started.
- On the receiving side it takes two presses, not one: "show the confirmation code"
  first, and only after the digits match, "start the transfer". A wrong code cannot be
  sent by accident on the first press.

**What the digits do not do.** They catch substitution, not theft: someone who saw the
whole string uses it as it is, and the digits agree. Two other things cover that — the
short lifetime of the code, and the PIN required before it is shown.

### 8.4. The password arrives with the profile

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

### 8.5. Message history is a choice

The `messageSyncingEnabled` field in the sender config turns on transferring the
conversation. It is off by default, and the checkbox on screen says so: every message on
this device travels, with no date limit. status-go's own source calls this a privacy
decision the user has to make deliberately — and that is not boilerplate: there is no
"last N days" window, batches of a hundred messages go out from the whole database.

Attachments are not transferred separately: media lives on a CDN, and messages carry
links and metadata.

The flag is read only on the server side, which is the device with the profile. That is
also why the direction stays as it is: the logged-in device shows the code. Swapping the
roles would lose the history without patching the library.

### 8.6. The code expires

The code lives for five minutes: `serverConfig.timeout` in the sender config. The clock
starts when the server starts, and the server closes itself when it runs out — a transfer
already under way is not cut short, but a new string will not be accepted from that
moment. For the user this means: while the code is on screen it works; walk away or
dawdle and you start again.

Five minutes is not arbitrary: it is the value status-go uses in its own pairing tests.

### 8.7. The sequence

**Sending (the device with the profile):**

Profile → "Show this device's code" → **PIN** → the string and six digits → tick the
history box if it is wanted → pass the string to the second device.

**Receiving (the new device):**

Entry → "I already have a profile" → "Sync with another device" → paste the string →
"Show the confirmation code" → compare the digits → "The digits match — start the
transfer" → set the PIN twice → Home.

Do not send the string through a messenger. That is exactly how it leaks: a code sent to
yourself in a chat has been seen by more than you by the time it is used.

### 8.8. What is not possible yet

- **Stopping the server on demand.** The status-go export for it is not wired up, and the
  back button does not stop it. A started send is either finished or the app is
  restarted.
- **Reversing the direction.** The new device shows the code and the primary enters it —
  that is how Signal and Status do it. Ours is the other way round because with the roles
  swapped the empty device becomes the server, and the history flag is only read there;
  history would not travel (§8.5).
- **Owner confirmation of the transfer.** With the current direction the profile goes to
  whoever holds the string. The code's lifetime and the PIN before showing it are the
  protection, not an owner's consent at the moment of transfer.

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
   the parsing of the string and of the events, and the absence of crashes.
2. **Fingerprint unlock.** Planned as an accelerator on top of the PIN: a key in the
   Android Keystore with `setUserAuthenticationRequired(AUTH_BIOMETRIC_STRONG)` unlocks
   the envelope, and the PIN stays as the fallback. Not instead of the PIN — losing a
   fingerprint must not mean losing the profile.
3. **Changing the PIN.** An envelope can only be created or deleted along with the
   profile.
4. **A QR code.** The connection string is still passed by copying.
5. **Stopping the pairing server** and **reversing the direction** — see §8.8.
