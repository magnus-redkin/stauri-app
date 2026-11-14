#!/usr/bin/env bash
# reset-test-clients.sh — очистка тестовых клиентов для чистого прогона.
#
#   SIM — Status Desktop (каталог данных по умолчанию: data_for_sim)
#   SA  — Stauri Android (телефон, pm clear)
#   SD  — Stauri Desktop (каталоги данных приложения)
#
# Использование (из stauri-app/):
#   ./scripts/reset-test-clients.sh              # очистить все три
#   ./scripts/reset-test-clients.sh SA SD        # только выбранные
#   ./scripts/reset-test-clients.sh --dry-run    # только показать, что будет сделано
#
# Переопределить каталог SIM: SIM_DIR=/путь ./scripts/reset-test-clients.sh SIM
#
# ВНИМАНИЕ: удаление необратимо, архивации нет. Очищается всё: профили, ключи,
# контакты, чаты, логи. Для проверки перед запуском используйте --dry-run.

set -euo pipefail

ADB="${ADB:-$HOME/Android/sdk/platform-tools/adb}"
APP_ID="com.magnus.stauri_app"
SD_DIRS=("$HOME/.local/share/com.magnus.stauri-app" "$HOME/.config/com.magnus.stauri-app")
SIM_DIR="${SIM_DIR:-/home/michael/ETH/ImStatus/data_for_sim}"

DRY=0
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    SIM|SA|SD) TARGETS+=("$arg") ;;
    *) echo "неизвестный аргумент: $arg (допустимо: SIM SA SD --dry-run)" >&2; exit 1 ;;
  esac
done
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(SIM SA SD)
fi

has() { local t; for t in "${TARGETS[@]}"; do [[ "$t" == "$1" ]] && return 0; done; return 1; }
say()  { echo "  $*"; }
head_() { echo; echo "=== $* ==="; }

# Остановить процессы клиента перед удалением его данных.
stop_procs() {
  local pattern="$1" label="$2"
  local pids; pids="$(pgrep -f "$pattern" || true)"
  if [[ -z "$pids" ]]; then say "$label: не запущен"; return; fi
  if (( DRY )); then
    say "$label: будет остановлен (pid: $(echo $pids | tr '\n' ' '))"
  else
    kill $pids 2>/dev/null || true
    sleep 2
    say "$label: остановлен"
  fi
}

remove_dir() {
  local dir="$1"
  if [[ ! -e "$dir" ]]; then say "нет, пропускаю: $dir"; return; fi
  local size; size="$(du -sh "$dir" 2>/dev/null | cut -f1)"
  if (( DRY )); then
    say "удалю: $dir ($size)"
  else
    rm -rf "$dir"
    say "удалён: $dir ($size)"
  fi
}

echo "Очистка: ${TARGETS[*]}$( (( DRY )) && echo ' — ПРОВЕРКА, ничего не меняется')"

if has SIM; then
  head_ "SIM — Status Desktop"
  stop_procs "nim_status_client|StatusIm-Desktop" "SIM"
  remove_dir "$SIM_DIR"
fi

if has SA; then
  head_ "SA — Stauri Android"
  if ! "$ADB" devices | grep -q "device$"; then
    say "телефон не подключён: пропускаю"
  elif (( DRY )); then
    say "будет выполнено: pm clear $APP_ID"
  else
    "$ADB" shell am force-stop "$APP_ID" || true
    "$ADB" shell pm clear "$APP_ID"
    say "данные приложения очищены (pm clear)"
  fi
fi

if has SD; then
  head_ "SD — Stauri Desktop"
  stop_procs "target/debug/tauri-app|/tauri-app$" "приложение"
  stop_procs "status-backend -address" "status-backend"
  for d in "${SD_DIRS[@]}"; do remove_dir "$d"; done
fi

echo
if (( DRY )); then
  echo "Проверка завершена. Для выполнения запустите без --dry-run."
else
  echo "Готово."
fi
