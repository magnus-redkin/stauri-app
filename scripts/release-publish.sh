#!/usr/bin/env bash
# release-publish.sh — release step 4: publish the draft release.
#
# Usage (from stauri-app/):
#   ./scripts/release-publish.sh 0.4.0-beta             # checks only (default)
#   ./scripts/release-publish.sh 0.4.0-beta --publish   # push the tag, lift the draft
#
# Without --publish the script changes nothing on GitHub or on the remote.
#
# With --publish:
#   1. Push tag v<VERSION> to origin (never forced).
#   2. Lift the draft: the release becomes visible to everyone.
#
# Preconditions (always checked):
#   - release v<VERSION> exists and is a draft;
#   - the draft holds every asset: AppImage, .sha256, .sig, latest.json, APK,
#     and the Windows installer with its .sig; latest.json carries the
#     windows-x86_64 platform. RELEASE_ALLOW_MISSING_WINDOWS=1 turns the
#     Windows assets into a printed warning (a Linux+Android release on purpose);
#   - local tag v<VERSION> points at the application code in HEAD;
#   - tag v<VERSION> is not on origin yet (or already points at the same commit);
#   - the tree is clean.

set -euo pipefail

VERSION="${1:-}"
MODE="${2:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version> [--publish]" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "ERROR: версия должна быть semver, например 0.4.0-beta" >&2
  exit 1
fi
PUBLISH=0
if [[ "$MODE" == "--publish" ]]; then
  PUBLISH=1
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

echo "=== Публикация $TAG ==="

# 1. Draft and assets.
echo "[1/3] Draft и ассеты"
DRAFT_JSON="$(gh release view "$TAG" --json isDraft,assets 2>/dev/null || true)"
if [[ -z "$DRAFT_JSON" ]]; then
  fail "релиза $TAG нет на GitHub"
else
  IS_DRAFT="$(echo "$DRAFT_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin)["isDraft"])')"
  if [[ "$IS_DRAFT" == "True" ]]; then
    ok "релиз $TAG в draft"
  else
    fail "релиз $TAG уже опубликован — публиковать нечего"
  fi
  NAMES="$(echo "$DRAFT_JSON" | python3 -c 'import json,sys; print("\n".join(a["name"] for a in json.load(sys.stdin)["assets"]))')"
  for need in "Stauri-x86_64.AppImage" "Stauri-x86_64.AppImage.sha256" "Stauri-x86_64.AppImage.sig" "latest.json"; do
    if grep -qx "$need" <<<"$NAMES"; then
      ok "ассет: $need"
    else
      fail "нет ассета: $need"
    fi
  done
  if grep -qE "^stauri-app_${VERSION}_aarch64\.apk$" <<<"$NAMES"; then
    ok "ассет: stauri-app_${VERSION}_aarch64.apk"
  else
    fail "нет ассета: stauri-app_${VERSION}_aarch64.apk"
  fi
  # Windows is a shipped platform: an installer without its signature leaves
  # Windows users without updates. RELEASE_ALLOW_MISSING_WINDOWS=1 publishes a
  # Linux+Android release on purpose.
  SETUP="$(grep -E -- '-setup\.exe$' <<<"$NAMES" | head -1 || true)"
  if [[ -z "$SETUP" ]]; then
    if [[ "${RELEASE_ALLOW_MISSING_WINDOWS:-0}" == "1" ]]; then
      echo "  ! Windows-установщика нет (RELEASE_ALLOW_MISSING_WINDOWS=1: пропускаю)" >&2
    else
      fail "нет Windows-установщика (*-setup.exe) — соберите его на Windows и загрузите: scripts/release-windows-assets.sh $VERSION"
    fi
  else
    ok "ассет: $SETUP"
    if grep -qx "${SETUP}.sig" <<<"$NAMES"; then
      ok "ассет: ${SETUP}.sig"
    else
      fail "нет ассета: ${SETUP}.sig"
    fi
    TMP_MANIFEST="$(mktemp)"
    if gh release download "$TAG" --pattern latest.json --output "$TMP_MANIFEST" --clobber >/dev/null 2>&1; then
      if python3 - "$TMP_MANIFEST" <<'PY'
import json, sys
platforms = json.load(open(sys.argv[1], encoding='utf-8')).get('platforms', {})
sys.exit(0 if 'windows-x86_64' in platforms else 1)
PY
      then
        ok "latest.json содержит windows-x86_64"
      else
        fail "latest.json без windows-x86_64 (запустите scripts/release-windows-assets.sh $VERSION)"
      fi
    else
      fail "не удалось скачать latest.json из draft"
    fi
    rm -f "$TMP_MANIFEST"
  fi
fi

# 2. Tag and code.
echo "[2/3] Тег и код"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  TAG_SHA="$(git rev-parse "$TAG^{commit}")"
  APP_PATHS=(src src-tauri package.json pnpm-lock.yaml)
  if [[ -z "$(git diff --name-only "$TAG_SHA" HEAD -- "${APP_PATHS[@]}")" ]]; then
    ok "тег $TAG ($(git rev-parse --short "$TAG_SHA")): код приложения совпадает с HEAD"
  else
    fail "код приложения в HEAD отличается от тега $TAG"
  fi
else
  fail "локального тега $TAG нет (сначала release-create.sh)"
fi
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "рабочее дерево не чистое"
else
  ok "дерево чистое"
fi
REMOTE_SHA="$(git ls-remote --tags origin "refs/tags/$TAG^{}" 2>/dev/null | cut -f1 || true)"
if [[ -z "$REMOTE_SHA" ]]; then
  REMOTE_SHA="$(git ls-remote --tags origin "refs/tags/$TAG" 2>/dev/null | cut -f1 || true)"
fi
if [[ -z "$REMOTE_SHA" ]]; then
  ok "на origin тега $TAG нет (будет отправлен)"
elif [[ "$REMOTE_SHA" == "$(git rev-parse "$TAG^{commit}" 2>/dev/null || echo x)" ]]; then
  ok "на origin тег $TAG уже на том же коммите"
else
  fail "на origin тег $TAG указывает на другой коммит — не перезаписываем"
fi

# 3. Result and action.
echo "[3/3] Итог"
if [[ "$FAIL" -ne 0 ]]; then
  echo
  echo "Предусловия не выполнены — публикация не выполнена."
  exit 1
fi
if [[ "$PUBLISH" -eq 0 ]]; then
  echo
  echo "Все предусловия выполнены. Без --publish ничего не изменено."
  echo "Для публикации: ./scripts/release-publish.sh $VERSION --publish"
  exit 0
fi

# Publish. Tag first, so the urls in latest.json resolve, then lift the draft.
echo
echo "Публикация:"
if [[ -z "$REMOTE_SHA" ]]; then
  git push origin "refs/tags/$TAG"
  echo "  тег $TAG отправлен на origin"
else
  echo "  тег $TAG уже на origin, пропускаю"
fi
gh release edit "$TAG" --draft=false
echo "  draft снят"

echo
gh release view "$TAG" --json tagName,isDraft,isPrerelease,url \
  --jq '"  тег: \(.tagName)\n  draft: \(.isDraft)\n  prerelease: \(.isPrerelease)\n  \(.url)"'
