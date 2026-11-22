//! The safety core: everything that holds, protects or moves keys.
//!
//! # Why this folder exists
//!
//! Everything outside `core/` is business logic — chats, wallet screens, feeds, dApp
//! windows — and may one day be written in another language, as long as it talks to this
//! core. What lives *here* is not negotiable: it is the code that owns the PIN envelope,
//! keeps the seed phrase out of the webview, drives status-go through FFI, and carries a
//! profile from one device to another. A mistake in any of these files is a key
//! disclosure, and no amount of cleanup elsewhere makes up for it.
//!
//! # What is not protection
//!
//! The folder is a marker, not a lock: Rust has no per-folder visibility, and nothing
//! stops code in `core/` from importing the rest of the crate. What actually protects the
//! boundary is process, not the compiler:
//!
//! * `.github/CODEOWNERS` makes every change here require an explicit review;
//! * `src/core/surface.rs` is an API test that pins the public surface, so a change to
//!   the contract fails the build instead of slipping through;
//! * this list, which says what belongs here — adding a file is a decision, not a
//!   convenience.
//!
//! # The modules
//!
//! | Module | Owns |
//! |---|---|
//! | [`credentials`] | PIN → Argon2id → AES-GCM envelope; attempt counter |
//! | [`seed`] | the seed phrase, held outside the webview |
//! | [`inprocess`] | status-go as a library in this process; all RPC traffic |
//! | [`backend`] | the single named entry point to status-go |
//! | [`rpc_proxy`] | the secret HTTP forwarder status-go talks through |
//! | [`pairing`] | copying a profile to another device over the LAN |
//! | [`lanpair`] | discovery and the six-digit handshake that start a transfer |
//! | [`error`] | typed command errors; the vocabulary everything returns |
//! | [`trace`] | the in-app trace log with secret scrubbing |
//!
//! # What deliberately does not live here
//!
//! `transfer`, `ens`, `swap`, `router`, `providers`, `market`, `dapp`, `updater`,
//! `opener`, `invite`, `config`, `profile`, `commands` — these *use* the core and are
//! the parts most likely to be rewritten, split off or replaced. Putting them here would
//! freeze business logic that was never meant to be frozen.

pub mod backend;
pub mod credentials;
pub mod error;
pub mod inprocess;
pub mod lanpair;
pub mod pairing;
pub mod rpc_proxy;
pub mod seed;
pub mod surface;
pub mod trace;
