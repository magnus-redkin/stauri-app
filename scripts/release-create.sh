#!/usr/bin/env bash
# release-create.sh — release step 1: local tag and a GitHub draft release.
#
# Usage (from stauri-app/):
#   ./scripts/release-create.sh 0.4.0-beta          # create tag and draft
#   ./scripts/release-create.sh 0.4.0-beta --check  # checks only, creates nothing
#
# Preconditions (the script refuses unless all hold):
#   - the tree is clean, everything committed (CHANGELOG.md included);
#   - package.json, tauri.conf.json, Cargo.toml and appdata.xml already carry
#     VERSION;
#   - CHANGELOG.md has a "## [VERSION]" section;
#   - tag v<VERSION> exists neither locally nor on origin, and no release with
#     that tag exists.
#
# Steps:
#   - create a local annotated tag v<VERSION> on HEAD (NOT pushed);
#   - create a GitHub draft release with the CHANGELOG.md text and target = HEAD.
#     A draft gets its GitHub tag only on publication, so users see nothing
#     before step 4.
#
# Does not upload assets (steps 2 and 3) or publish (step 4).

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

echo "=== Релиз $VERSION (тег $TAG) ==="

# 1. Clean tree. Untracked files do not matter: the build does not use them.
echo "[1/5] Рабочее дерево"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "есть незакоммиченные изменения:"
  git status --short --untracked-files=no | sed 's/^/      /' >&2
else
  ok "чистое, HEAD = $(git rev-parse --short HEAD)"
fi

# 2. Versions match VERSION.
echo "[2/5] Версии в файлах"
PKG_V="$(node -p "require('./package.json').version")"
TAURI_V="$(node -p "require('./src-tauri/tauri.conf.json').version")"
CARGO_V="$(grep -m1 '^version' src-tauri/Cargo.toml | sed -E 's/^version *= *"([^"]*)".*/\1/')"
APPDATA_V="$(grep -m1 -o '<release version="[^"]*"' src-tauri/metainfo/com.magnus.stauri-app.appdata.xml | sed -E 's/.*"([^"]*)"/\1/')"
for pair in "package.json:$PKG_V" "tauri.conf.json:$TAURI_V" "Cargo.toml:$CARGO_V" "appdata.xml:$APPDATA_V"; do
  name="${pair%%:*}"; v="${pair#*:}"
  if [[ "$v" == "$VERSION" ]]; then
    ok "$name = $v"
  else
    fail "$name = '$v', ожидалось $VERSION (поднимите версию и закоммитьте)"
  fi
done

# 3. Section in CHANGELOG.md.
echo "[3/5] CHANGELOG.md"
NOTES="$(awk -v hdr="## [$VERSION]" 'index($0, hdr)==1 {f=1; next} /^## \[/ {f=0} f' CHANGELOG.md 2>/dev/null || true)"
if [[ -z "$(echo "$NOTES" | tr -d '[:space:]')" ]]; then
  fail "нет непустой секции [$VERSION] в CHANGELOG.md (запустите scripts/release-changelog.sh)"
else
  ok "секция [$VERSION]: $(echo "$NOTES" | grep -c '^- ') пунктов"
fi

# 4. Neither the tag nor the release exists yet — locally or on origin.
echo "[4/5] Тег и релиз"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  fail "локальный тег $TAG уже есть"
else
  ok "локального тега $TAG нет"
fi
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  fail "тег $TAG уже есть на origin"
else
  ok "на origin тега $TAG нет"
fi
if gh release view "$TAG" >/dev/null 2>&1; then
  fail "релиз $TAG уже существует на GitHub"
else
  ok "релиза $TAG на GitHub нет"
fi

# 5. GitHub access.
echo "[5/5] GitHub CLI"
if gh auth status >/dev/null 2>&1; then
  ok "gh авторизован"
else
  fail "gh не авторизован (gh auth login)"
fi

if [[ "$FAIL" -ne 0 ]]; then
  echo
  echo "Проверки не пройдены — ничего не создано."
  exit 1
fi

echo
if [[ "$CHECK_ONLY" -eq 1 ]]; then
  echo "Все проверки пройдены. Режим --check: тег и релиз не созданы."
  exit 0
fi

# Creation. The tag is local and annotated; nothing is pushed to origin.
SHA="$(git rev-parse HEAD)"
git tag -a "$TAG" -m "Stauri $VERSION" "$SHA"
echo "  локальный тег $TAG -> $(git rev-parse --short "$SHA") (не отправлен)"

PRERELEASE_FLAG=()
if [[ "$VERSION" == *-* ]]; then
  PRERELEASE_FLAG=(--prerelease)
fi
NOTES_FILE="$(mktemp)"
trap 'rm -f "$NOTES_FILE"' EXIT
printf '%s\n' "$NOTES" > "$NOTES_FILE"

gh release create "$TAG" \
  --draft \
  --target "$SHA" \
  --title "Stauri $VERSION" \
  --notes-file "$NOTES_FILE" \
  "${PRERELEASE_FLAG[@]}"

echo
echo "=== Draft создан ==="
gh release view "$TAG" --json tagName,isDraft,isPrerelease,url \
  --jq '"  тег: \(.tagName)\n  draft: \(.isDraft)\n  prerelease: \(.isPrerelease)\n  \(.url)"'
echo
echo "Дальше: шаг 2 (AppImage) и шаг 3 (APK) — загрузка ассетов в draft."
echo "Тег v$VERSION отправится на origin при публикации (шаг 4)."
