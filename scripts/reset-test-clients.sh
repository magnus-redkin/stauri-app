#!/usr/bin/env bash
# reset-test-clients.sh — wipes the test clients for a clean run.
#
#   SIM — Status Desktop (default data directory: data_for_sim)
#   SA  — Stauri.dev on the phone (the debug build, package `.dev`)
#   SA-REL — Stauri (release build) on the phone; clears the app that may hold real
#            money and an ENS name, so it is never part of the default targets
#   SD  — Stauri Desktop (application data directories)
#
# Usage (from stauri-app/):
#   ./scripts/reset-test-clients.sh              # wipe SIM, SA and SD
#   ./scripts/reset-test-clients.sh SA SD        # only the selected ones
#   ./scripts/reset-test-clients.sh --dry-run    # only show what would be done
#
# Override the SIM directory: SIM_DIR=/path ./scripts/reset-test-clients.sh SIM
#
# WARNING: deletion is irreversible, nothing is archived. Everything goes:
# profiles, keys, contacts, chats, logs. Use --dry-run to check beforehand.
#
# The release app and the dev app are separate packages on purpose: the dev build
# installs next to the release one with its own data directory, so wiping the test
# client cannot touch the profile that holds real funds.

set -euo pipefail

ADB="${ADB:-$HOME/Android/sdk/platform-tools/adb}"
# The release app may hold real money and an ENS name; only the explicit SA-REL target
# touches it.
APP_ID="com.magnus.stauri_app"
# The debug build: same application id with the `.dev` suffix set by
# sync-android-native.sh. This is the test client.
DEV_APP_ID="com.magnus.stauri_app.dev"
# Две сборки на телефоне с разными package id: релизная (может хранить реальные
# средства и ENS-имя) и dev (`.dev`, тестовая). Скрипт по умолчанию чистит только dev.
# Старый идентификатор `.debug` от прежней схемы тоже вычищается, если остался.
LEGACY_APP_IDS=("com.magnus.stauri_app.debug")
SD_DIRS=("$HOME/.local/share/com.magnus.stauri-app" "$HOME/.config/com.magnus.stauri-app")
SIM_DIR="${SIM_DIR:-/home/michael/ETH/ImStatus/data_for_sim}"

DRY=0
TARGETS=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY=1 ;;
    SIM|SA|SA-REL|SD) TARGETS+=("$arg") ;;
    *) echo "неизвестный аргумент: $arg (допустимо: SIM SA SA-REL SD --dry-run)" >&2; exit 1 ;;
  esac
done
if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=(SIM SA SD)
fi

has() { local t; for t in "${TARGETS[@]}"; do [[ "$t" == "$1" ]] && return 0; done; return 1; }
say()  { echo "  $*"; }
head_() { echo; echo "=== $* ==="; }

# stop_procs — stops the client's processes before its data is deleted.
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
  head_ "SA — Stauri.dev на телефоне"
  if ! "$ADB" devices | grep -q "device$"; then
    say "телефон не подключён: пропускаю"
  elif (( DRY )); then
    say "будет выполнено: pm clear $DEV_APP_ID"
    for legacy in "${LEGACY_APP_IDS[@]}"; do
      say "если установлен, будет очищен: pm clear $legacy"
    done
  else
    "$ADB" shell am force-stop "$DEV_APP_ID" || true
    "$ADB" shell pm clear "$DEV_APP_ID"
    say "данные Stauri.dev очищены (pm clear)"
    # A profile left behind by an old build is the reason a "clean" run showed the
    # wrong screen; clearing it is the whole point of the command.
    for legacy in "${LEGACY_APP_IDS[@]}"; do
      if "$ADB" shell pm path "$legacy" >/dev/null 2>&1; then
        "$ADB" shell am force-stop "$legacy" || true
        "$ADB" shell pm clear "$legacy" >/dev/null
        say "данные $legacy очищены"
      fi
    done
  fi
fi

if has SA-REL; then
  head_ "SA-REL — Stauri (release) на телефоне"
  # Explicit target: this app may hold real money and an ENS name.
  if ! "$ADB" devices | grep -q "device$"; then
    say "телефон не подключён: пропускаю"
  elif (( DRY )); then
    say "будет выполнено: pm clear $APP_ID"
  else
    "$ADB" shell am force-stop "$APP_ID" || true
    "$ADB" shell pm clear "$APP_ID"
    say "данные релизного приложения очищены (pm clear)"
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
