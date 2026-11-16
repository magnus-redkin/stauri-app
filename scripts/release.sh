#!/usr/bin/env bash
# release.sh — builds the Stauri AppImage natively (Ubuntu 24.04+).
#
# Usage (from stauri-app/):
#   ./scripts/release.sh 0.2.0
#
# Expects src-tauri/binaries/libstatus.so and src-tauri/binaries/libsds.so to be
# built in Nix already (see docs/BUILDING.md). status-go runs inside the app as a
# library; there is no status-backend process any more.
# The script only builds the frontend, the Rust binary, the AppDir and the
# AppImage.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-+].*)?$ ]]; then
  echo "ERROR: version must be semver (e.g. 0.2.0)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Android-only mode: build and sign the APK, then exit before the AppImage.
# release-android.sh uses it and passes the version as the first argument.
if [[ "${RELEASE_ONLY_ANDROID:-0}" == "1" ]]; then
  VERSION="${1:?usage: RELEASE_ONLY_ANDROID=1 release.sh <version>}"
  echo "=== Android APK только: $VERSION ==="
  source "$ROOT/scripts/lib/android-apk.sh"
  exit 0
fi

# ---------- Integrity of downloaded tools ----------
#
# linuxdeploy and its AppImage plugin are downloaded from GitHub and executed.
# A hijacked CDN, a compromised account or a swapped release would mean arbitrary
# code running on the build machine.
#
# Both are therefore pinned to a tag (not the floating `continuous` release) and
# verified by sha256, including files already on disk, which may have been
# modified since they were downloaded.
#
# To get the plugin hash when bumping the version:
#   wget -q "$PLUGIN_URL" -O /tmp/p.AppImage && sha256sum /tmp/p.AppImage

LINUXDEPLOY_URL="https://github.com/tauri-apps/binary-releases/releases/download/linuxdeploy-07333c6/linuxdeploy-x86_64.AppImage"
LINUXDEPLOY_SHA256="36a2d7e274d12e1050d0e9ecfe11d339ed54720b2bec464c286d53f8b07f5c62"

PLUGIN_URL="https://github.com/linuxdeploy/linuxdeploy-plugin-appimage/releases/download/1-alpha-20250213-1/linuxdeploy-plugin-appimage-x86_64.AppImage"
PLUGIN_SHA256="992d502a248e14ab185448ddf6f6e7d25558cb84d4623c354c3af350c25fccb3"

# fetch_verified — downloads a tool if absent and always verifies its sha256.
fetch_verified() {
  local url="$1" dest="$2" expected="$3"

  if [[ ! -f "$dest" ]]; then
    echo "  downloading $(basename "$dest")"
    wget -q "$url" -O "$dest" || {
      echo "ERROR: download failed: $url" >&2
      exit 1
    }
  fi

  local actual
  actual=$(sha256sum "$dest" | awk '{print $1}')
  if [[ "$actual" != "$expected" ]]; then
    echo "ERROR: checksum mismatch for $(basename "$dest")" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    echo "  If the release was updated intentionally, update the checksum in" >&2
    echo "  this script after verifying the new artifact." >&2
    exit 1
  fi
}

echo "=== Stauri release $VERSION ==="
echo "Root: $ROOT"

# ---------- 1. Dependency checks ----------
echo
echo "[1/8] Checking dependencies"

for cmd in pnpm patchelf wget node git; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "ERROR: $cmd not found." >&2
    exit 1
  fi
done

