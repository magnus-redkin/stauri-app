#!/usr/bin/env bash
# release-create.sh — шаг 1 релиза: локальный тег и draft-релиз на GitHub.
#
# Использование (из stauri-app/):
#   ./scripts/release-create.sh 0.4.0-beta          # создать тег и draft
#   ./scripts/release-create.sh 0.4.0-beta --check  # только проверки, ничего не создаёт
#
# Предусловия (скрипт откажется, если хоть одно не выполнено):
#   - рабочее дерево чистое, все изменения закоммичены (включая CHANGELOG.md);
#   - в package.json, tauri.conf.json, Cargo.toml и appdata.xml уже стоит VERSION;
#   - в CHANGELOG.md есть секция "## [VERSION]";
#   - тега v<VERSION> нет ни локально, ни на origin, и релиза с таким тегом нет.
#
# Что делает:
#   - ставит локальный аннотированный тег v<VERSION> на HEAD (НЕ отправляет);
#   - создаёт draft-релиз на GitHub с текстом из CHANGELOG.md и target = HEAD.
#     У draft-релиза тег на GitHub появляется только при публикации, поэтому
#     до шага 4 пользователи релиз не видят.
#
# Что НЕ делает: не загружает ассеты (шаги 2 и 3), не публикует (шаг 4).

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

# 1. Чистое дерево. Untracked не учитываем: сборка их не использует.
echo "[1/5] Рабочее дерево"
if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  fail "есть незакоммиченные изменения:"
  git status --short --untracked-files=no | sed 's/^/      /' >&2
else
  ok "чистое, HEAD = $(git rev-parse --short HEAD)"
fi

# 2. Версии согласованы с VERSION.
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

# 3. Секция в CHANGELOG.md.
echo "[3/5] CHANGELOG.md"
NOTES="$(awk -v hdr="## [$VERSION]" 'index($0, hdr)==1 {f=1; next} /^## \[/ {f=0} f' CHANGELOG.md 2>/dev/null || true)"
if [[ -z "$(echo "$NOTES" | tr -d '[:space:]')" ]]; then
  fail "нет непустой секции [$VERSION] в CHANGELOG.md (запустите scripts/release-changelog.sh)"
else
  ok "секция [$VERSION]: $(echo "$NOTES" | grep -c '^- ') пунктов"
fi

# 4. Тега и релиза ещё нет — ни локально, ни на origin.
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

# 5. Доступ к GitHub.
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

# Создание. Тег — локальный и аннотированный, на origin не отправляем.
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
