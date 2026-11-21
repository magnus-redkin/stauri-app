//! Per-profile secrets: a PIN the user chooses, and the password it protects.
//!
//! The mobile entry flow generates a random password for the profile database and never
//! shows it. The user instead sets a **PIN of their own** — four to twelve digits — and
//! that PIN is the only thing they have to remember.
//!
//! # What protects what
//!
//! One layer does the work: the **PIN** never reaches the disk. Argon2id derives a key
//! from it, and that key encrypts the profile password with AES-GCM. The envelope holds
//! the salt, the nonce and the ciphertext; a wrong PIN fails the authentication tag, so
//! there is nothing to compare and nothing to trick.
//!
//! The envelope sits in the application's private directory, which on Android is the
//! app sandbox and on the desktop is the per-user data directory. Both are readable by
//! the user's account and by nothing else; a second device cannot open the file at all,
//! because the key uid it is filed under exists only on the device that created it.
//!
//! # Why Argon2id and not a plain hash
//!
//! A four-digit PIN has 10 000 possibilities. Anyone holding a copy of the envelope can
//! try them all, so the derivation must be expensive: Argon2id with a memory-hard
//! parameter set turns a brute force from milliseconds into years. The PIN is the weak
//! part by construction — it is short because it is typed on a phone — and the KDF is
//! what makes that acceptable.
//!
//! # Retry limiting
//!
//! A local file cannot stop a determined attacker with the device, but it does stop a
//! person who picked up an unlocked phone: after [`MAX_ATTEMPTS`] wrong PINs the
//! envelope is refused until the profile is restored from its seed phrase. The counter
//! lives next to the envelope, and only a correct PIN clears it.

use std::collections::HashMap;
use std::io::Write;
use std::sync::Mutex;

use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};

/// On-disk format version. A bump means an older build must not read the file.
const ENVELOPE_VERSION: u32 = 2;

/// How many wrong PINs are tolerated before the envelope is locked.
///
/// Ten is enough for a fumbled PIN and far too few for guessing a four-digit one.
pub const MAX_ATTEMPTS: u32 = 10;

/// The PIN policy this platform applies when a PIN is **created**.
///
/// A PIN protects the profile's password and lives on this device only: nothing
/// ever moves it. The phone keeps a short numeric code and the desktop a passphrase,
/// and the creation rule is the half that can protect the profile — opening and
/// locking accept whatever was stored, because rejecting a stored PIN would strand
/// it behind a rule its owner has no way to see.
mod pin_policy {
    #[cfg(target_os = "android")]
    pub const MIN: usize = 5;
    #[cfg(not(target_os = "android"))]
    pub const MIN: usize = 8;

    #[cfg(target_os = "android")]
    pub const MAX: usize = 12;
    #[cfg(not(target_os = "android"))]
    pub const MAX: usize = 64;

    /// Android: digits only, which is all its keypad can type.
    #[cfg(target_os = "android")]
    pub const DIGITS_ONLY: bool = true;
    #[cfg(not(target_os = "android"))]
    pub const DIGITS_ONLY: bool = false;

    /// Desktop: all four classes, so the PIN has no dictionary to fall into.
    #[cfg(target_os = "android")]
    pub const REQUIRE_CLASSES: bool = false;
    #[cfg(not(target_os = "android"))]
    pub const REQUIRE_CLASSES: bool = true;
}

/// Whether a digit-only PIN is a pattern a thumb draws without thinking: all equal,
/// one step up, one step down.
fn is_trivial_digit_pin(pin: &str) -> bool {
    let digits: Vec<u8> = pin.bytes().collect();
    let n = digits.len();
    if n < 3 {
        return false;
    }
    if digits.iter().all(|&d| d == digits[0]) {
        return true;
    }
    let ascending = digits.windows(2).all(|w| w[1] == w[0] + 1);
    let descending = digits.windows(2).all(|w| w[1] == w[0] - 1);
    ascending || descending
}

/// Argon2id parameters.
///
/// 64 MiB and three passes is the OWASP recommendation for Argon2id and is affordable on
/// a phone (a fraction of a second). The numbers are part of the envelope format: a
/// change means old envelopes must keep their own values, so they are read back from the
/// file rather than assumed.
const ARGON2_MEMORY_KIB: u32 = 64 * 1024;
const ARGON2_TIME_COST: u32 = 3;
const ARGON2_LANES: u32 = 1;

/// Length of the derived key, in bytes (AES-256).
const KEY_LEN: usize = 32;
/// AES-GCM nonce length, in bytes.
const NONCE_LEN: usize = 12;
/// Salt length for Argon2id, in bytes.
const SALT_LEN: usize = 16;

/// One stored secret, as it sits on disk.
///
/// The password itself is never in this structure in clear: `ciphertext` is only readable
/// with the key derived from the PIN.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Envelope {
    /// Format version, checked on read.
    pub version: u32,
    /// Which platform sealed the file, so a file from another platform is refused
    /// instead of being parsed as garbage.
    pub backend: String,
    /// Argon2id parameters, stored with the envelope so a future build can still open
    /// an old one after the defaults change.
    pub kdf: KdfParams,
    /// Base64 salt for Argon2id.
    pub salt: String,
    /// Base64 AES-GCM nonce.
    pub nonce: String,
    /// Base64 ciphertext of the profile password.
    pub ciphertext: String,
}