# Optional validators: their absence does not stop the release, but the skipped
# check is reported. On CI they come from the appstream and desktop-file-utils
# packages.
MISSING_TOOLS=()
command -v appstreamcli         >/dev/null 2>&1 || MISSING_TOOLS+=(appstreamcli)
command -v desktop-file-validate >/dev/null 2>&1 || MISSING_TOOLS+=(desktop-file-validate)
command -v sha256sum            >/dev/null 2>&1 || MISSING_TOOLS+=(sha256sum)
if [[ ${#MISSING_TOOLS[@]} -gt 0 ]]; then
  echo "  WARNING: missing tools, checks will be skipped: ${MISSING_TOOLS[*]}" >&2
fi

# Signing and updates are mandatory: a missing key or password is an error, not a
# warning.
#
# Without them the AppImage looks finished, but its `check_for_update` returns
# "no updates" forever, stranding users on a version they cannot update from. An
# unsigned artifact must not be distributed, and failing before the three-minute
# build beats failing after it.
SIGN_KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-}"
if [[ -z "$SIGN_KEY" && -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
  SIGN_KEY="<TAURI_SIGNING_PRIVATE_KEY>"
fi
if [[ -z "$SIGN_KEY" ]]; then
  echo "ERROR: TAURI_SIGNING_PRIVATE_KEY_PATH не задан — без ключа нет ни подписи," >&2
  echo "       ни обновлений. Такой AppImage публиковать нельзя." >&2
  echo "       export TAURI_SIGNING_PRIVATE_KEY_PATH=~/.tauri/stauri.key" >&2
  exit 1
fi
if [[ "$SIGN_KEY" != "<TAURI_SIGNING_PRIVATE_KEY>" && ! -f "$SIGN_KEY" ]]; then
  echo "ERROR: ключ подписи не найден: $SIGN_KEY" >&2
  exit 1
fi
echo "  signing key: ${SIGN_KEY}"

# The password is mandatory too. Its presence does not prove it is correct —
# signing will reveal that — but its absence guarantees failure, and finding out
# now is cheaper than after the build. It is read from the system keyring
# (secret-tool) when unset, so it never appears in project files or output;
# otherwise it is prompted for with echo disabled.
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]] && command -v secret-tool >/dev/null 2>&1; then
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD="$(secret-tool lookup service stauri-app key tauri-signing-password 2>/dev/null || true)"
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" && -t 0 ]]; then
  read -rsp "Пароль ключа подписи: " TAURI_SIGNING_PRIVATE_KEY_PASSWORD
  echo
  export TAURI_SIGNING_PRIVATE_KEY_PASSWORD
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" ]]; then
  echo "ERROR: пароль ключа подписи не найден (переменная, keyring или ввод)." >&2
  exit 1
fi
echo "  signing password: set"

# The public key must already be in the config: it is inlined into the binary at
# compile time and cannot be added afterwards. An empty key means a build with
# no updates, so this is checked before compiling rather than after.
CONFIG_PUBKEY="$(python3 -c "
import json
print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey'].strip())
")"
if [[ -z "$CONFIG_PUBKEY" ]]; then
  echo "ERROR: plugins.updater.pubkey пуст в tauri.conf.json." >&2
  echo "       Впишите публичную часть ключа (> $SIGN_KEY.pub):" >&2
  echo "       без неё updater не сможет проверить подпись обновления." >&2
  exit 1
fi
echo "  updater pubkey: ${#CONFIG_PUBKEY} chars"

if [[ ! -f "$ROOT/src-tauri/binaries/libsds.so" ]]; then
  echo "ERROR: src-tauri/binaries/libsds.so not found." >&2
  echo "       Соберите status-backend и libsds.so в Nix (см. docs/BUILDING.md)." >&2
  exit 1
fi
if [[ ! -f "$ROOT/src-tauri/binaries/libstatus.so" ]]; then
  echo "ERROR: src-tauri/binaries/libstatus.so not found." >&2
  echo "       Соберите libstatus.so в Nix (см. docs/BUILDING.md)." >&2
  exit 1
fi

echo "  pnpm:     $(pnpm --version)"
echo "  patchelf: $(patchelf --version)"
echo "  libsds:   OK"
echo "  backend:  OK"

# COINGECKO_KEY is optional: the public endpoint serves data without a key,
# which only raises rate limits. If present in $ROOT/.env it is picked up at the
# Vite build stage and ends up in the bundle; .env itself is not placed in the
# AppImage, because the artifact is distributed and its secrets would reach
# every downloader.
echo "  COINGECKO_KEY: $(grep -q '^COINGECKO_KEY=' "$ROOT/.env" 2>/dev/null && echo 'present (optional)' || echo 'absent (optional, keyless mode)')"

# ---------- 2. Version bump ----------
echo
echo "[2/8] Bumping version to $VERSION"

node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('$ROOT/package.json', 'utf8'));
p.version = '$VERSION';
fs.writeFileSync('$ROOT/package.json', JSON.stringify(p, null, 2) + '\n');
"
node -e "
const fs = require('fs');
const p = JSON.parse(fs.readFileSync('$ROOT/src-tauri/tauri.conf.json', 'utf8'));
p.version = '$VERSION';
fs.writeFileSync('$ROOT/src-tauri/tauri.conf.json', JSON.stringify(p, null, 2) + '\n');
"

# Cargo.toml: only the version in the [package] section matters. Leaving it out
# makes cargo and Tauri disagree — the build uses one version while the package
# metadata carries another.
python3 - "$ROOT/src-tauri/Cargo.toml" "$VERSION" <<'PY'
import re, sys
path, version = sys.argv[1], sys.argv[2]
text = open(path, encoding='utf-8').read()
new, count = re.subn(
    r'(?m)^version\s*=\s*"[^"]*"',
    f'version = "{version}"',
    text,
    count=1,
)
if count != 1:
    sys.exit(f"ERROR: could not bump version in {path}")
open(path, 'w', encoding='utf-8').write(new)
PY

# AppStream: the newest <release> must match the built version, or software
# centers display the wrong one.
python3 - "$ROOT/src-tauri/metainfo/com.magnus.stauri-app.appdata.xml" "$VERSION" "$(date +%Y-%m-%d)" <<'PY'
import re, sys
path, version, today = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(path, encoding='utf-8').read()
pattern = re.compile(r'<release version="[^"]*" date="[^"]*">')
new, count = pattern.subn(f'<release version="{version}" date="{today}">', text, count=1)
if count != 1:
    sys.exit(f"ERROR: could not bump release in {path}")
open(path, 'w', encoding='utf-8').write(new)
PY

echo "  package.json     -> $VERSION"
echo "  tauri.conf.json  -> $VERSION"
echo "  Cargo.toml       -> $VERSION"
echo "  appdata.xml      -> $VERSION"

# ---------- 2a. Pre-build checks ----------
echo
echo "[2a/8] Pre-build checks"

# AppStream and .desktop files can be validated before the build: they are static.
METAINFO="$ROOT/src-tauri/metainfo/com.magnus.stauri-app.appdata.xml"
if [[ -f "$METAINFO" && -n "$(command -v appstreamcli || true)" ]]; then
  appstreamcli validate --no-net "$METAINFO" 2>&1 | sed 's/^/  /'
  # appstreamcli returns 0 for info notices and non-zero only for errors.
  if ! appstreamcli validate --no-net "$METAINFO" >/dev/null 2>&1; then
    echo "ERROR: metainfo не прошёл валидацию" >&2
    exit 1
  fi
  echo "  ✓ metainfo valid"
else
  echo "  WARNING: metainfo или appstreamcli отсутствуют — проверка пропущена" >&2
fi

# Git state. The tag is created only after a successful build, so a dirty tree
# is a warning here: tagging it would lose the exact build point.
if git rev-parse --git-dir >/dev/null 2>&1; then
  if [[ -n "$(git status --porcelain)" ]]; then
    echo "  WARNING: рабочее дерево содержит незакоммиченные изменения." >&2
    echo "           Тег v$VERSION будет указывать на HEAD, а не на эти файлы." >&2
  fi
  if [[ "${RELEASE_NO_TAG:-0}" != "1" ]] && git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    echo "ERROR: тег v$VERSION уже существует." >&2
    echo "       Версия должна монотонно расти: старый тег уже указывает на другой коммит." >&2
    exit 1
  fi
  echo "  git: HEAD $(git rev-parse --short HEAD)"
else
  echo "  WARNING: не git-репозиторий — тег не будет поставлен" >&2
fi

# ---------- 3. Frontend ----------
echo
echo "[3/8] Building frontend"
pnpm install --frozen-lockfile
pnpm build

# ---------- 4. Rust binary (no bundle) ----------
echo
echo "[4/8] Building Rust binary"

# `--no-bundle` is not passed: tauri.conf.json sets "targets": [], so a plain
# `tauri build` already builds neither deb nor AppImage.
#
# The empty list is the single source of truth — packaging belongs to this
# script (step 5). A non-empty target list would make the config promise one
# thing while the script did another, and a bare `tauri build` would surprise
# the developer with a .deb.
export NO_STRIP=1
pnpm tauri build

TAURI_BIN="$ROOT/src-tauri/target/release/tauri-app"
STATUS_LIB="$ROOT/src-tauri/binaries/libstatus.so"
LIBSDS="$ROOT/src-tauri/binaries/libsds.so"

for f in "$TAURI_BIN" "$STATUS_LIB" "$LIBSDS"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: $f not found" >&2
    exit 1
  fi
done

echo "  tauri-app:  OK"
echo "  libstatus:  OK"
echo "  libsds.so:  OK"

# ---------- 5. Manual AppDir ----------
echo
echo "[5/8] Creating AppDir manually"

APPDIR="$ROOT/src-tauri/target/release/bundle/appimage/stauri-app.AppDir"
rm -rf "$APPDIR"
# Remove the AppImage from a previous build: otherwise, if linuxdeploy fails,
# the step-7 check finds the old file and reports success, shipping the previous
# version under the same name.
rm -f "$ROOT/src-tauri/target/release/bundle/appimage/"*.AppImage
mkdir -p "$APPDIR/usr/bin"
mkdir -p "$APPDIR/usr/lib"
mkdir -p "$APPDIR/usr/share/applications"
mkdir -p "$APPDIR/usr/share/icons/hicolor/128x128/apps"

# Binaries
cp "$TAURI_BIN"   "$APPDIR/usr/bin/stauri-app"
# libstatus is loaded by name from the executable's directory (`library_path`
# in inprocess.rs), and libsds sits in usr/lib, reached through its RUNPATH.
cp "$STATUS_LIB"  "$APPDIR/usr/bin/libstatus.so"
cp "$LIBSDS"      "$APPDIR/usr/lib/libsds.so"

# ---------- Stripping Nix dependencies ----------
#
# libstatus.so and libsds.so are built in Nix, so they carry:
#   * an INTERP pointing at /nix/store/.../ld-linux-x86-64.so.2 — on a machine
#     without that store, execve returns ENOENT and the AppImage does not start
#     at all;
#   * a RUNPATH containing /nix/store/...glibc... — startup loads the Nix loader
#     (2.40), but the system libc.so.6 comes earlier on the LD_LIBRARY_PATH
#     inherited from the shell, putting two incompatible glibcs in one process
#     and causing SIGSEGV in the libsds.so constructors.
#
# Hence the system loader plus a clean $ORIGIN-relative RUNPATH.
SYSTEM_LOADER="/lib64/ld-linux-x86-64.so.2"
if [[ ! -e "$SYSTEM_LOADER" ]]; then
  echo "ERROR: $SYSTEM_LOADER not found" >&2
  exit 1
fi

echo "  RUNPATH before: $(patchelf --print-rpath "$APPDIR/usr/bin/libstatus.so" 2>/dev/null || true)"

# libstatus.so: libsds.so lives in usr/lib, the library in usr/bin. There is no
# INTERP to rewrite — a shared library is mapped by libsds' own loader, which is
# the system one.
patchelf --set-rpath '$ORIGIN/../lib' "$APPDIR/usr/bin/libstatus.so"

# libsds.so: all its NEEDED entries are system libraries, but the Nix glibc has
# to come out of the RUNPATH.
patchelf --set-rpath '$ORIGIN'        "$APPDIR/usr/lib/libsds.so"

echo "  libstatus RUNPATH after: $(patchelf --print-rpath "$APPDIR/usr/bin/libstatus.so")"
echo "  libsds RUNPATH after:    $(patchelf --print-rpath "$APPDIR/usr/lib/libsds.so")"

# Verify that no Nix path leaked into the dynamic section.
for f in "$APPDIR/usr/bin/libstatus.so" "$APPDIR/usr/lib/libsds.so"; do
  if readelf -d "$f" | grep -q '/nix/store'; then
    echo "ERROR: /nix/store still present in dynamic section of $f" >&2
    readelf -d "$f" | grep '/nix/store' >&2
    exit 1
  fi
done
echo "  no /nix/store in dynamic section"

# .desktop
#
# The file name is the reverse-DNS Tauri `identifier`, and that is not cosmetic:
# `appimagetool` looks for AppStream metadata under the desktop file name
# (`<name>.appdata.xml`), and `appstreamcli validate-tree` requires
# `<launchable>` to reference an existing desktop id. Any other name fails
# validation with `metainfo-filename-cid-mismatch` and `desktop-file-not-found`,
# and linuxdeploy refuses to build the image.
#
# The icon is referenced by the bare name `stauri-app`, without a path, which is
# how the window manager looks it up.
DESKTOP_ID="com.magnus.stauri-app"
cat > "$APPDIR/usr/share/applications/$DESKTOP_ID.desktop" << 'EOF'
[Desktop Entry]
Type=Application
Name=Stauri
GenericName=Status client
Comment=Лёгкий клиент Status: чаты и кошелёк
Exec=stauri-app %U
Icon=stauri-app
Terminal=false
Categories=Network;InstantMessaging;
Keywords=status;messenger;waku;ethereum;wallet;
StartupWMClass=stauri-app
EOF

if [[ -n "$(command -v desktop-file-validate || true)" ]]; then
  if desktop-file-validate "$APPDIR/usr/share/applications/$DESKTOP_ID.desktop" 2>&1 | sed 's/^/  /'; then
    echo "  ✓ desktop entry valid"
  else
    echo "ERROR: desktop-file-validate нашёл ошибки в $DESKTOP_ID.desktop" >&2
    exit 1
  fi
else
  echo "  WARNING: desktop-file-validate отсутствует — проверка .desktop пропущена" >&2
fi

# AppStream: installed under usr/share/metainfo/ with the name equal to <id>.
#
# The suffix must be `.appdata.xml` and the name must match the component id.
# `linuxdeploy-plugin-appimage` runs `appstreamcli validate-tree`, which with a
# `.metainfo.xml` suffix does not find the file at all
# (`dir-no-metadata-found`), and with a name/id mismatch fails with
# `metainfo-filename-cid-mismatch`; either way the plugin aborts the build.
if [[ -f "$METAINFO" ]]; then
  mkdir -p "$APPDIR/usr/share/metainfo"
  cp "$METAINFO" "$APPDIR/usr/share/metainfo/$(basename "$METAINFO")"
  echo "  metainfo: installed as $(basename "$METAINFO")"
fi

# License: catalogs (Flathub, AppImageHub) and GPL linters require the full text
# in the package. `<project_license>MPL-2.0</project_license>` in the metainfo is
# only an identifier, not the text.
LICENSE_FILE="$ROOT/LICENSE.md"
if [[ -f "$LICENSE_FILE" ]]; then
  mkdir -p "$APPDIR/usr/share/licenses/stauri-app"
  cp "$LICENSE_FILE" "$APPDIR/usr/share/licenses/stauri-app/LICENSE.md"
  echo "  license: installed"
else
  echo "  WARNING: LICENSE.md отсутствует — текст лицензии не попадёт в пакет" >&2
fi

# Icons: one file per size in hicolor, not just 128x128 — otherwise the tray and
# menu stretch a small image on HiDPI displays.
for size in 32 128 256 512; do
  case "$size" in
    32)  src="$ROOT/src-tauri/icons/32x32.png" ;;
    128) src="$ROOT/src-tauri/icons/128x128.png" ;;
    256) src="$ROOT/src-tauri/icons/128x128@2x.png" ;;
    512) src="$ROOT/src-tauri/icons/icon.png" ;;
  esac
  if [[ -f "$src" ]]; then
    mkdir -p "$APPDIR/usr/share/icons/hicolor/${size}x${size}/apps"
    cp "$src" "$APPDIR/usr/share/icons/hicolor/${size}x${size}/apps/stauri-app.png"
  fi
