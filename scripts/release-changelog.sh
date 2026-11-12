#!/usr/bin/env bash
# release-changelog.sh — шаг 0 релиза: генерирует CHANGELOG.md из git-истории.
#
# Использование (из stauri-app/):
#   ./scripts/release-changelog.sh 0.4.0-beta
#
# Что делает:
#   - берёт коммиты от последнего тега v* (или от начала истории, если тегов нет);
#   - группирует по типу Conventional Commits (feat, fix, refactor, …);
#   - переписывает CHANGELOG.md, добавляя секцию новой версии сверху;
#   - показывает diff.
#
# Что НЕ делает: не коммитит и не ставит тег. Файл проверяете вы, затем коммит.

set -euo pipefail

VERSION="${1:-}"
if [[ -z "$VERSION" ]]; then
  echo "Usage: $0 <version>" >&2
  exit 1
fi
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  echo "ERROR: версия должна быть semver, например 0.4.0-beta" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CHANGELOG="CHANGELOG.md"
TODAY="$(date +%Y-%m-%d)"

# Диапазон: от последнего тега версии до HEAD. Тегов нет — вся история.
LAST_TAG="$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)"
if [[ -n "$LAST_TAG" ]]; then
  RANGE="$LAST_TAG..HEAD"
  echo "  диапазон: $LAST_TAG..HEAD"
else
  RANGE="HEAD"
  echo "  тегов v* нет — беру всю историю"
fi

# Формат: хеш, тема. Тело не нужно: группируем по теме.
COMMITS="$(git log --no-merges --format='%h%x09%s' "$RANGE")"
if [[ -z "$COMMITS" ]]; then
  echo "ERROR: нет коммитов в диапазоне $RANGE — нечего описывать." >&2
  exit 1
fi

# Python разбирает Conventional Commits и пишет секцию в временный файл.
SECTION_FILE="$(mktemp)"
trap 'rm -f "$SECTION_FILE" "$COMMITS_FILE"' EXIT

COMMITS_FILE="$(mktemp)"
printf '%s\n' "$COMMITS" > "$COMMITS_FILE"
python3 - "$VERSION" "$TODAY" "$SECTION_FILE" "$COMMITS_FILE" <<'PY'
import re, sys

version, today, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
lines = [l for l in open(sys.argv[4], encoding="utf-8").read().splitlines() if l.strip()]

# Порядок секций в changelog и заголовки.
GROUPS = [
    ("feat", "Новое"),
    ("fix", "Исправления"),
    ("refactor", "Рефакторинг"),
    ("perf", "Производительность"),
    ("docs", "Документация"),
    ("test", "Тесты"),
    ("build", "Сборка и релиз"),
    ("ci", "Сборка и релиз"),
    ("chore", "Прочее"),
]
TITLES = {}
for key, title in GROUPS:
    TITLES.setdefault(title, []).append(key)

pattern = re.compile(r"^(?P<type>[a-zA-Z]+)(\([^)]*\))?(?P<bang>!)?:\s*(?P<subj>.+)$")

buckets = {}   # заголовок -> список строк
other = []     # без типа
for line in lines:
    sha, subj = line.split("\t", 1)
    m = pattern.match(subj)
    if not m:
        other.append(f"- {subj} (`{sha}`)")
        continue
    typ = m.group("type").lower()
    title = next((t for k, t in GROUPS if k == typ), None)
    entry = f"- {m.group('subj')} (`{sha}`)"
    if m.group("bang"):
        entry = "- **BREAKING:** " + entry[2:]
    if title is None:
        title = "Прочее"
    buckets.setdefault(title, []).append(entry)

ORDER = ["Новое", "Исправления", "Рефакторинг", "Производительность",
         "Сборка и релиз", "Документация", "Тесты", "Прочее"]

out = [f"## [{version}] — {today}", ""]
for title in ORDER:
    if title in buckets:
        out.append(f"### {title}")
        out.extend(buckets[title])
        out.append("")
if other:
    out.append("### Без типа")
    out.extend(other)
    out.append("")

open(out_path, "w", encoding="utf-8").write("\n".join(out))
PY

# Заголовок файла + новая секция + старое содержимое (без своего заголовка).
HEADER="# Changelog

Все заметные изменения Stauri. Секции генерирует \`scripts/release-changelog.sh\`
из Conventional Commits; новые версии идут сверху.
"

if [[ -f "$CHANGELOG" ]]; then
  OLD="$(sed '1,/^## \[/{/^## \[/!d}' "$CHANGELOG" || true)"
else
  OLD=""
fi

# Если версия уже есть в файле — не дублируем секцию.
if [[ -f "$CHANGELOG" ]] && grep -q "^## \[$VERSION\]" "$CHANGELOG"; then
  echo "ERROR: версия $VERSION уже есть в $CHANGELOG. Удалите секцию или выберите другую версию." >&2
  exit 1
fi

{
  printf '%s\n' "$HEADER"
  cat "$SECTION_FILE"
  if [[ -n "$OLD" ]]; then
    printf '%s\n' "$OLD"
  fi
} > "$CHANGELOG.new"
mv "$CHANGELOG.new" "$CHANGELOG"

echo "  записано: $CHANGELOG (секция $VERSION)"
echo
echo "=== diff ==="
git --no-pager diff -- "$CHANGELOG" | head -120 || true
echo
echo "Дальше: проверьте $CHANGELOG, затем закоммитьте его отдельным коммитом."
echo "Тег и релиз создаст scripts/release-create.sh."
