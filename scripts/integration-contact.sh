#!/usr/bin/env bash
# integration-contact.sh — сквозная проверка приглашения в контакты на двух нодах.
#
# НЕ входит в `pnpm test`: нужен настоящий status-backend, сеть и время на
# доставку через Waku. Запускать отдельно:
#
#   ./scripts/integration-contact.sh
#
# Что проверяет:
#   1. Две ноды с разными каталогами и портами, в каждой новый профиль.
#   2. Нода A берёт свой compressedKey (как «Invite a contact»).
#   3. Нода B отправляет заявку на этот ключ (как Join by invite).
#   4. Ждёт на A входящую заявку и принимает её.
#   5. Проверяет на обеих сторонах mutual=true.
#
# Шаги 1–3 и 5 детерминированы. Шаг 4 зависит от доставки через Waku:
# таймаут 120 с, при неудаче — понятное сообщение, а не падение.

set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKEND="$ROOT/src-tauri/binaries/status-backend-x86_64-unknown-linux-gnu"
LIBS="$ROOT/src-tauri/binaries"
PORT_A="${PORT_A:-34501}"
PORT_B="${PORT_B:-34502}"
PASSWORD="${PASSWORD:-integration-pass-123}"
TIMEOUT="${TIMEOUT:-120}"

if [[ ! -x "$BACKEND" ]]; then
  echo "ERROR: нет $BACKEND (см. docs/BUILDING.md)" >&2
  exit 1
fi

WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

step() { echo; echo "=== $* ==="; }
fail() { echo "FAIL: $*" >&2; exit 1; }

# rpc <port> <method> [params-json] — один вызов CallRPC через status-backend.
rpc() {
  local port="$1" method="$2" params="${3:-[]}"
  curl -s -m 20 -X POST "http://127.0.0.1:$port/statusgo/CallRPC" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}"
}

# direct <port> <endpoint> <json> — прямой эндпоинт status-backend
# (InitializeApplication, CreateAccountAndLogin и т. п. — не методы CallRPC).
direct() {
  local port="$1" endpoint="$2" body="$3"
  curl -s -m 120 -X POST "http://127.0.0.1:$port/statusgo/$endpoint" \
    -H 'Content-Type: application/json' -d "$body"
}

# json <port> <method> <python-expr> — значение из result ответа.
json() {
  local port="$1" method="$2" expr="$3" params="${4:-[]}"
  rpc "$port" "$method" "$params" | python3 -c "
import json, sys
d = json.load(sys.stdin)
if d.get('error'):
    sys.exit('rpc error: ' + json.dumps(d['error'], ensure_ascii=False))
r = d.get('result')
print($expr)
"
}

# account <name> <port> <dir> — создаёт профиль и ждёт входа.
account() {
  local name="$1" port="$2" dir="$3"
  mkdir -p "$dir"
  local body
  body=$(python3 - "$dir" "$PASSWORD" "$name" "$port" <<'PY'
import json, sys
root, password, name, port = sys.argv[1:5]
print(json.dumps({
    "rootDataDir": root,
    "kdfIterations": 1024,
    "displayName": name,
    "password": password,
    "customizationColor": "primary",
    "thirdpartyServicesEnabled": True,
    "statusProxyStageName": "prod",
    # Отдельный путь к логу: иначе две ноды пишут в один файл.
    "logFilePath": f"{root}/status.log",
    "logLevel": "ERROR",
}))
PY
)
  direct "$port" "InitializeApplication" \
    "$(python3 -c "import json,sys;print(json.dumps({'dataDir':sys.argv[1],'rootDataDir':sys.argv[1],'networkId':1}))" "$dir")" >/dev/null
  local res
  res="$(direct "$port" "CreateAccountAndLogin" "$body")"
  echo "$res" | python3 -c "
import json,sys
d=json.load(sys.stdin)
e=(d.get('result') or {}).get('error') if isinstance(d.get('result'),dict) else None
if e: sys.exit('create account: '+str(e))
" || fail "не удалось создать профиль $name"
}

# wait_login <port> — ждёт, пока нода отдаст key-uid, и запускает мессенджер.
# Без startMessenger `wakuext_sendContactRequest` падает с «method handler crashed».
wait_login() {
  local port="$1" deadline=$((SECONDS + TIMEOUT))
  while (( SECONDS < deadline )); do
    if [[ -n "$(json "$port" settings_getSettings "r.get('key-uid') or ''" 2>/dev/null)" ]]; then
      json "$port" "wakuext_startMessenger" "'started'" >/dev/null 2>&1 || true
      # Мессенджер поднимается фоном: даём ему время открыть чаты.
      local ready=$((SECONDS + 30))
      while (( SECONDS < ready )); do
        if json "$port" "wakuext_chats" "'ok'" >/dev/null 2>&1; then return 0; fi
        sleep 2
      done
      return 0
    fi
    sleep 2
  done
  return 1
}