done

# Root icon: linuxdeploy uses it to tell that the AppDir is packaged correctly.
ICON="$ROOT/src-tauri/icons/128x128.png"
if [[ -f "$ICON" ]]; then
  cp "$ICON" "$APPDIR/stauri-app.png"
fi

# AppRun: LD_LIBRARY_PATH to usr/lib (where libsds.so lives) and start tauri-app.
#
# LD_LIBRARY_PATH is reset rather than extended: an inherited value may contain
# /usr/lib/x86_64-linux-gnu, and the system libc then overrides the one the
# binaries were built against.
cat > "$APPDIR/AppRun" << 'EOF'
#!/bin/bash
HERE="$(dirname "$(readlink -f "${0}")")"
unset LD_LIBRARY_PATH
export LD_LIBRARY_PATH="$HERE/usr/lib"
exec "$HERE/usr/bin/stauri-app" "$@"
EOF
chmod +x "$APPDIR/AppRun"

echo "  AppDir: $APPDIR"

# ---------- 6. linuxdeploy ----------
echo
echo "[6/8] Running linuxdeploy"

# No ldd workaround: status-go is a shared library now, and linuxdeploy resolves
# its dependencies against the system loader.
mkdir -p /tmp/bin
rm -f /tmp/bin/ldd

# Download linuxdeploy and the AppImage plugin, verifying sha256. A cached file
# is not downloaded again, but always verified.
fetch_verified "$LINUXDEPLOY_URL" /tmp/linuxdeploy-x86_64.AppImage "$LINUXDEPLOY_SHA256"
fetch_verified "$PLUGIN_URL" /tmp/linuxdeploy-plugin-appimage-x86_64.AppImage "$PLUGIN_SHA256"
chmod +x /tmp/linuxdeploy-x86_64.AppImage /tmp/linuxdeploy-plugin-appimage-x86_64.AppImage

