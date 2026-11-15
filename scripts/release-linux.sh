#!/usr/bin/env bash
# release-linux.sh — release step 2: the Linux AppImage into a draft release.
#
# Usage (from stauri-app/):
#   ./scripts/release-linux.sh 0.4.0-beta            # build and upload
#   ./scripts/release-linux.sh 0.4.0-beta --check    # checks only
#
# Preconditions:
#   - tag v<VERSION> is on HEAD (created by release-create.sh);
#   - draft release v<VERSION> exists on GitHub;
#   - the tree is clean;
#   - the signing key password is available (keyring or env), see release.sh.
#
# Steps:
#   1. Verify the preconditions.
#   2. Run release.sh with RELEASE_NO_TAG=1: build, .sha256, .sig, latest.json.
#      It does not tag; the tag already exists and release.sh refuses to move it.
#   3. Upload the AppImage, .sha256, .sig and latest.json to the draft
#      (--clobber makes a re-run replace assets instead of failing).
#   4. Print the release asset list.
#
# Publishing (lifting the draft) is step 4, not this script.

set -euo pipefail

VERSION="${1:-}"
MODE="${2:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [--check]" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "ERROR: версия должна быть semver, например 0.4.0-beta" >&2
  exit 1
fi
CHECK_ONLY=0
if [[ "$MODE" == "--check" ]]; then
  CHECK_ONLY=1
elif [[ -n "$MODE" ]]; then
  echo "ERROR: неизвестный аргумент: $MODE" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

TAG="v$VERSION"
FAIL=0
fail() { echo "  ✗ $1" >&2; FAIL=1; }
ok()   { echo "  ✓ $1"; }

echo "=== Linux-артефакты для $TAG ==="

# 1. Preconditions.
echo "[1/4] Предусловия"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  TAG_SHA="$(git rev-parse "$TAG^{commit}")"
  # Compare the application code, not all of HEAD: commits touching the release
  # scripts do not change the build.
  APP_PATHS=(src src-tauri package.json pnpm-lock.yaml)
  if [[ -z "$(git diff --name-only "$TAG_SHA" HEAD -- "${APP_PATHS[@]}")" ]]; then
    ok "тег $TAG ($(git rev-parse --short "$TAG_SHA")): код приложения совпадает с HEAD"
  else
    fail "код приложения в HEAD отличается от тега $TAG — сборка не из того кода"
  fi
else
  fail "тега $TAG нет (сначала release-create.sh)"
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "рабочее дерево не чистое"
else
  ok "дерево чистое"
fi
if gh release view "$TAG" --json isDraft --jq '.isDraft' 2>/dev/null | grep -q true; then
  ok "draft-релиз $TAG существует"
else
  fail "draft-релиза $TAG нет или он уже опубликован"
fi
if [[ -z "${TAURI_SIGNING_PRIVATE_KEY_PATH:-}" && ! -f "$HOME/.tauri/stauri.key" ]]; then
  fail "ключ подписи не найден (~/.tauri/stauri.key или TAURI_SIGNING_PRIVATE_KEY_PATH)"
else
  ok "ключ подписи доступен"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo
  echo "Предусловия не выполнены — сборка не запущена."
  exit 1
fi
if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo
  echo "Все предусловия выполнены. --check: сборка не запущена."
  exit 0
fi

# 2. Build. release.sh does the work; it neither tags nor builds the APK.
echo
echo "[2/4] Сборка AppImage (release.sh, RELEASE_NO_TAG=1)"
# release.sh requires the key path in a variable; the default is Tauri's standard key.
export TAURI_SIGNING_PRIVATE_KEY_PATH="${TAURI_SIGNING_PRIVATE_KEY_PATH:-$HOME/.tauri/stauri.key}"
RELEASE_NO_TAG=1 RELEASE_SKIP_ANDROID=1 ./scripts/release.sh "$VERSION"

APPIMAGE="$(ls -t "$ROOT"/src-tauri/target/release/bundle/appimage/*.AppImage 2>/dev/null | head -1)"
SHA_FILE="${APPIMAGE}.sha256"
SIG_FILE="${APPIMAGE}.sig"
MANIFEST="$(dirname "$APPIMAGE")/latest.json"
for f in "$APPIMAGE" "$SHA_FILE" "$SIG_FILE" "$MANIFEST"; do
  if [[ ! -f "$f" ]]; then
    echo "ERROR: после сборки нет файла: $f" >&2
    exit 1
  fi
done

# 3. Upload to the draft.
echo
echo "[3/4] Загрузка в draft $TAG"
gh release upload "$TAG" "$APPIMAGE" "$SHA_FILE" "$SIG_FILE" "$MANIFEST" --clobber
echo "  загружено: $(basename "$APPIMAGE"), .sha256, .sig, latest.json"

# 4. Result.
echo
echo "[4/4] Ассеты релиза"
gh release view "$TAG" --json assets --jq '.assets[] | "  \(.name)  \(.size) байт"'
echo
echo "Draft по-прежнему не опубликован. Публикация — шаг 4 (release-publish.sh)."