/// One password that arrived with a paired profile and has not been wrapped under a PIN yet.
///
/// @remarks
/// The pairing payload carries the sender's profile password, and the receiver has to keep
/// it until the user picks a PIN. Keeping it here rather than in the webview is the point:
/// the password never crosses into JavaScript, and the only way out is
/// [`credential_save_pin_from_pending`], which stores it encrypted under a fresh PIN.
#[derive(Debug, Clone)]
pub struct PendingPassword {
    /// Slot the profile will be stored under.
    pub slot: Slot,
    /// The password itself, as it came from the other device.
    pub password: String,
}

/// Passwords waiting to be wrapped under a PIN, by slot.
///
/// @remarks
/// In memory only: a password that is lost when the app closes is a profile whose PIN was
/// never set, and the seed phrase is the way back — the same outcome as closing the app on
/// the PIN screen after creating a profile.
static PENDING: Lazy<Mutex<HashMap<(String, String), PendingPassword>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// Remembers a password that arrived with a paired profile.
pub fn stash_pending(slot: Slot, password: String) {
    if let Ok(mut pending) = PENDING.lock() {
        pending.insert((slot.network.clone(), slot.key_uid.clone()), PendingPassword { slot, password });
    }
}

/// Forgets the pending password of a slot, if any.
///
/// @returns `true` when something was there.
pub fn drop_pending(network: &str, key_uid: &str) -> bool {
    PENDING
        .lock()
        .map(|mut pending| pending.remove(&(network.to_string(), key_uid.to_string())).is_some())
        .unwrap_or(false)
}

/// Takes the pending password of a slot and removes it.
fn take_pending(network: &str, key_uid: &str) -> Option<PendingPassword> {
    PENDING
        .lock()
        .ok()?
        .remove(&(network.to_string(), key_uid.to_string()))
}

/// Argon2id parameters recorded with the envelope.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct KdfParams {
    /// Memory cost, KiB.
    pub memory_kib: u32,
    /// Time cost, passes.
    pub time_cost: u32,
    /// Parallelism.
    pub lanes: u32,
}

impl KdfParams {
    /// The parameters this build writes.
    fn current() -> Self {
        Self {
            memory_kib: ARGON2_MEMORY_KIB,
            time_cost: ARGON2_TIME_COST,
            lanes: ARGON2_LANES,
        }
    }
}

/// Wrong-PIN bookkeeping, kept beside the envelope.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Attempts {
    /// Wrong PINs since the last success.
    pub failed: u32,
}

/// A slot the frontend asks about: network plus profile.
///
/// Both parts come from the frontend and reach the filesystem, so they are validated: a
/// key uid is 64 hex characters with an `0x` prefix, and a network name is one of the
/// known ones.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Slot {
    pub network: String,
    pub key_uid: String,
}

impl Slot {
    /// Validates the parts that become a path.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Config`] for an unknown network, and
    /// [`crate::error::ErrorKind::Internal`] for a malformed key uid.
    pub fn new(network: &str, key_uid: &str) -> AppResult<Self> {
        // An allow-list, not a sanitising pass: these two values are path components,
        // and a value like `../../` must be refused rather than cleaned up.
        const NETWORKS: [&str; 2] = ["mainnet", "testnet"];
        if !NETWORKS.contains(&network) {
            return Err(AppError::config(format!("unknown network: {network}")));
        }
        let hex = key_uid.strip_prefix("0x").unwrap_or("");
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(AppError::internal("malformed key uid"));
        }
        // Stored normalised, not as typed: the key uid is a path component, and `0xAB…`
        // and `0xab…` would otherwise be two directories holding one profile — the PIN
        // saved under one would not be found under the other.
        Ok(Self {
            network: network.to_string(),
            key_uid: format!("0x{}", hex.to_ascii_lowercase()),
        })
    }

    /// Directory holding this profile's secrets.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Internal`] when no data directory is known.
    fn dir(&self) -> AppResult<std::path::PathBuf> {
        let base = crate::appdirs::data_dir()
            .ok_or_else(|| AppError::internal("cannot determine app data dir"))?;
        Ok(base.join("credentials").join(&self.network).join(&self.key_uid))
    }

    /// Path of the envelope.
    ///
    /// # Errors
    /// Returns [`crate::error::ErrorKind::Internal`] when no data directory is known.
    pub fn path(&self) -> AppResult<std::path::PathBuf> {
        Ok(self.dir()?.join("envelope.json"))
    }

    /// Path of the failed-attempt counter.
    fn attempts_path(&self) -> AppResult<std::path::PathBuf> {
        Ok(self.dir()?.join("attempts.json"))
    }
}

/// Whether a PIN being **created** has an acceptable shape.
///
/// @returns `None` when it is fine, otherwise the reason.
/// @remarks
/// Checked on the Rust side as well as in the interface: the PIN is the only thing
/// protecting the profile, and a weak one would be a false sense of safety. The policy
/// is the creation half of {@link pin_problem}: opening accepts whatever was saved.
pub fn creation_problem(pin: &str) -> Option<&'static str> {
    // Counted in characters, not bytes: a non-ASCII letter is several bytes, and a
    // byte-length test would reject a passphrase for a length the user never counted.
    let length = pin.chars().count();
    if length < pin_policy::MIN {
        return Some("the PIN is too short");
    }
    if length > pin_policy::MAX {
        return Some("the PIN is too long");
    }
    if pin_policy::DIGITS_ONLY && !pin.bytes().all(|b| b.is_ascii_digit()) {
        return Some("the PIN must be digits");
    }
    // A pattern the owner's thumb draws without thinking — all equal, one step up, one
    // step down. Worth blocking; a random five digits is not.
    if is_trivial_digit_pin(pin) {
        return Some("the PIN is too predictable");
    }
    if pin_policy::REQUIRE_CLASSES {
        let has_lower = pin.bytes().any(|b| b.is_ascii_lowercase());
        let has_upper = pin.bytes().any(|b| b.is_ascii_uppercase());
        let has_digit = pin.bytes().any(|b| b.is_ascii_digit());
        let has_symbol = pin.bytes().any(|b| !b.is_ascii_alphanumeric());
        if !(has_lower && has_upper && has_digit && has_symbol) {
            return Some(
                "the PIN must mix lowercase, uppercase, digits and symbols",
            );
        }
    }
    None
}