cp /tmp/linuxdeploy-plugin-appimage-x86_64.AppImage /tmp/bin/linuxdeploy-plugin-appimage
chmod +x /tmp/bin/linuxdeploy-plugin-appimage

cd "$(dirname "$APPDIR")"

PATH="/tmp/bin:$PATH" \
NO_STRIP=1 \
APPIMAGE_EXTRACT_AND_RUN=1 \
/tmp/linuxdeploy-x86_64.AppImage \
  --appdir "$(basename "$APPDIR")" \
  --output appimage

# ---------- 7. Verification ----------
echo
echo "[7/8] Verifying AppImage"

# Take the newest file rather than the first match: under some plugin settings
# linuxdeploy writes both a versioned AppImage and a symlink to it.
APPIMAGE_PATH=$(
  find "$(dirname "$APPDIR")" -maxdepth 1 -name "*.AppImage" -printf '%T@ %p\n' \
    | sort -rn | head -1 | cut -d' ' -f2- || true
)
if [[ -z "${APPIMAGE_PATH:-}" || ! -f "$APPIMAGE_PATH" ]]; then
  echo "ERROR: AppImage not found in $(dirname "$APPDIR")" >&2
  exit 1
fi

echo "  AppImage: $APPIMAGE_PATH"
echo "  Size:     $(du -h "$APPIMAGE_PATH" | cut -f1)"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
(
  cd "$TMP"
  "$APPIMAGE_PATH" --appimage-extract >/dev/null 2>&1 || true
  if find squashfs-root -name "libsds.so" | grep -q .; then
    echo "  ✓ libsds.so found inside AppImage"
  else
    echo "  WARNING: libsds.so not found inside AppImage" >&2
  fi
  if [[ -x squashfs-root/AppRun ]]; then
    echo "  ✓ AppRun present"
  fi
  LIB=$(find squashfs-root -name libstatus.so | head -1)
  if [[ -z "$LIB" ]]; then
    echo "  ERROR: libstatus.so not found inside AppImage" >&2
    exit 1
  fi
  echo "  ✓ libstatus.so found: $LIB"
  RPATH=$(patchelf --print-rpath "$LIB" 2>/dev/null || true)
  echo "  libstatus RPATH: '$RPATH'"
  if [[ "$RPATH" == */nix/store* ]]; then
    echo "  ERROR: RUNPATH still points into /nix/store" >&2
    exit 1
  fi

  # Load the library the way the app does: with the system loader and a dirty
  # LD_LIBRARY_PATH inherited from the shell. A Nix glibc in the RUNPATH would
  # put two incompatible libcs in one process and crash before main().
  if LD_LIBRARY_PATH=/usr/lib/x86_64-linux-gnu \
     python3 -c "import ctypes,sys; ctypes.CDLL(sys.argv[1])" "$LIB" >/dev/null 2>&1; then
    echo "  ✓ libstatus.so loads under inherited LD_LIBRARY_PATH"
  else
    echo "  ERROR: libstatus.so failed to load" >&2
    exit 1
  fi
)

