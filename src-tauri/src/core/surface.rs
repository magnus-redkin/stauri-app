//! The contract of the safety core, pinned by tests.
//!
//! @remarks
//! Rust has no per-folder visibility: nothing stops `core/` from importing the rest of the
//! crate, and nothing stops a new file from being dropped into the folder by accident.
//! These tests turn "the boundary is a decision" into a build failure:
//!
//! * the file list is pinned, so a new module has to be added here on purpose — and this
//!   file is covered by the same CODEOWNERS rule, which puts it in front of a reviewer;
//! * each command of the contract is named by its full path, so a module that quietly
//!   moves back out of `core/` makes this file fail to compile;
//! * the number of entry points is pinned, so widening the surface is visible in review.

#[cfg(test)]
use std::path::Path;

#[cfg(test)]
use crate::core::{credentials, lanpair, pairing, seed};

/// Files that make up the core. Adding, removing or renaming one is a review decision.
#[cfg(test)]
const CORE_FILES: [&str; 9] = [
    "backend.rs",
    "credentials.rs",
    "error.rs",
    "inprocess.rs",
    "lanpair.rs",
    "pairing.rs",
    "rpc_proxy.rs",
    "seed.rs",
    "trace.rs",
];

#[test]
fn the_set_of_core_files_is_unchanged() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/core");
    let mut found: Vec<String> = std::fs::read_dir(&dir)
        .expect("core directory must exist")
        .filter_map(Result::ok)
        .map(|entry| entry.file_name().to_string_lossy().into_owned())
        .filter(|name| name.ends_with(".rs"))
        .filter(|name| name != "mod.rs" && name != "surface.rs")
        .collect();
    found.sort();

    let mut expected: Vec<String> = CORE_FILES.iter().map(|s| s.to_string()).collect();
    expected.sort();

    assert_eq!(
        found, expected,
        "the safety core changed: add the file here on purpose, and expect a review"
    );
}

/// The contract's entry points, each cast by its full path. This is a compile-time check
/// disguised as a test: the moment any of these stops living under `core::`, the item no
/// longer resolves and this function fails to build. The pointer values are meaningless —
/// only the paths are being pinned.
#[cfg(test)]
fn core_commands() -> [*const (); 27] {
    [
        seed::fetch_seed_phrase as *const (),
        seed::seed_word as *const (),
        seed::seed_challenge as *const (),
        seed::verify_seed_answer as *const (),
        seed::clear_seed as *const (),
        credentials::credential_save_pin as *const (),
        credentials::credential_open_pin as *const (),
        credentials::credential_has_pin as *const (),
        credentials::credential_pin_state as *const (),
        credentials::credential_save_pin_from_pending as *const (),
        credentials::credential_forget_pending as *const (),
        credentials::credential_delete as *const (),
        credentials::credential_available as *const (),
        credentials::credential_pin_rules as *const (),
        pairing::pairing_available as *const (),
        pairing::pairing_validate as *const (),
        pairing::pairing_confirmation_code as *const (),
        pairing::pairing_start_sending as *const (),
        pairing::pairing_start_receiving as *const (),
        pairing::pairing_receive as *const (),
        pairing::pairing_send as *const (),
        lanpair::pairing_lan_receive_start as *const (),
        lanpair::pairing_lan_send_start as *const (),
        lanpair::pairing_lan_confirm as *const (),
        lanpair::pairing_lan_cancel as *const (),
        lanpair::pairing_lan_status as *const (),
        lanpair::pairing_lan_local_address as *const (),
    ]
}

#[test]
fn the_size_of_the_contract_is_unchanged() {
    // Widening the surface is allowed, but it has to be visible: add the command to
    // `lib.rs`, to `core_commands`, and bump the array length, so the diff says
    // "core exposes more".
    assert_eq!(
        core_commands().len(),
        27,
        "the core command surface changed; update the array length deliberately"
    );
}