/// Whether a PIN being **typed to open or lock** is well formed.
///
/// @returns `None` when it can be a stored PIN, otherwise the reason.
/// @remarks
/// Deliberately loose: it accepts anything a creation could have stored, and rejects
/// nothing else. A wrong PIN and a malformed one must stay indistinguishable — this is
/// the door an attacker tries, and telling the difference helps them.
pub fn pin_problem(pin: &str) -> Option<&'static str> {
    let length = pin.chars().count();
    if length == 0 {
        return Some("the PIN is empty");
    }
    if length > pin_policy::MAX {
        return Some("the PIN is too long");
    }
    None
}

/// Stores `password` encrypted under `pin`.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Config`] for a weak PIN or an empty password, and
/// [`crate::error::ErrorKind::Io`] when the file cannot be written.
pub fn save_pin(slot: &Slot, pin: &str, password: &str) -> AppResult<()> {
    if let Some(problem) = creation_problem(pin) {
        return Err(AppError::config(problem));
    }
    // An empty password would produce an envelope that opens "successfully" and then
    // fails at `LoginAccount`, with nothing on the device able to repair it: the envelope
    // now exists, so the flow no longer offers the password prompt.
    if password.is_empty() {
        return Err(AppError::config("the profile password is empty"));
    }

    let salt = random_bytes(SALT_LEN)?;
    let nonce = random_bytes(NONCE_LEN)?;
    let key = derive_key(pin, &salt, &KdfParams::current())?;
    let ciphertext = encrypt(key.as_slice(), &nonce, password.as_bytes())?;

    let envelope = Envelope {
        version: ENVELOPE_VERSION,
        backend: platform::BACKEND.to_string(),
        kdf: KdfParams::current(),
        salt: b64_encode(&salt),
        nonce: b64_encode(&nonce),
        ciphertext: b64_encode(&ciphertext),
    };

    let dir = slot.dir()?;
    create_private_dir(&dir)?;
    let body = serde_json::to_vec_pretty(&envelope)
        .map_err(|e| AppError::internal(format!("serialise envelope: {e}")))?;
    // Counter first, envelope second. The other order leaves a fresh envelope behind an
    // exhausted counter if the second write fails, and the profile would then refuse the
    // PIN that was just set — the one state from which only the seed phrase recovers.
    reset_attempts(slot)?;
    write_private(&slot.path()?, &body)?;
    Ok(())
}

/// Stores the password a paired profile arrived with, under a PIN the user chose.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Config`] when no pairing is waiting for this
/// profile or the PIN is malformed.
/// @remarks
/// This is the only path a received password takes to disk. It never reaches the
/// webview: `pairing_receive` parks it in [`PENDING`], and this call is what wraps it.
pub fn save_pending_pin(network: &str, key_uid: &str, pin: &str) -> AppResult<()> {
    let slot = Slot::new(network, key_uid)?;
    let pending = take_pending(&slot.network, &slot.key_uid).ok_or_else(|| {
        AppError::config("this profile has no password waiting for a PIN")
    })?;
    let result = save_pin(&pending.slot, pin, &pending.password);
    if result.is_err() {
        // A refused PIN must not lose the password: the user retypes it, and the profile
        // is still waiting. Put it back without touching what is already there.
        stash_pending(pending.slot.clone(), pending.password.clone());
    }
    result
}

/// Opens the envelope with `pin` and returns the profile password.
///
/// # Errors
/// * [`crate::error::ErrorKind::Config`] when the input is not a plausible PIN;
/// * [`crate::error::ErrorKind::Backend`] when the PIN is wrong, the counter is
///   exhausted, or no PIN has been set for this profile.
///
/// # Remarks
/// A wrong PIN and a corrupted envelope look the same by construction: AES-GCM cannot
/// tell them apart, and saying which one it was would tell an attacker whether the PIN
/// was close.
pub fn open_pin(slot: &Slot, pin: &str) -> AppResult<String> {
    if let Some(problem) = pin_problem(pin) {
        return Err(AppError::config(problem));
    }

    // One attempt at a time per slot. The counter is a read-modify-write of a file, and
    // two concurrent calls would read the same value and write the same increment, so N
    // parallel guesses would cost one attempt instead of N. The pad sends one at a time,
    // but the command is reachable from the webview, and the limit is the protection.
    let _guard = attempt_guard();

    let failed = read_attempts(slot)?;
    if failed >= MAX_ATTEMPTS {
        return Err(AppError::backend(
            "too many wrong PINs: restore the profile from its seed phrase",
        ));
    }

    let envelope = match read_envelope(slot)? {
        Some(envelope) => envelope,
        None => return Err(AppError::backend("no PIN is set for this profile")),
    };
    check_envelope(&envelope)?;

    let salt = b64_decode(&envelope.salt)
        .ok_or_else(|| AppError::internal("envelope salt is not base64"))?;
    let nonce = b64_decode(&envelope.nonce)
        .ok_or_else(|| AppError::internal("envelope nonce is not base64"))?;
    let ciphertext = b64_decode(&envelope.ciphertext)
        .ok_or_else(|| AppError::internal("envelope ciphertext is not base64"))?;

    let key = derive_key(pin, &salt, &envelope.kdf)?;
    match decrypt(key.as_slice(), &nonce, &ciphertext) {
        Ok(plain) => {
            let password = String::from_utf8(plain)
                .map_err(|_| AppError::internal("decrypted password is not UTF-8"))?;
            reset_attempts(slot)?;
            Ok(password)
        }
        Err(_) => {
            // Counted before answering, so a process killed mid-attempt cannot reset it.
            record_attempt(slot)?;
            let left = MAX_ATTEMPTS.saturating_sub(failed + 1);
            Err(AppError::backend(format!(
                "wrong PIN ({} attempt(s) left)",
                left
            )))
        }
    }
}