echo
echo "=== Done ==="
echo "AppImage: $APPIMAGE_PATH"

# ---------- 7a. APK (Android) — see scripts/lib/android-apk.sh ----------
echo
if [[ "${RELEASE_SKIP_ANDROID:-0}" == "1" ]]; then
  echo "[7a] Android APK: пропущен (RELEASE_SKIP_ANDROID=1, собирает release-android.sh)"
else
  # shellcheck source=lib/android-apk.sh
  source "$ROOT/scripts/lib/android-apk.sh"
fi

# ---------- 8. Checksums, signature, update manifest, git tag ----------
echo
echo "[8/8] Checksums, signature, update manifest, git tag"

# Write <name>.sha256 next to the AppImage in `sha256sum -c` format: it can be
# checked with a single command and does not depend on this script.
CHECKSUM_FILE="${APPIMAGE_PATH}.sha256"
if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$(dirname "$APPIMAGE_PATH")"
    sha256sum "$(basename "$APPIMAGE_PATH")" > "$(basename "$CHECKSUM_FILE")"
  )
  echo "  sha256: $(cut -d' ' -f1 "$CHECKSUM_FILE")"
  echo "  file:   $(basename "$CHECKSUM_FILE")"
else
  echo "  WARNING: sha256sum отсутствует — контрольная сумма не создана" >&2
