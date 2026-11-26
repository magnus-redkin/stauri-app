//! Build script: runs Tauri's build step and, on desktop, places the status-go
//! libraries next to the executable.
//!
//! `inprocess::library_path` looks for `libstatus` in the executable's own
//! directory, so `cargo run` and `tauri dev` (which use `target/debug`) need the
//! file there. Release bundles get it from `tauri.conf.json` resources and
//! `release.sh`; copying here keeps the two profiles behaving the same.

use std::path::{Path, PathBuf};

/// Libraries copied next to the executable on desktop.
///
/// The names differ per platform: `.dll` on Windows, `.so` everywhere else we build
/// for. `inprocess::library_path` resolves the same names at runtime, and the
/// bundled resources (`tauri.conf.json`, `tauri.windows.conf.json`) carry them into
/// the installer, so all three places must agree.
const LIBRARIES_UNIX: &[&str] = &["libstatus.so", "libsds.so"];
const LIBRARIES_WINDOWS: &[&str] = &["libstatus.dll", "libsds.dll"];

fn libraries_for(target: &str) -> &'static [&'static str] {
    if target.contains("windows") {
        LIBRARIES_WINDOWS
    } else {
        LIBRARIES_UNIX
    }
}

fn main() {
    tauri_build::build();

    let target = std::env::var("TARGET").unwrap_or_default();
    // Android loads `libstatus.so` from `jniLibs`, not from the executable directory.
    if target.contains("android") {
        return;
    }

    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    // OUT_DIR is `<target>/<profile>/build/<pkg>-<hash>/out`; the fourth ancestor
    // is the profile directory that holds the executable.
    let Some(profile_dir) = out_dir.ancestors().nth(3) else {
        println!("cargo:warning=cannot locate the profile directory from OUT_DIR");
        return;
    };

    for name in libraries_for(&target) {
        let src = manifest_dir.join("binaries").join(name);
        println!("cargo:rerun-if-changed={}", src.display());
        copy_if_present(&src, &profile_dir.join(name));
    }
}

/// Copies `src` to `dst` when `src` exists; a missing library is a warning, not a
/// build failure, so the build still works before status-go has been compiled.
fn copy_if_present(src: &Path, dst: &Path) {
    if !src.exists() {
        println!(
            "cargo:warning={} is missing; the app will fail to start the backend until it is built",
            src.display()
        );
        return;
    }
    if let Err(e) = std::fs::copy(src, dst) {
        println!(
            "cargo:warning=cannot copy {} to {}: {e}",
            src.display(),
            dst.display()
        );
    }
}