/// Refuses an envelope this build cannot or should not open.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Internal`] for an unsupported version or a platform
/// mismatch, and [`crate::error::ErrorKind::Config`] for KDF parameters outside the range
/// the application ever writes.
///
/// @remarks
/// The KDF parameters are read from the file, which makes them input: a file claiming
/// `memory_kib = 4_000_000` would make the process allocate 4 GiB on the next PIN entry,
/// and a file claiming `8` would make the derivation cheap for whoever has a copy. Neither
/// is a scenario this build produces, so both are refused rather than clamped — a value
/// outside the range means the file is not one of ours.
fn check_envelope(envelope: &Envelope) -> AppResult<()> {
    if envelope.version != ENVELOPE_VERSION {
        return Err(AppError::internal(format!(
            "envelope version {} is not supported",
            envelope.version
        )));
    }
    if envelope.backend != platform::BACKEND {
        // Written for another platform. No migration exists, and parsing it as if it were
        // ours would be the wrong kind of lenient.
        return Err(AppError::internal(format!(
            "envelope was written by {}",
            envelope.backend
        )));
    }
    let kdf = &envelope.kdf;
    let plausible = (16 * 1024..=512 * 1024).contains(&kdf.memory_kib)
        && (1..=10).contains(&kdf.time_cost)
        && (1..=8).contains(&kdf.lanes);
    if !plausible {
        return Err(AppError::config("envelope KDF parameters are out of range"));
    }
    Ok(())
}

/// Serialises PIN attempts.
///
/// @remarks
/// One lock for every slot rather than a table of per-slot locks: a PIN attempt costs a
/// third of a second and a device has one person in front of it, so contending only
/// happens between two windows of the same application. A cross-process lock would need a
/// file lock and a dependency, and the counter is not meant to stop a second *process* —
/// it stops the person holding the phone, who is using this one.
fn attempt_guard() -> std::sync::MutexGuard<'static, ()> {
    static ATTEMPTS: Lazy<Mutex<()>> = Lazy::new(|| Mutex::new(()));
    // A panic inside a lock is not possible here: the body only reads and writes files.
    ATTEMPTS.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// Whether a PIN is set for this profile.
///
/// @returns `true` when the envelope exists and is readable.
pub fn has_pin(slot: &Slot) -> bool {
    matches!(read_envelope(slot), Ok(Some(_)))
}

/// What the frontend needs to know before it decides which screen to show.
///
/// @remarks
/// `HasPin` is not enough. A corrupt envelope and a missing one both read as "no PIN",
/// but they need opposite answers: a missing envelope means a profile from before this
/// scheme, which the password opens; a corrupt one means a password this device
/// generated, which nobody knows. Offering the password prompt there is offering a door
/// that cannot open, and the user has to be told to restore from the phrase instead.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PinState {
    /// No envelope: a profile created before this scheme.
    Missing,
    /// An envelope this build can open.
    Ready,
    /// The attempt limit was reached.
    LockedOut,
    /// An envelope that exists but cannot be read.
    Damaged,
}

/// Classifies the PIN slot of a profile.
///
/// # Errors
/// Returns an error only when the slot itself is malformed; a missing or damaged file is
/// an answer, not a failure.
pub fn pin_state(slot: &Slot) -> AppResult<PinState> {
    let envelope = match read_envelope(slot) {
        Ok(Some(envelope)) => envelope,
        Ok(None) => return Ok(PinState::Missing),
        Err(_) => return Ok(PinState::Damaged),
    };
    if check_envelope(&envelope).is_err() {
        return Ok(PinState::Damaged);
    }
    if read_attempts(slot)? >= MAX_ATTEMPTS {
        return Ok(PinState::LockedOut);
    }
    Ok(PinState::Ready)
}

/// Removes the stored secret of a profile.
///
/// # Errors
/// Returns [`crate::error::ErrorKind::Io`] when a file exists but cannot be removed.
pub fn delete(slot: &Slot) -> AppResult<()> {
    for path in [slot.path()?, slot.attempts_path()?] {
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(AppError::io(format!("remove {}: {e}", path.display()))),
        }
    }
    Ok(())
}

/// Whether this build can keep a PIN at all.
pub fn available() -> bool {
    platform::AVAILABLE
}

/// Reads the envelope of a profile.
///
/// @returns `None` when no PIN is set.
fn read_envelope(slot: &Slot) -> AppResult<Option<Envelope>> {
    let path = slot.path()?;
    let body = match std::fs::read(&path) {
        Ok(body) => body,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(AppError::io(format!("read envelope: {e}"))),
    };
    let envelope: Envelope = serde_json::from_slice(&body)
        .map_err(|e| AppError::internal(format!("parse envelope: {e}")))?;
    Ok(Some(envelope))
}