fi

# Sign with a minisign-compatible key in Tauri's format. This is the signature
# the built-in updater verifies, so it is useful beyond auto-update: a user can
# confirm that the file was built by this project.
#
# --app-version binds the signature to the version: it goes into the signed
# trusted comment, so an updater with requireSignedVersion rejects a manifest
# whose version number has been swapped.
if [[ -n "$SIGN_KEY" ]]; then
  SIGNATURE_FILE="${APPIMAGE_PATH}.sig"
  if [[ "$SIGN_KEY" == "<TAURI_SIGNING_PRIVATE_KEY>" ]]; then
    pnpm tauri signer sign --app-version "$VERSION" "$APPIMAGE_PATH" 2>&1 | sed 's/^/  /'
  else
    pnpm tauri signer sign -f "$SIGN_KEY" --app-version "$VERSION" "$APPIMAGE_PATH" 2>&1 | sed 's/^/  /'
  fi
  if [[ -f "$SIGNATURE_FILE" ]]; then
    echo "  signature: $(basename "$SIGNATURE_FILE") (v$VERSION)"
  else
    echo "ERROR: подпись не создана (ожидался $SIGNATURE_FILE)" >&2
    exit 1
  fi
else
  echo "  WARNING: подпись пропущена (ключ не задан)" >&2
