#!/usr/bin/env bash
# clean-disk.sh — удаляет артефакты сборки Stauri внутри репозитория.
# Профили, ключи и скачанные библиотеки не трогает.
#
#   ./scripts/clean-disk.sh                     # проверка: что и сколько (ничего не удаляет)
#   ./scripts/clean-disk.sh --apply             # удалить артефакты сборки
#   ./scripts/clean-disk.sh --apply --release   # плюс target/release (готовый AppImage)
#
# По умолчанию: target/debug, Rust-сборки под четыре Android-ABI,
# src-tauri/gen/android, node_modules, build/, tmp/, TMP/, test-results/,
# playwright-report/.
#
# Никогда не удаляется: src-tauri/binaries/ (libstatus.so, libsds.so,
# status-backend), src-tauri/android/ (Kotlin-исходники), src-tauri/src/core/,
# src-tauri/status-go/, src-tauri/icons/, любой путь вне репозитория.
#
# После удаления gen/android перед сборкой APK:
#   npx tauri android init && ./scripts/sync-android-native.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

APPLY=0
RELEASE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --apply)   APPLY=1 ;;
    --release) RELEASE=1 ;;
    -h|--help) sed -n '2,18p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "ERROR: неизвестный аргумент: $1" >&2; exit 1 ;;
  esac
  shift
done

PROTECTED=(
  "$ROOT/src-tauri/binaries"
  "$ROOT/src-tauri/android"
  "$ROOT/src-tauri/src/core"
  "$ROOT/src-tauri/status-go"
  "$ROOT/src-tauri/icons"
)

TARGETS=()
add() { TARGETS+=("$1|$2"); }

add "$ROOT/src-tauri/target/debug"                   "отладочные сборки Rust"
add "$ROOT/src-tauri/target/aarch64-linux-android"   "Rust Android arm64"
add "$ROOT/src-tauri/target/x86_64-linux-android"    "Rust Android x86_64"
add "$ROOT/src-tauri/target/armv7-linux-androideabi" "Rust Android armv7"
add "$ROOT/src-tauri/target/i686-linux-android"      "Rust Android x86"
add "$ROOT/src-tauri/gen/android"                    "сгенерированный Android-проект"
add "$ROOT/node_modules"                             "зависимости фронтенда"
add "$ROOT/build"                                    "сборка viewer'а документации"
add "$ROOT/test-results"                             "отчёт Playwright"
add "$ROOT/playwright-report"                        "отчёт Playwright (HTML)"
add "$ROOT/tmp"                                      "временные файлы"
add "$ROOT/TMP"                                      "временные файлы"

if [[ "$RELEASE" -eq 1 ]]; then
  add "$ROOT/src-tauri/target/release" "release-сборка и AppImage"
fi

# Три условия допуска к удалению: путь внутри репозитория, не корень проекта,
# и он не содержит ни одного защищённого пути.
is_safe_to_delete() {
  local path="$1" p
  case "$path" in
    ""|"/"|"$HOME") return 1 ;;
    "$ROOT"|"$ROOT/"*) ;;
    *) return 1 ;;
  esac
  [[ "$path" != "$ROOT" ]] || return 1
  for p in "${PROTECTED[@]}"; do
    case "$p" in
      "$path"|"$path"/*) return 1 ;;
    esac
  done
  return 0
}

bytes_of() {
  local total=0 path
  for path in "$@"; do
    [[ -e "$path" ]] || continue
    total=$((total + $(du -sb "$path" 2>/dev/null | cut -f1 || echo 0)))
  done
  echo "$total"
}

human() {
  if command -v numfmt >/dev/null 2>&1; then
    numfmt --to=iec --suffix=B "$1"
  else
    echo "$(( $1 / 1024 / 1024 ))MB"
  fi
}

RUNNING=""
for p in stauri-app tauri-app cargo rustc; do
  pgrep -x "$p" >/dev/null 2>&1 && RUNNING="$RUNNING $p"
done
if [[ -n "$RUNNING" ]]; then
  echo "ВНИМАНИЕ: запущено:$RUNNING" >&2
  if [[ "$APPLY" -eq 1 ]]; then
    echo "ERROR: закройте приложение и дождитесь конца сборки, затем повторите." >&2
    exit 1
  fi
fi

EXISTING=()
echo "=== Очистка артефактов Stauri ==="
echo "Репозиторий: $ROOT"
[[ "$APPLY" -eq 1 ]] || echo "Режим: проверка (--apply удаляет)"
echo
printf '  %-12s %s\n' "РАЗМЕР" "ЧТО"

for entry in "${TARGETS[@]}"; do
  path="${entry%%|*}"
  label="${entry#*|}"
  if ! is_safe_to_delete "$path"; then
    printf '  %-12s %s — ПРОПУЩЕН (защищённый путь)\n' "—" "$label"
  elif [[ ! -e "$path" ]]; then
    printf '  %-12s %s — нет\n' "—" "$label"
  else
    EXISTING+=("$path")
    printf '  %-12s %s\n' "$(du -sh "$path" 2>/dev/null | cut -f1)" "$label"
    printf '  %-12s %s\n' "" "$path"
  fi
done

if [[ ${#EXISTING[@]} -eq 0 ]]; then
  echo
  echo "Удалять нечего."
  exit 0
fi

echo
echo "Итого: $(human "$(bytes_of "${EXISTING[@]}")") в ${#EXISTING[@]} путях"

if [[ "$APPLY" -ne 1 ]]; then
  echo
  echo "Это проверка: ничего не удалено. Запустите с --apply."
  exit 0
fi

AVAIL_BEFORE="$(df --output=avail "$ROOT" 2>/dev/null | tail -1 | tr -d ' ' || echo 0)"

echo
for path in "${EXISTING[@]}"; do
  # Повторная проверка прямо перед удалением: список ничто не должно
  # расширить между показом и выполнением.
  if ! is_safe_to_delete "$path"; then
    echo "  ПРОПУСК (не прошёл проверку): $path" >&2
    continue
  fi
  printf '  удаляю %s\n' "$path"
  rm -rf -- "$path"
done

AVAIL_AFTER="$(df --output=avail "$ROOT" 2>/dev/null | tail -1 | tr -d ' ' || echo 0)"
echo
echo "Готово. Освобождено: $(human $(( (AVAIL_AFTER - AVAIL_BEFORE) * 1024 )))"

case " ${EXISTING[*]} " in
  *"$ROOT/src-tauri/gen/android"*)
    echo
    echo "gen/android удалён. Перед сборкой APK:"
    echo "  npx tauri android init && ./scripts/sync-android-native.sh"
    ;;
esac