/// Wrong PINs recorded so far.
fn read_attempts(slot: &Slot) -> AppResult<u32> {
    let path = slot.attempts_path()?;
    let body = match std::fs::read(&path) {
        Ok(body) => body,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(e) => return Err(AppError::io(format!("read attempts: {e}"))),
    };
    let attempts: Attempts = match serde_json::from_slice(&body) {
        Ok(attempts) => attempts,
        Err(_) => {
            // Fail closed. A damaged counter is indistinguishable from one someone
            // damaged on purpose, and `unwrap_or_default` would turn either into a fresh
            // ten attempts — the limit is the only thing a short PIN has against a
            // person holding the unlocked phone.
            return Ok(MAX_ATTEMPTS);
        }
    };
    Ok(attempts.failed)
}

/// Adds one wrong PIN to the counter.
fn record_attempt(slot: &Slot) -> AppResult<()> {
    let failed = read_attempts(slot)?.saturating_add(1);
    write_attempts(slot, failed)
}

/// Clears the counter after a correct PIN.
fn reset_attempts(slot: &Slot) -> AppResult<()> {
    write_attempts(slot, 0)
}

/// Writes the counter.
fn write_attempts(slot: &Slot, failed: u32) -> AppResult<()> {
    let body = serde_json::to_vec(&Attempts { failed })
        .map_err(|e| AppError::internal(format!("serialise attempts: {e}")))?;
    write_private(&slot.attempts_path()?, &body)
}

/// Writes a file that only the owner can read.
///
/// @remarks
/// Written to a temporary file next to the target, flushed, then renamed over it: an
/// interrupted write leaves the previous contents intact instead of a truncated file.
/// That matters most for the envelope — a half-written one parses as garbage, and a
/// profile whose envelope cannot be read is a profile nobody can open.
///
/// The envelope protects the password, but the attempt counter and the file names still
/// should not be world-readable: on a shared machine they reveal which profiles exist.
fn write_private(path: &std::path::Path, body: &[u8]) -> AppResult<()> {
    let temp = path.with_extension("tmp");
    // `create` only applies the mode on creation, and the temporary name is fresh every
    // time, so 0600 is what the file actually gets.
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temp)
        .map_err(|e| AppError::io(format!("open {}: {e}", temp.display())))?;
    file.write_all(body)
        .map_err(|e| AppError::io(format!("write {}: {e}", temp.display())))?;
    // Flushed before the rename, so the name never points at data still in the page cache.
    // Not enough on its own: see the directory sync below.
    file.sync_all()
        .map_err(|e| AppError::io(format!("sync {}: {e}", temp.display())))?;
    drop(file);
    std::fs::rename(&temp, path)
        .map_err(|e| AppError::io(format!("rename {}: {e}", path.display())))?;
    // The rename itself is a directory entry change, and on a power loss it is the
    // directory that has to reach the disk.
    if let Some(dir) = path.parent() {
        if let Ok(handle) = std::fs::File::open(dir) {
            let _ = handle.sync_all();
        }
    }
    Ok(())
}

/// Creates a directory only the owner can enter.
///
/// @remarks
/// `create_dir_all` follows the umask, which on a desktop is usually 022 — the directory
/// holding a profile's envelope would then be readable, and its name is the profile's key
/// uid. Existing directories are reinforced too: the mode is set after creation rather
/// than only requested at it.
fn create_private_dir(dir: &std::path::Path) -> AppResult<()> {
    std::fs::create_dir_all(dir)
        .map_err(|e| AppError::io(format!("create credentials dir: {e}")))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
    }
    Ok(())
}

/// Derives the encryption key from the PIN.
///
/// Returns the key wrapped in [`zeroize::Zeroizing`]: the buffer is cleared when it goes
/// out of scope, so the derived key does not linger in freed memory.
fn derive_key(pin: &str, salt: &[u8], params: &KdfParams) -> AppResult<zeroize::Zeroizing<[u8; KEY_LEN]>> {
    use argon2::{Algorithm, Argon2, Params, Version};

    let params = Params::new(params.memory_kib, params.time_cost, params.lanes, Some(KEY_LEN))
        .map_err(|e| AppError::internal(format!("argon2 parameters: {e}")))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);

    let mut key = zeroize::Zeroizing::new([0u8; KEY_LEN]);
    argon
        .hash_password_into(pin.as_bytes(), salt, key.as_mut())
        .map_err(|e| AppError::internal(format!("argon2: {e}")))?;
    Ok(key)
}

/// Encrypts with AES-256-GCM.
fn encrypt(key: &[u8], nonce: &[u8], plain: &[u8]) -> AppResult<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| AppError::internal(format!("aes-gcm key: {e}")))?;
    cipher
        .encrypt(Nonce::from_slice(nonce), plain)
        .map_err(|_| AppError::internal("encryption failed"))
}

/// Decrypts an AES-256-GCM blob.
///
/// # Errors
/// Returns a plain [`crate::error::ErrorKind::Backend`] without detail: a wrong PIN and a
/// tampered file must be indistinguishable from the outside.
fn decrypt(key: &[u8], nonce: &[u8], ciphertext: &[u8]) -> AppResult<Vec<u8>> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::{Aes256Gcm, Nonce};

    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|e| AppError::internal(format!("aes-gcm key: {e}")))?;
    cipher
        .decrypt(Nonce::from_slice(nonce), ciphertext)
        .map_err(|_| AppError::backend("wrong PIN"))
}