fi

# The latest.json update manifest is exactly what the built-in updater downloads
# from the address in plugins.updater.endpoints in tauri.conf.json.
#
# Static format: one file describes all platforms, and the updater picks the
# entry by key. The key `linux-x86_64` is the tauri-plugin-updater format
# (updater_os + "-" + updater_arch) and must not be changed.
#
# url points at GitHub releases: the tag is uploaded separately, but the file
# name must match what is actually attached to the release. signature is the
# contents of the .sig file on a single line, as the plugin expects.
MANIFEST_FILE="$(dirname "$APPIMAGE_PATH")/latest.json"

# Cross-check the key inside the built binary.
#
# The key is inlined as a string, so finding it in the binary is enough. This
# catches the case where the signature and latest.json were produced but
# tauri.conf.json had an empty pubkey at build time: the release looks complete
# while `check_for_update` would return None forever.
#
# Checked only when a key is configured: without one there is no such
# requirement.
CONFIG_PUBKEY="$(python3 -c "
import json
print(json.load(open('$ROOT/src-tauri/tauri.conf.json'))['plugins']['updater']['pubkey'].strip())
")"
if [[ -n "$CONFIG_PUBKEY" ]]; then
  if grep -qaF "$CONFIG_PUBKEY" "$TAURI_BIN"; then
    echo "  ✓ updater pubkey is embedded in the binary"
  else
    echo "ERROR: в собранном бинарнике нет pubkey из tauri.conf.json." >&2
    echo "       Ключ был добавлен после сборки — пересоберите приложение," >&2
    echo "       иначе проверка обновлений всегда будет возвращать «нет обновлений»." >&2
    exit 1
  fi
