//! Removed: the Android Keystore bridge.
//!
//! This module held the JNI glue for sealing the profile password under a key in the
//! Android Keystore, unlocked by the phone's screen lock on every start. The scheme was
//! replaced: the user now picks their own PIN, which derives the encryption key, so no
//! system prompt appears and nothing has to leave the PIN's control.
//!
//! The file is kept empty rather than deleted because the working tree is what the
//! repository is built from, and a stale module in `lib.rs` would fail the build. It is
//! not referenced by `lib.rs` and is not compiled.