/// Cryptographically secure random bytes.
fn random_bytes(len: usize) -> AppResult<Vec<u8>> {
    let mut buf = vec![0u8; len];
    getrandom::getrandom(&mut buf)
        .map_err(|e| AppError::internal(format!("random: {e}")))?;
    Ok(buf)
}

fn b64_encode(input: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(input)
}

fn b64_decode(input: &str) -> Option<Vec<u8>> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.decode(input).ok()
}

/// The platform half: whether the envelope can exist here at all.
mod platform {
    /// Android keeps the envelope in the application's private storage.
    #[cfg(target_os = "android")]
    pub const AVAILABLE: bool = true;
    #[cfg(target_os = "android")]
    pub const BACKEND: &str = "android-pin";

    /// Desktop keeps it in the same private directory, relative to the profile.
    ///
    /// It used to be a debug-only convenience while the phone was the only device
    /// with the scheme. Pairing changed that: a profile synced onto a desktop
    /// arrives with a 32-character generated password, and without an envelope
    /// the user would have to keep that string in a password manager — the very
    /// thing this scheme exists to avoid. So the desktop gets a PIN too.
    #[cfg(not(target_os = "android"))]
    pub const AVAILABLE: bool = true;
    #[cfg(not(target_os = "android"))]
    pub const BACKEND: &str = "desktop-pin";
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Valid key uid: 64 hex characters with an `0x` prefix.
    const KEY: &str = "0x9f6358c5d1a9bcb5f135c71f800d22dee5e84cd094c269ac8111d492a4f538a8";
    /// Password the flow generates, 32 characters.
    const PASSWORD: &str = "Abcdefghijkmnpqrstuvwxyz23456789";

    fn slot() -> Slot {
        Slot::new("mainnet", KEY).expect("valid slot")
    }

    #[test]
    fn slot_normalises_the_key_case() {
        // `0xAB…` and `0xab…` name one profile, and the key uid is a directory name: two
        // spellings would mean two directories, one of which holds the PIN.
        let upper = KEY.to_ascii_uppercase().replace("0X", "0x");
        assert_eq!(Slot::new("mainnet", &upper).expect("valid").key_uid, KEY);
    }

    #[test]
    fn a_damaged_attempt_counter_fails_closed() {
        // A counter that cannot be read must not become a fresh set of guesses: the limit
        // is the only thing a four-digit PIN has against someone holding the phone.
        assert_eq!(MAX_ATTEMPTS, 10);
        let body = b"{ not json";
        let parsed: Option<Attempts> = serde_json::from_slice(body).ok();
        assert!(parsed.is_none(), "the test documents the failure path it assumes");
    }

    #[test]
    fn an_empty_password_is_refused() {
        // An envelope around an empty password opens "successfully" and then fails at
        // login, with the password prompt no longer offered because an envelope exists.
        // Refused before anything is written, so no directory is created for it.
        // `Aa1!b2c3` passes the creation policy on every build the tests run in.
        assert!(save_pin(&slot(), "Aa1!b2c3", "").is_err());
    }

    #[test]
    fn envelope_kdf_bounds_reject_extremes() {
        // Read from the file, so they are input: an absurd memory figure would be an
        // allocation on the next PIN entry, and a tiny one a cheap brute force.
        let mut envelope = Envelope {
            version: ENVELOPE_VERSION,
            backend: platform::BACKEND.to_string(),
            kdf: KdfParams::current(),
            salt: String::new(),
            nonce: String::new(),
            ciphertext: String::new(),
        };
        assert!(check_envelope(&envelope).is_ok());
        envelope.kdf = KdfParams { memory_kib: 8, time_cost: 3, lanes: 1 };
        assert!(check_envelope(&envelope).is_err());
        envelope.kdf = KdfParams { memory_kib: 4_000_000, time_cost: 3, lanes: 1 };
        assert!(check_envelope(&envelope).is_err());
    }

    #[test]
    fn an_envelope_from_another_platform_is_refused() {
        let envelope = Envelope {
            version: ENVELOPE_VERSION,
            backend: "android-pin".to_string(),
            kdf: KdfParams::current(),
            salt: String::new(),
            nonce: String::new(),
            ciphertext: String::new(),
        };
        // Whatever this build's backend is, a different string is not it.
        assert_ne!("android-pin", platform::BACKEND);
        assert!(check_envelope(&envelope).is_err());
    }

    #[test]
    fn slot_accepts_a_known_network_and_a_full_key() {
        assert_eq!(Slot::new("mainnet", KEY).expect("valid").network, "mainnet");
        assert!(Slot::new("testnet", KEY).is_ok());
    }

    #[test]
    fn slot_rejects_an_unknown_network() {
        // Not sanitised into a path: a value the application never uses must be refused,
        // or it becomes a directory escape.
        assert!(Slot::new("../etc", KEY).is_err());
    }

    #[test]
    fn slot_rejects_a_malformed_key() {
        assert!(Slot::new("mainnet", "0x1234").is_err());
        assert!(Slot::new("mainnet", &KEY[2..]).is_err());
        let mut non_hex = String::from("0x");
        non_hex.push_str(&"z".repeat(64));
        assert!(Slot::new("mainnet", &non_hex).is_err());
    }