# start_node <port> <dir>
start_node() {
  local port="$1" dir="$2"
  mkdir -p "$dir"
  LD_LIBRARY_PATH="$LIBS" "$BACKEND" -address "127.0.0.1:$port" \
    >"$dir/node.out" 2>&1 &
  PIDS+=($!)
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if rpc "$port" "wakuext_version" >/dev/null 2>&1; then return 0; fi
    sleep 0.5
  done
  fail "нода на порту $port не поднялась"
}

step "1/5. Ноды"
start_node "$PORT_A" "$WORK/a"
start_node "$PORT_B" "$WORK/b"
echo "A: $PORT_A, B: $PORT_B, данные в $WORK"

step "2/5. Профили"
account "Node A" "$PORT_A" "$WORK/a"
account "Node B" "$PORT_B" "$WORK/b"
wait_login "$PORT_A" || fail "A не вошла"
wait_login "$PORT_B" || fail "B не вошла"
KEY_A="$(json "$PORT_A" settings_getSettings "r.get('compressedKey') or ''")"
KEY_A_HEX="$(json "$PORT_A" settings_getSettings "r.get('public-key') or ''")"
echo "A compressedKey: ${KEY_A:0:20}…"

step "3/5. B отправляет заявку на ключ A"
rpc "$PORT_B" "wakuext_sendContactRequest" \
  "[$(python3 -c "import json,sys;print(json.dumps({'id':sys.argv[1],'message':'integration test'}))" "$KEY_A")]" \
  | python3 -c "
import json,sys
d=json.load(sys.stdin)
if d.get('error'): sys.exit('sendContactRequest: '+json.dumps(d['error'],ensure_ascii=False))
print('  заявка отправлена')
" || fail "заявка не отправилась"

step "4/5. A ждёт и принимает заявку (доставка через Waku, до ${TIMEOUT} с)"
deadline=$((SECONDS + TIMEOUT))
FOUND=""
while (( SECONDS < deadline )); do
  FOUND="$(json "$PORT_A" "wakuext_contacts" "([c['id'] for c in (r or []) if c.get('contactRequestRemoteState')==3 and c.get('contactRequestLocalState')!=2] or [''])[0]" 2>/dev/null || true)"
  [[ -n "$FOUND" ]] && break
  sleep 3
done
if [[ -z "$FOUND" ]]; then
  echo "FAIL: заявка не дошла за ${TIMEOUT} с. Это доставка Waku, а не формат" >&2
  echo "      (отправка и разбор ключа проверены на шаге 3). Повторите позже." >&2
  exit 2
fi
echo "  входящая заявка от: ${FOUND:0:20}…"
rpc "$PORT_A" "wakuext_acceptLatestContactRequestForContact" \
  "[$(python3 -c "import json,sys;print(json.dumps({'id':sys.argv[1]}))" "$FOUND")]" >/dev/null

step "5/5. Проверка mutual на обеих сторонах"
check_mutual() {
  local port="$1" peer="$2" label="$3"
  local deadline=$((SECONDS + 60)) ok=""
  while (( SECONDS < deadline )); do
    ok="$(json "$port" "wakuext_contacts" "([c.get('mutual') for c in (r or []) if c.get('id')=='$peer'] or [False])[0]" 2>/dev/null || true)"
    [[ "$ok" == "True" ]] && { echo "  $label: mutual"; return 0; }
    sleep 3
  done
  echo "  $label: mutual=$ok"
  return 1
}
KEY_B="$(json "$PORT_B" settings_getSettings "r.get('public-key') or ''")"
MUTUAL_OK=0
check_mutual "$PORT_A" "$KEY_B" "A видит B" || MUTUAL_OK=1
check_mutual "$PORT_B" "$KEY_A_HEX" "B видит A" || MUTUAL_OK=1

echo
if (( MUTUAL_OK != 0 )); then
  echo "=== НЕ ПРОЙДЕНО ===" >&2
  echo "Заявка доставлена и принята, но mutual не подтверждён на обеих сторонах." >&2
  echo "Скорее всего, синк ещё идёт. Повторите запуск." >&2
  exit 1
fi
echo "=== Готово: mutual подтверждён ==="
echo "Логи нод: $WORK/a/node.out, $WORK/b/node.out (удаляются при выходе)"
