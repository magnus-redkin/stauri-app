#!/usr/bin/env bash
# release-android.sh — шаг 3 релиза: подписанный APK в draft-релиз.
#
# Использование (из stauri-app/):
#   ./scripts/release-android.sh 0.4.0-beta     # собрать и загрузить
#   ./scripts/release-android.sh 0.4.0-beta --check    # только предусловия
#
# Предусловия: тег v<VERSION> на коде приложения, draft существует, дерево чистое,
# keystore и его пароль доступны (см. release.sh, шаг 7a).
#
# Что делает:
#   1. Проверяет предусловия.
#   2. Вызывает шаг 7a из release.sh (он собирает APK, подписывает и проверяет
#      подпись apksigner). Версия versionName/versionCode ставится там же.
#   3. Загружает APK в draft (--clobber).
#
# Публикацию не делает — это шаг 4.

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

echo "=== Android APK для $TAG ==="

# 1. Предусловия.
echo "[1/3] Предусловия"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  TAG_SHA="$(git rev-parse "$TAG^{commit}")"
  APP_PATHS=(src src-tauri package.json pnpm-lock.yaml)
  if [[ -z "$(git diff --name-only "$TAG_SHA" HEAD -- "${APP_PATHS[@]}")" ]]; then
    ok "тег $TAG ($(git rev-parse --short "$TAG_SHA")): код приложения совпадает с HEAD"
  else
    fail "код приложения в HEAD отличается от тега $TAG"
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
KS="${STAURI_ANDROID_KEYSTORE:-$HOME/.android/stauri-release.jks}"
if [[ -f "$KS" ]]; then
  ok "keystore: $KS"
else
  fail "keystore не найден: $KS"
fi
if command -v secret-tool >/dev/null 2>&1 && secret-tool lookup service stauri-app key android-keystore-password >/dev/null 2>&1; then
  ok "пароль keystore в keyring"
else
  fail "пароль keystore не найден в keyring (android-keystore-password)"
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

# 2. Сборка APK. Шаг 7a из release.sh: сборка, подпись, versionName/versionCode.
# ANDROID_HOME: на этой машине SDK в ~/Android/sdk (строчными буквами).
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.2.12479018}"
echo
echo "[2/3] Сборка APK (release.sh, только шаг 7a)"
echo "  ANDROID_HOME=$ANDROID_HOME"

# Запускаем только Android-шаг: остальное release.sh для AppImage не нужно.
# Для этого отдельный путь: release.sh с RELEASE_ONLY_ANDROID=1 пропускает всё, кроме 7a.
RELEASE_ONLY_ANDROID=1 ./scripts/release.sh "$VERSION"

APK="$ROOT/src-tauri/target/release/bundle/apk/stauri-app_${VERSION}_aarch64.apk"
if [[ ! -f "$APK" ]]; then
  echo "ERROR: APK не найден после сборки: $APK" >&2
  exit 1
fi

# 3. Загрузка в draft.
echo
echo "[3/3] Загрузка в draft $TAG"
gh release upload "$TAG" "$APK" --clobber
echo "  загружено: $(basename "$APK")"

echo
gh release view "$TAG" --json assets --jq '.assets[] | "  \(.name)  \(.size) байт"'
echo
echo "Draft по-прежнему не опубликован. Публикация — шаг 4 (release-publish.sh)."
