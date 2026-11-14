#!/usr/bin/env bash
# run.sh — метки начала и конца прогона сценария и сравнение трассировки.
#
#   ./tests/scenarios/run.sh start chat_sd_sim   # метка START в лог SD (имя сценария)
#   ... выполняете шаги сценария вручную ...
#   ./tests/scenarios/run.sh end                 # метка END с тем же именем
#   ./tests/scenarios/run.sh compare             # сверка лога и трассы с сценарием
#   ./tests/scenarios/run.sh list                # доступные сценарии
#
# Метки пишутся строкой в лог SD (формат как у остальных строк лога, с меткой
# времени в начале), поэтому compare.py сам находит имя сценария и окно прогона.
# Сценарий SA-части берётся из трассы телефона по тому же окну времени.

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG_DIR="$HOME/.local/share/com.magnus.stauri-app/logs"

current_log() {
  local f
  f="$(ls -1 "$LOG_DIR"/stauri.*.log 2>/dev/null | sort | tail -1 || true)"
  if [[ -z "$f" ]]; then
    echo "нет лога SD в $LOG_DIR (запустите Stauri Desktop)" >&2
    exit 2
  fi
  echo "$f"
}

mark() {
  # mark <START|END> <имя>
  local log now_iso now_unix
  log="$(current_log)"
  now_iso="$(date -u +%Y-%m-%dT%H:%M:%S.%6NZ)"
  now_unix="$(date +%s)"
  printf '%s  INFO frontend: [test] %s %s unix=%s\n' "$now_iso" "$1" "$2" "$now_unix" >> "$log"
  echo "метка $1 $2 записана в $(basename "$log") ($now_iso)"
}

cmd="${1:-}"
case "$cmd" in
  start)
    name="${2:?укажите имя сценария, например chat_sd_sim}"
    if [[ ! -f "$HERE/$name.md" ]]; then
      echo "нет сценария $HERE/$name.md" >&2
      exit 2
    fi
    mark START "$name"
    echo "Выполняйте шаги из $name.md. Затем: $0 end"
    ;;
  end)
    # Имя берём из последней метки START в логе.
    name="$(grep -o '\[test\] START [^ ]*' "$(current_log)" | tail -1 | awk '{print $3}')"
    if [[ -z "$name" ]]; then
      echo "нет метки START в логе — сначала: $0 start <сценарий>" >&2
      exit 2
    fi
    mark END "$name"
    echo "Теперь: $0 compare"
    ;;
  compare)
    python3 "$HERE/compare.py"
    ;;
  list)
    ls -1 "$HERE"/*.md | xargs -n1 basename | sed 's/\.md$//'
    ;;
  *)
    echo "использование: $0 {start <сценарий>|end|compare|list}" >&2
    exit 2
    ;;
esac
