#!/usr/bin/env bash
# clean-env.sh — runs a build against an empty data directory.
#
#   ./scripts/clean-env.sh /tmp/upd-check/beta.AppImage
#   ./scripts/clean-env.sh /tmp/upd-check/beta.AppImage --keep-dir /tmp/stauri-clean-1
#
# Why: the profile (keys, databases, chats) lives in the application data
# directory. A release build started as-is picks up the real profile and
# password, so the release check would run against real data. The script points
# the build at its own directories via STAURI_DATA_DIR / STAURI_CONFIG_DIR (see
# src-tauri/src/appdirs.rs), which leaves the main profile untouched while the
# real login and profile-creation code stays in the build.
#
# Default directories: /tmp/stauri-clean/<build name>-<time>. They survive the
# application exiting, because the profile is needed to test a second login.
# Remove them with: rm -rf /tmp/stauri-clean/<name>.
#
# XDG_* variables: the AppImage creates ~/.local/share/<id>/... only when
# STAURI_DATA_DIR is unset, so it is always set here.

set -euo pipefail

APP="${1:-}"
shift || true
KEEP_DIR=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --keep-dir)
      KEEP_DIR="${2:?--keep-dir требует путь}"
      shift 2
      ;;
    *)
      echo "неизвестный аргумент: $1" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$APP" ]]; then
  echo "Usage: $0 <путь к AppImage> [--keep-dir <каталог>]" >&2
  exit 1
fi
if [[ ! -f "$APP" ]]; then
  echo "ERROR: нет файла: $APP" >&2
  exit 1
fi
if [[ ! -x "$APP" ]]; then
  chmod +x "$APP" 2>/dev/null || { echo "ERROR: файл не исполняемый: $APP" >&2; exit 1; }
fi

BASE="$KEEP_DIR"
if [[ -z "$BASE" ]]; then
  BASE="/tmp/stauri-clean/$(basename "$APP" .AppImage)-$(date +%Y%m%d-%H%M%S)"
fi
DATA="$BASE/data"
CONFIG="$BASE/config"
mkdir -p "$DATA" "$CONFIG"

echo "Чистое окружение:"
echo "  данные:  $DATA"
echo "  конфиг:  $CONFIG"
echo "  профиль будет пустым: при первом запуске создайте новый."
echo

STAURI_DATA_DIR="$DATA" STAURI_CONFIG_DIR="$CONFIG" exec "$APP"
