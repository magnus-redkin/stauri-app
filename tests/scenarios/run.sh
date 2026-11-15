#!/usr/bin/env bash
# run.sh — start and end markers for a scenario run, and trace comparison.
#
#   ./tests/scenarios/run.sh start chat_sd_sim   # START marker in the SD log (scenario name)
#   ... perform the scenario steps by hand ...
#   ./tests/scenarios/run.sh end                 # END marker with the same name
#   ./tests/scenarios/run.sh compare             # compare log and trace with the scenario
#   ./tests/scenarios/run.sh list                # available scenarios
#
# Markers are written as a single log line (same format as the other SD log
# lines, with a timestamp in front), so compare.py finds the scenario name and
# the run window on its own. The SA part of the scenario is taken from the phone
# trace over the same time window.

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
  # mark <START|END> <name>
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
    # The name comes from the last START marker in the log.
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
