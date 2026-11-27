#!/usr/bin/env bash
# release-windows-assets.sh — release step 3.5: the Windows installer into the draft.
#
# Usage (from stauri-app/):
#   ./scripts/release-windows-assets.sh 0.5.5                    # sign + merge + upload
#   ./scripts/release-windows-assets.sh 0.5.5 --installer PATH   # explicit installer
#   ./scripts/release-windows-assets.sh 0.5.5 --check            # checks only
#
# Why this step exists: the Windows installer is built on Windows
# (`scripts/release-windows.ps1`), but the updater key lives on the Linux host
# and `latest.json` describes every platform in one file. So the installer is
# signed, merged into the manifest and uploaded here, not on the VM.
#
# Preconditions:
#   - draft release v<VERSION> exists;
#   - the installer is in dist/windows-<VERSION>/*-setup.exe (or given with
#     --installer); an existing .sig next to it is reused;
#   - the manifest from step 2 exists
#     (src-tauri/target/release/bundle/appimage/latest.json);
#   - the updater key is available (~/.tauri/stauri.key or
#     TAURI_SIGNING_PRIVATE_KEY_PATH, password from the keyring).
#
# Steps:
#   1. Verify the preconditions.
#   2. Sign the installer with the updater key when it is not signed yet.
#   3. Merge windows-x86_64 into latest.json and compute the .sha256.
#   4. Upload the installer, .sig, .sha256 and the merged latest.json
#      (--clobber makes a re-run replace assets instead of failing).
#
# Publishing is step 4 (release-publish.sh), not this script.

set -euo pipefail

VERSION="${1:-}"
shift || true
MODE=build
INSTALLER=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --check) MODE=check ;;
    --installer) INSTALLER="${2:?--installer требует путь}"; shift ;;
    *) echo "ERROR: неизвестный аргумент: $1" >&2; exit 1 ;;
  esac
  shift
done
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "ERROR: версия должна быть semver, например 0.5.5" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG="v$VERSION"
FAIL=0
fail() { echo "  ✗ $1" >&2; FAIL=1; }
ok()   { echo "  ✓ $1"; }

echo "=== Windows-ассеты для $TAG ==="

# 1. Preconditions.
echo "[1/4] Предусловия"
if gh release view "$TAG" --json isDraft --jq '.isDraft' 2>/dev/null | grep -q true; then
  ok "draft-релиз $TAG существует"
else
  fail "draft-релиза $TAG нет или он уже опубликован"
fi

if [[ -z "$INSTALLER" ]]; then
  INSTALLER="$(ls -t dist/windows-"$VERSION"/*-setup.exe 2>/dev/null | head -1 || true)"
fi
if [[ -n "$INSTALLER" && -f "$INSTALLER" ]]; then
  ok "установщик: $INSTALLER"
else
  fail "установщик не найден: положите его в dist/windows-$VERSION/ или укажите --installer"
  INSTALLER=""
fi

MANIFEST="$ROOT/src-tauri/target/release/bundle/appimage/latest.json"
if [[ -f "$MANIFEST" ]]; then
  ok "latest.json: $MANIFEST"
else
  fail "нет latest.json — сначала шаг 2 (release-linux.sh)"
fi

KEY="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/stauri.key}"
if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" || -f "$KEY" ]]; then
  ok "ключ подписи доступен"
else
  fail "ключ подписи не найден (~/.tauri/stauri.key или TAURI_SIGNING_PRIVATE_KEY_PATH)"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo
  echo "Предусловия не выполнены — ничего не загружено."
  exit 1
fi
if [[ "$MODE" == "check" ]]; then
  echo
  echo "Все предусловия выполнены. --check: ничего не подписано и не загружено."
  exit 0
fi

# 2. Sign. The PowerShell script may already have signed the installer on the
#    VM; then the .sig is reused and the key is not needed here.
echo "[2/4] Подпись обновления"
if [[ -f "$INSTALLER.sig" ]]; then
  ok "подпись уже есть: $(basename "$INSTALLER").sig"
else
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
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    pnpm tauri signer sign --app-version "$VERSION" "$INSTALLER"
  else
    pnpm tauri signer sign -f "$KEY" --app-version "$VERSION" "$INSTALLER"
  fi
  [[ -f "$INSTALLER.sig" ]] || { echo "ERROR: подпись не создана" >&2; exit 1; }
  ok "подпись создана"
fi

# 3. Merge into the manifest and checksum.
echo "[3/4] latest.json и .sha256"
URL="https://github.com/magnus-redkin/stauri-app/releases/download/$TAG/$(basename "$INSTALLER")"
python3 - "$MANIFEST" "$VERSION" "$URL" "$INSTALLER.sig" <<'PY'
import json, sys

manifest_path, version, url, sig_path = sys.argv[1:5]
with open(manifest_path, encoding='utf-8') as f:
    manifest = json.load(f)
signature = open(sig_path, encoding='utf-8').read().strip()
manifest.setdefault('platforms', {})['windows-x86_64'] = {
    'url': url,
    'signature': signature,
}
manifest['version'] = version
with open(manifest_path, 'w', encoding='utf-8') as f:
    json.dump(manifest, f, indent=2, ensure_ascii=False)
    f.write('\n')
print('  ✓ windows-x86_64 добавлен в latest.json')
PY
sha256sum "$INSTALLER" | sed 's#  .*/#  #' > "$INSTALLER.sha256"
ok "$(basename "$INSTALLER").sha256"

# 4. Upload.
echo "[4/4] Загрузка в draft $TAG"
gh release upload "$TAG" "$INSTALLER" "$INSTALLER.sig" "$INSTALLER.sha256" "$MANIFEST" --clobber
echo "  загружено: $(basename "$INSTALLER"), .sig, .sha256, latest.json"
echo
echo "Draft по-прежнему не опубликован. Публикация — release-publish.sh $VERSION --publish."