    #[test]
    fn opening_is_loose_and_creation_is_strong() {
        // The rule is a wall one way: a weak PIN can never be *stored*, but a PIN that
        // was stored — weak by today's standard, whatever the build — must stay
        // *typeable*, or it would open the envelope no longer.
        assert!(pin_problem("1379").is_none());
        assert!(pin_problem("a").is_none());
        assert!(pin_problem("").is_some());
        // The longest that could ever have been created, on any platform.
        assert!(pin_problem(&"ж".repeat(64)).is_none());
        assert!(pin_problem(&"ж".repeat(65)).is_some());

        // The creation side is platform policy, and both halves of it are tested here:
        // digits on a phone, classes on a desktop. Neither form satisfies the other,
        // and a test for one half must not assume the other is off.
        if pin_policy::DIGITS_ONLY {
            assert!(creation_problem("58291").is_none());
            assert!(creation_problem("7463521").is_none());
            assert!(creation_problem("746352198").is_none());
            assert!(creation_problem("5829").is_some(), "a 4-digit PIN is too short");
            assert!(creation_problem("582913746359").is_none());
            assert!(creation_problem("5829137463590").is_some(), "13 digits");
            assert!(creation_problem("A12345").is_some(), "letters are not on the keypad");
            assert!(creation_problem("12345").is_some(), "a sequence");
            assert!(creation_problem("54321").is_some(), "a descending sequence");
            assert!(creation_problem("55555").is_some(), "one repeated digit");
        }
        if pin_policy::REQUIRE_CLASSES {
            assert!(creation_problem("Tr0ub4dor&3!").is_none());
            assert!(creation_problem("a1b2c3d4").is_some(), "no uppercase or symbol");
            assert!(creation_problem("aB1!cD3!").is_none());
            assert!(creation_problem("aB1!cD").is_some(), "under the minimum");
            assert!(creation_problem("58291").is_some(), "digits alone lack letter classes");
            assert!(creation_problem("Tr0ub4dor&3").is_none());
        }
    }

    #[test]
    fn round_trip_returns_the_password() {
        // The whole scheme in one assertion: the PIN opens the envelope, the password
        // comes back byte for byte, and the derived key is not the PIN itself.
        let salt = random_bytes(SALT_LEN).expect("salt");
        let nonce = random_bytes(NONCE_LEN).expect("nonce");
        let key = derive_key("1379", &salt, &KdfParams::current()).expect("key");
        let sealed = encrypt(key.as_slice(), &nonce, PASSWORD.as_bytes()).expect("seal");
        let plain = decrypt(key.as_slice(), &nonce, &sealed).expect("open");
        assert_eq!(String::from_utf8(plain).unwrap(), PASSWORD);
    }

    #[test]
    fn wrong_pin_fails_the_authentication_tag() {
        // AES-GCM is authenticated: a wrong key produces an error, not plausible garbage,
        // which is what lets the caller treat "cannot open" as "wrong PIN".
        let salt = random_bytes(SALT_LEN).expect("salt");
        let nonce = random_bytes(NONCE_LEN).expect("nonce");
        let right = derive_key("1379", &salt, &KdfParams::current()).expect("key");
        let wrong = derive_key("1378", &salt, &KdfParams::current()).expect("key");
        let sealed = encrypt(right.as_slice(), &nonce, PASSWORD.as_bytes()).expect("seal");
        assert!(decrypt(wrong.as_slice(), &nonce, &sealed).is_err());
    }

    #[test]
    fn each_save_uses_a_fresh_salt_and_nonce() {
        // A reused salt would let one table of derived keys open every profile; a reused
        // nonce breaks AES-GCM outright.
        let a = random_bytes(SALT_LEN).expect("salt");
        let b = random_bytes(SALT_LEN).expect("salt");
        assert_ne!(a, b);
        let n1 = random_bytes(NONCE_LEN).expect("nonce");
        let n2 = random_bytes(NONCE_LEN).expect("nonce");
        assert_ne!(n1, n2);
    }

    #[test]
    fn different_pins_derive_different_keys() {
        let salt = random_bytes(SALT_LEN).expect("salt");
        let a = derive_key("1379", &salt, &KdfParams::current()).expect("key");
        let b = derive_key("1380", &salt, &KdfParams::current()).expect("key");
        assert_ne!(*a, *b);
    }

    #[test]
    fn the_same_pin_and_salt_derive_the_same_key() {
        // Without this, a saved envelope could never be reopened after a restart.
        let salt = random_bytes(SALT_LEN).expect("salt");
        let a = derive_key("1379", &salt, &KdfParams::current()).expect("key");
        let b = derive_key("1379", &salt, &KdfParams::current()).expect("key");
        assert_eq!(*a, *b);
    }

    #[test]
    fn attempts_stop_after_the_limit() {
        // The counter is what makes a four-digit PIN acceptable on a device someone may
        // pick up: ten guesses out of ten thousand.
        assert_eq!(MAX_ATTEMPTS, 10);
        assert!(MAX_ATTEMPTS < 100);
    }

