#!/usr/bin/env bash
# lib.sh — общий код интеграционных тестов (chat, channel, wallet, contact).
#
# Подключается из тестов: `source "$(dirname "$0")/lib.sh"`.
# Работает с настоящим status-backend: нужна сеть (Waku-флот) и время на доставку.
#
# Переменные окружения:
#   BASE_PORT  — первый порт нод (нода i слушает BASE_PORT+i), по умолчанию 34500
#   TIMEOUT    — ожидание доставки, сек (по умолчанию 120)
#   PASSWORD   — пароль всех тестовых профилей
#   KEEP=1     — не удалять рабочий каталог с логами нод после прогона

set -uo pipefail

INT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$INT_DIR/../.." && pwd)"
BACKEND="$ROOT/src-tauri/binaries/status-backend-x86_64-unknown-linux-gnu"
LIBS="$ROOT/src-tauri/binaries"
BASE_PORT="${BASE_PORT:-34500}"
TIMEOUT="${TIMEOUT:-120}"
PASSWORD="${PASSWORD:-integration-pass-123}"
RUN="$(date +%H%M%S)"   # уникальный суффикс: тексты и имена каналов не совпадут с прошлым прогоном

WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  if [[ -n "${KEEP:-}" ]]; then echo "логи: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

[[ -x "$BACKEND" ]] || { echo "нет $BACKEND (см. docs/BUILDING.md)" >&2; exit 1; }

