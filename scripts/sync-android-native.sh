#!/usr/bin/env bash
# sync-android-native.sh — put the tracked Android sources into the generated project.
#
# Why this exists
# ---------------
# `src-tauri/gen/` is in .gitignore: Tauri recreates that tree with
# `tauri android init`, and anything hand-written there is lost on the next machine
# and never reaches the repository. The Android-only parts of the credential store
# (`CredentialVault.kt`, `RustBridge.kt`, `MainActivity.kt`, the manifest additions
# and the network security config) are source, not generated output, so they live in
# `src-tauri/android/` and are copied from there.
#
# The copy is idempotent: run it after `tauri android init` (or any time the
# generated tree was recreated), before building.
#
# Usage:
#   ./scripts/sync-android-native.sh
#
# Exit codes: 0 on success or when no Android project exists (desktop-only checkout),
# 1 when the generated project is present but incomplete.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="$ROOT/src-tauri/android"
GEN_ROOT="$ROOT/src-tauri/gen/android"
GEN="$GEN_ROOT/app/src/main"

# A desktop build has no Android project, and this hook runs for every build. Silence
# is right here: nothing is wrong, there is simply nothing to sync.
if [[ ! -d "$GEN_ROOT" ]]; then
  exit 0
fi

if [[ ! -d "$GEN" ]]; then
  echo "ERROR: нет $GEN — выполните 'npx tauri android init'." >&2
  exit 1
fi

# Kotlin sources. The package directory is fixed by the application id in
# tauri.conf.json; a new id means a new directory here.
KOTLIN_DIR="$GEN/java/com/magnus/stauri_app"
mkdir -p "$KOTLIN_DIR"
# One file: the activity. The Keystore bridge that used to live here is gone with the
# system-PIN scheme, see src-tauri/src/credentials.rs.
cp "$SRC"/kotlin/MainActivity.kt "$KOTLIN_DIR/"

# Resources: strings used by the unlock prompt, and the network policy the local
# pairing transport needs.
mkdir -p "$GEN/res/xml" "$GEN/res/values"
cp "$SRC"/res/xml/*.xml "$GEN/res/xml/"
cp "$SRC"/res/values/*.xml "$GEN/res/values/"

# Manifest: the generated one is kept, but two attributes are required and cannot be
# expressed anywhere else. Applied with sed so the rest of the file stays as Tauri
# wrote it; re-running is safe because the pattern is only inserted when absent.
MANIFEST="$GEN/AndroidManifest.xml"
if ! grep -q 'android:allowBackup=' "$MANIFEST"; then
  # Backups carry the databases but never the keystore key, so a restored profile
  # would be unopenable. See CredentialVault for the whole scheme.
  perl -0pi -e 's/(<application\n)(\s+)/$1$2android:allowBackup="false"\n$2android:networkSecurityConfig"\@xml\/network_security_config"\n$2/' "$MANIFEST"
fi

echo "Android native sources synced into $GEN"