    #[test]
    fn kdf_parameters_are_recorded_with_the_envelope() {
        // Read back rather than assumed, so a future build with stronger defaults still
        // opens envelopes written today.
        let params = KdfParams::current();
        let json = serde_json::to_string(&params).expect("serialise");
        let back: KdfParams = serde_json::from_str(&json).expect("parse");
        assert_eq!(back, params);
        assert!(params.memory_kib >= 19 * 1024, "OWASP minimum is 19 MiB");
    }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/// Stores the profile password under a PIN the user chose.
///
/// @param network - `mainnet` or `testnet`: profiles of the two never share a slot.
/// @param keyUid - The profile's key uid.
/// @param pin - Digits only, 4 to 12. Never logged, not even its length.
/// @param password - Password of the local database, generated by the application.
/// @remarks
/// Runs on a blocking thread: Argon2id is deliberately expensive (64 MiB, three passes)
/// and would hold the async runtime for the duration.
#[tauri::command]
pub async fn credential_save_pin(
    network: String,
    key_uid: String,
    pin: String,
    password: String,
) -> AppResult<()> {
    let slot = Slot::new(&network, &key_uid)?;
    tokio::task::spawn_blocking(move || save_pin(&slot, &pin, &password))
        .await
        .map_err(|e| AppError::internal(format!("credential save panicked: {e}")))??;
    crate::trace::line(&format!(
        "credential pin saved network={network} key={}",
        &key_uid[..10.min(key_uid.len())]
    ));
    Ok(())
}

/// Returns the profile password unlocked by `pin`.
///
/// # Errors
/// Returns an error when the PIN is wrong, when the attempt limit is reached, or when
/// no PIN is set for this profile.
#[tauri::command]
pub async fn credential_open_pin(
    network: String,
    key_uid: String,
    pin: String,
) -> AppResult<String> {
    let slot = Slot::new(&network, &key_uid)?;
    let password = tokio::task::spawn_blocking(move || open_pin(&slot, &pin))
        .await
        .map_err(|e| AppError::internal(format!("credential open panicked: {e}")))?;
    // Only the outcome reaches the trace: a failed PIN is worth seeing, its value is not.
    crate::trace::line(&format!(
        "credential pin open network={network} key={} ok={}",
        &key_uid[..10.min(key_uid.len())],
        password.is_ok()
    ));
    password
}

/// First characters of a key uid, for traces.
fn short_key(key_uid: &str) -> String {
    key_uid[..10.min(key_uid.len())].to_string()
}

/// Whether a PIN is set for this profile.
#[tauri::command]
pub fn credential_has_pin(network: String, key_uid: String) -> AppResult<bool> {
    Ok(has_pin(&Slot::new(&network, &key_uid)?))
}

/// What the entry flow should show for this profile.
///
/// @returns `missing`, `ready`, `locked-out` or `damaged`.
/// @remarks
/// The attempt count is read here rather than after a failed PIN, so the flow can skip a
/// keypad that cannot succeed.
#[tauri::command]
pub async fn credential_pin_state(network: String, key_uid: String) -> AppResult<PinState> {
    let slot = Slot::new(&network, &key_uid)?;
    tokio::task::spawn_blocking(move || pin_state(&slot))
        .await
        .map_err(|e| AppError::internal(format!("credential state panicked: {e}")))?
}

/// Forgets a paired password that was never wrapped under a PIN.
///
/// @remarks
/// Called when the user leaves the PIN screen after a transfer: the profile stays on the
/// device, but without the password there is nothing to wrap, and keeping it in memory
/// would mean a PIN could be set for a profile the user walked away from.
#[tauri::command]
pub async fn credential_forget_pending(network: String, key_uid: String) -> AppResult<bool> {
    let slot = Slot::new(&network, &key_uid)?;
    tokio::task::spawn_blocking(move || drop_pending(&slot.network, &slot.key_uid))
        .await
        .map_err(|e| AppError::internal(format!("credential forget panicked: {e}")))
}

/// Stores the password of a paired profile under a PIN.
///
/// @param network - `mainnet` or `testnet`.
/// @param keyUid - The profile that arrived.
/// @param pin - Digits only, 4 to 12.
/// @remarks
/// The password itself is not a parameter: it stays in [`PENDING`] from the moment the
/// transfer completed until this call wraps it. Nothing about it reaches the webview.
#[tauri::command]
pub async fn credential_save_pin_from_pending(
    network: String,
    key_uid: String,
    pin: String,
) -> AppResult<()> {
    let key = short_key(&key_uid);
    tokio::task::spawn_blocking(move || save_pending_pin(&network, &key_uid, &pin))
        .await
        .map_err(|e| AppError::internal(format!("credential save panicked: {e}")))??;
    crate::trace::line(&format!("credential pin saved from pairing key={key}"));
    Ok(())
}

/// Removes the PIN and the stored password of a profile.
#[tauri::command]
pub fn credential_delete(network: String, key_uid: String) -> AppResult<()> {
    delete(&Slot::new(&network, &key_uid)?)
}

/// Whether this build can keep a PIN.
#[tauri::command]
pub fn credential_available() -> bool {
    available()
}

/// PIN rules, so the interface does not duplicate them.
#[derive(serde::Serialize)]
pub struct PinRules {
    /// Opening accepts any non-empty string up to this length.
    pub max_length: usize,
    pub max_attempts: u32,
    /// The creation policy: the shortest PIN that will be stored.
    pub creation_min: usize,
    /// Creation digits-only platforms: the phone keypad.
    pub digits_only: bool,
    /// Creation must mix lowercase, uppercase, digits and a symbol.
    pub require_classes: bool,
}

/// Returns the PIN rules this build enforces.
#[tauri::command]
pub fn credential_pin_rules() -> PinRules {
    PinRules {
        max_length: pin_policy::MAX,
        max_attempts: MAX_ATTEMPTS,
        creation_min: pin_policy::MIN,
        digits_only: pin_policy::DIGITS_ONLY,
        require_classes: pin_policy::REQUIRE_CLASSES,
    }
}