PASSED=0
step() { echo; echo "=== $* ==="; }
ok()   { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
fail() { echo "  ✗ $*" >&2; echo "FAILED"; exit 1; }

# call <port> <method> [params-json] — CallRPC; печатает result как JSON.
# RPC-ошибка → ненулевой код и текст ошибки в stderr.
call() {
  local port="$1" method="$2" params="${3:-[]}"
  curl -s -m 60 -X POST "http://127.0.0.1:$port/statusgo/CallRPC" \
    -H 'Content-Type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"$method\",\"params\":$params}" \
  | python3 -c '
import json, sys
d = json.load(sys.stdin)
if d.get("error"):
    sys.exit("rpc: " + json.dumps(d["error"], ensure_ascii=False))
print(json.dumps(d.get("result"), ensure_ascii=False))
'
}

# direct <port> <endpoint> <json-body> — прямой эндпоинт (InitializeApplication и т. п.).
direct() {
  curl -s -m 120 -X POST "http://127.0.0.1:$1/statusgo/$2" \
    -H 'Content-Type: application/json' -d "$3"
}

# pick <json> <python-expr> — выражение над переменной r (результат).
# Пример: pick "$res" "r.get('public-key')"
pick() {
  printf '%s' "$1" | python3 -c "
import json, sys
r = json.loads(sys.stdin.read())
print($2)
"
}

# json_arg <python-expr-builds-object…> — собирает JSON из python-выражения.
# Пример: json_arg "{'id': 'x', 'message': 'hi'}"
json_arg() { python3 -c "import json; print(json.dumps($1))"; }

# wait_until <сек> <команда…> — повторяет команду, пока она не вернёт 0.
wait_until() {
  local limit="$1"; shift
  local end=$((SECONDS + limit))
  while (( SECONDS < end )); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# start_node <port> <dir> — запускает status-backend и ждёт ответа.
start_node() {
  local port="$1" dir="$2"
  mkdir -p "$dir"
  LD_LIBRARY_PATH="$LIBS" "$BACKEND" -address "127.0.0.1:$port" >"$dir/node.out" 2>&1 &
  PIDS+=($!)
  wait_until 30 node_answers "$port" || fail "нода на порту $port не поднялась (лог: $dir/node.out)"
}

# node_answers <порт> — нода отвечает по HTTP (метод не важен: до входа RPC-методы
# мессенджера ещё недоступны и возвращают ошибку).
node_answers() {
  [[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$1/statusgo/CallRPC" \
    -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"settings_getSettings","params":[]}')" == "200" ]]
}

# new_profile <имя> <порт> — нода + новый профиль + вход + запуск мессенджера.
new_profile() {
  local name="$1" port="$2" dir="$WORK/$1"
  start_node "$port" "$dir"
  mkdir -p "$dir/data"
  direct "$port" InitializeApplication \
    "{\"dataDir\":\"$dir/data\",\"rootDataDir\":\"$dir/data\",\"networkId\":1}" >/dev/null
  local body
  body=$(json_arg "{
    'rootDataDir': '$dir/data', 'kdfIterations': 1024, 'displayName': '$name',
    'password': '$PASSWORD', 'customizationColor': 'primary',
    'thirdpartyServicesEnabled': True, 'statusProxyStageName': 'prod',
    'logFilePath': '$dir/status.log', 'logLevel': 'ERROR'}")
  local res
  res="$(direct "$port" CreateAccountAndLogin "$body")"
  local err
  err="$(python3 -c '
import json, sys
d = json.loads(sys.argv[1])
r = d.get("result") if isinstance(d.get("result"), dict) else d
print(r.get("error") or "")' "$res")"
  [[ -z "$err" ]] || fail "профиль $name не создан: $err"
  wait_until "$TIMEOUT" settings_key_ready "$port" || fail "профиль $name не вошёл за $TIMEOUT с"
  call "$port" wakuext_startMessenger >/dev/null 2>&1 || true
  wait_until 60 call "$port" wakuext_chats || fail "мессенджер $name не запустился"
}

# settings_key_ready <порт> — профиль вошёл: в настройках появился key-uid.
settings_key_ready() {
  [[ -n "$(call "$1" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("key-uid") or "")')" ]]
}

# pubkey <порт> — публичный ключ ноды (0x-hex, 04…).
pubkey() { call "$1" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("public-key") or "")'; }

# compressed_key <порт> — ключ в формате zQ3… (для «Invite a contact»).
compressed_key() { call "$1" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("compressedKey") or "")'; }

# first_address <порт> — первый кошельковый адрес профиля.
#
# Именно кошельковый: `accounts_getAccounts` отдаёт первым chat-аккаунт
# (`Chat: true`), а такой status-go исключает из подписей
# (`generateCommunityRequestsForSigning`), и заявка на вступление уходит пустой.
first_address() {
  call "$1" accounts_getAccounts | python3 -c '
import json, sys
accounts = json.load(sys.stdin) or []
wallet = [a for a in accounts if a.get("wallet") and not a.get("chat")]
print((wallet or accounts)[0]["address"] if accounts else "")'
}

# add_contact <порт-отправитель> <порт-получатель> — заявка и принятие, затем mutual на обеих сторонах.
add_contact() {
  local from="$1" to="$2"
  local key; key="$(compressed_key "$to")"
  call "$from" wakuext_sendContactRequest "[$(json_arg "{'id': '$key', 'message': 'integration test'}")]" >/dev/null \
    || fail "заявка $from → $to не отправлена"
  local to_hex; to_hex="$(pubkey "$to")"
  local from_hex; from_hex="$(pubkey "$from")"
  incoming_from() { call "$1" wakuext_contacts | python3 -c "
import json,sys
c=[x for x in json.load(sys.stdin) or [] if x.get('id')=='$2' and x.get('contactRequestRemoteState')==3]
sys.exit(0 if c else 1)"; }
  wait_until "$TIMEOUT" incoming_from "$to" "$from_hex" || fail "заявка от $from не дошла до $to за $TIMEOUT с"
  call "$to" wakuext_acceptLatestContactRequestForContact "[$(json_arg "{'id': '$from_hex'}")]" >/dev/null \
    || fail "$to не принял заявку"
  is_mutual() { call "$1" wakuext_contacts | python3 -c "
import json,sys
c=[x for x in json.load(sys.stdin) or [] if x.get('id')=='$2' and x.get('mutual')]
sys.exit(0 if c else 1)"; }
  wait_until 60 is_mutual "$from" "$to_hex" && wait_until 60 is_mutual "$to" "$from_hex" \
    || fail "контакт не стал mutual"
  ok "контакт: $from ↔ $to (mutual)"
}

# texts_visible <порт> <chatId> <текст…> — все тексты есть в ленте чата.
texts_visible() {
  local port="$1" chat="$2"; shift 2
  local params; params="$(json_arg "['$chat', '', 50]")"
  local res; res="$(call "$port" wakuext_chatMessages "$params")" || return 1
  # JSON передаём аргументом, а не по stdin: heredoc у python3 занял бы stdin.
  python3 -c '
import json, sys
data = json.loads(sys.argv[1])
wanted = sys.argv[2:]
texts = [m.get("text", "") for m in (data or {}).get("messages", [])]
sys.exit(0 if all(w in texts for w in wanted) else 1)
' "$res" "$@"
}

# send <порт> <chatId> <текст> [communityId] [responseTo] — отправка; печатает id сообщения.
send() {
  local port="$1" chat="$2" text="$3" community="${4:-}" reply="${5:-}"
  local body
  body=$(json_arg "{'id': '', 'chatId': '$chat', 'text': '$text', 'contentType': 1, 'communityId': '$community', 'responseTo': '$reply'}")
  call "$port" wakuext_sendChatMessage "[$body]" | python3 -c '
import json, sys
r = json.load(sys.stdin) or {}
msgs = r.get("messages") or []
print(msgs[0]["id"] if msgs else "")
'
}

# report_summary — итог прогона.
report_summary() {
  echo
  echo "=== ИТОГ: пройдено проверок: $PASSED ==="
}

# ---------------------------------------------------------------------------
# КАНАЛЫ (АКК: сообщество с одним каналом, см. docs/ru/akk_scheme.md)
# ---------------------------------------------------------------------------

# Kind → access: news открыт всем, request/issues — по заявке (channelKind.ts).
kind_access() {
  case "$1" in
    news) echo 1 ;;      # CommunityPermissions_AUTO_ACCEPT
    *)    echo 3 ;;      # CommunityPermissions_MANUAL_ACCEPT
  esac
}

# create_channel <порт> <имя> <kind> — создаёт сообщество с одним каналом.
# Печатает "<communityId> <chatId>" (chatId включает префикс сообщества).
create_channel() {
  local port="$1" name="$2" kind="$3"
  local desc="[$kind] integration-$RUN"
  local body
  body=$(json_arg "{
    'name': '$name', 'description': '$desc', 'color': '#4360DF', 'emoji': '',
    'membership': $(kind_access "$kind"), 'ensOnly': False,
    'image': '', 'imageAx': 0, 'imageAy': 0, 'imageBx': 0, 'imageBy': 0,
    'banner': {'imagePath': '', 'x': 0, 'y': 0, 'width': 0, 'height': 0}}")
  call "$port" wakuext_createCommunity "[$body]" | python3 -c '
import json, sys
r = json.load(sys.stdin) or {}
c = (r.get("communities") or [{}])[0]
ch = (r.get("chats") or [{}])[0]
print(c.get("id", ""), ch.get("id", ""))
'
}

# join_channel <порт-участника> <communityId> — вступает: подпись адреса + заявка.
# Пароль берётся из PASSWORD (в тесте он известен, в приложении его вводит человек).
join_channel() {
  local port="$1" cid="$2"
  local me addr
  me="$(pubkey "$port")"
  addr="$(first_address "$port")"
  [[ -n "$addr" ]] || { echo "нет адреса у профиля" >&2; return 1; }

  # Сообщество должно быть известно локально, иначе подпись и заявка не найдут его.
  call "$port" wakuext_fetchCommunity "[$(json_arg "{'communityKey': '$cid', 'tryDatabase': True, 'waitForResponse': True}")]" >/dev/null 2>&1 || true

  local to_sign; to_sign="$(call "$port" wakuext_generateJoiningCommunityRequestsForSigning \
    "[$(json_arg "'$me'"), $(json_arg "'$cid'"), $(json_arg "['$addr']")]")" || return 1

  local sign_params
  sign_params=$(printf '%s' "$to_sign" | python3 -c '
import json, sys
params = json.load(sys.stdin) or []
for p in params:
    p["password"] = sys.argv[1]
print(json.dumps([p for p in params if p.get("data")]))' "$PASSWORD")
  [[ "$sign_params" != "[]" ]] || { echo "нечего подписывать (watch-only адрес?)" >&2; return 1; }

  local signatures; signatures="$(call "$port" wakuext_signData "[$sign_params]")" || return 1

  local req
  req=$(json_arg "{
    'communityId': '$cid', 'ensName': '', 'addressesToReveal': ['$addr'],
    'signatures': $(printf '%s' "$signatures"), 'airdropAddress': '$addr',
    'shareFutureAddresses': False}")
  call "$port" wakuext_requestToJoinCommunity "[$req]" >/dev/null || return 1
}

# channel_ids <порт> <communityId> — "<communityId> <chatId>", если каналы видны.
channel_ids() {
  call "$1" wakuext_communities | python3 -c '
import json, sys
cid = sys.argv[1]
for c in json.load(sys.stdin) or []:
    if (c.get("id") or "").lower() == cid.lower():
        for ch in (c.get("chats") or {}):
            print(cid + ch)
            sys.exit(0)
sys.exit(1)' "$2"
}

# is_joined <порт> <communityId> — сообщество считается вступленным.
is_joined() {
  call "$1" wakuext_communities | python3 -c '
import json, sys
cid = sys.argv[1]
for c in json.load(sys.stdin) or []:
    if (c.get("id") or "").lower() == cid.lower() and c.get("joined"):
        sys.exit(0)
sys.exit(1)' "$2"
}

# accept_pending <порт-владельца> <communityId> — принимает все заявки на вступление.
accept_pending() {
  local port="$1" cid="$2" ids
  ids="$(call "$port" wakuext_pendingRequestsToJoinForCommunity "[$(json_arg "'$cid'")]" \
    | python3 -c 'import json,sys;print(" ".join(r.get("id","") for r in json.load(sys.stdin) or []))')" || return 1
  [[ -n "$ids" ]] || return 1
  local id
  for id in $ids; do
    call "$port" wakuext_acceptRequestToJoinCommunity "[$(json_arg "{'id': '$id'}")]" >/dev/null || return 1
  done
}

# wait_joined <порт> <communityId> <порт-владельца> — ждёт доступа.
# Для news (auto-accept) владелец принимает сам; для request/issues — здесь же
# владелец принимает заявку, как это делает человек в приложении.
wait_joined() {
  local port="$1" cid="$2" owner_port="$3"
  local end=$((SECONDS + TIMEOUT))
  while (( SECONDS < end )); do
    if is_joined "$port" "$cid"; then return 0; fi
    accept_pending "$owner_port" "$cid" >/dev/null 2>&1 || true
    sleep 3
  done
  return 1
}