else
  echo "  WARNING: plugins.updater.pubkey пуст — обновления в этой сборке" >&2
  echo "           работать не будут, даже если подпись создана." >&2
fi
if [[ -n "$SIGN_KEY" && -f "${APPIMAGE_PATH}.sig" ]]; then
  DOWNLOAD_URL="https://github.com/magnus-redkin/stauri-app/releases/download/v$VERSION/$(basename "$APPIMAGE_PATH")"
  python3 - "$MANIFEST_FILE" "$VERSION" "$DOWNLOAD_URL" "${APPIMAGE_PATH}.sig" <<'PY'
import json, sys
from datetime import datetime, timezone

manifest_path, version, url, sig_path = sys.argv[1:5]
signature = open(sig_path, encoding='utf-8').read().strip()

manifest = {
    "version": version,
    "pub_date": datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    "platforms": {
        "linux-x86_64": {
            "url": url,
            "signature": signature,
        }
    },
}
with open(manifest_path, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, ensure_ascii=False, indent=2)
    f.write('\n')
PY
  echo "  update manifest: $(basename "$MANIFEST_FILE")"
  echo "    upload: $(basename "$APPIMAGE_PATH"), $(basename "$APPIMAGE_PATH").sig, latest.json"
else
  echo "  WARNING: latest.json не создан — без подписи updater всё равно" >&2
  echo "           отвергнет обновление." >&2
  MANIFEST_FILE=""
fi

# The tag is created last, and only on success: it must point at the very code
# this AppImage was built from. Nothing is pushed — publishing to the remote is
# a human decision. `git tag -a` makes an annotated tag, which carries a date and
# an author, unlike a lightweight one.
if [[ "${RELEASE_NO_TAG:-0}" == "1" ]]; then
  echo "  tag: пропущен (RELEASE_NO_TAG=1, тег ставит release-create.sh)"
elif git rev-parse --git-dir >/dev/null 2>&1; then
  if git rev-parse -q --verify "refs/tags/v$VERSION" >/dev/null; then
    echo "  WARNING: тег v$VERSION появился во время сборки — не переставляю" >&2
  else
    git tag -a "v$VERSION" -m "Stauri $VERSION"
    echo "  tag: v$VERSION -> $(git rev-parse --short HEAD)"
    echo "  отправить в remote: git push origin v$VERSION"
  fi
else
  echo "  WARNING: не git-репозиторий — тег не поставлен" >&2
fi

echo
echo "=== Artifacts ==="
echo "  $APPIMAGE_PATH"
[[ -f "$CHECKSUM_FILE" ]] && echo "  $CHECKSUM_FILE"
[[ -n "$SIGN_KEY" && -f "${APPIMAGE_PATH}.sig" ]] && echo "  ${APPIMAGE_PATH}.sig"
[[ -n "$MANIFEST_FILE" && -f "$MANIFEST_FILE" ]] && echo "  $MANIFEST_FILE"
