#!/usr/bin/env bash
# lib.sh — shared code for the integration tests (chat, channel, wallet, contact).
#
# Sourced from the tests: `source "$(dirname "$0")/lib.sh"`.
# Runs against the real libstatus: needs network (a Waku fleet) and time for
# delivery. Each "node" is a small HTTP facade (libstatus_node.py) over the
# library in its own process, so the tests drive the same code the application
# loads.
#
# Environment:
#   BASE_PORT  — first node port (node i listens on BASE_PORT+i), default 34500
#   TIMEOUT    — delivery wait, seconds (default 120)
#   PASSWORD   — password of every test profile
#   KEEP=1     — keep the working directory with node logs after the run

set -uo pipefail

INT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$INT_DIR/../.." && pwd)"
LIBSTATUS="$ROOT/src-tauri/binaries/libstatus.so"
FACADE="$INT_DIR/libstatus_node.py"
LIBS="$ROOT/src-tauri/binaries"
BASE_PORT="${BASE_PORT:-34500}"
TIMEOUT="${TIMEOUT:-120}"
PASSWORD="${PASSWORD:-integration-pass-123}"
# WARMUP — seconds after the messenger starts, before a node sends anything. A
# message sent before the node has relay peers is dropped silently: status-go
# logs "not enough peers to publish" and the RPC still returns success.
WARMUP="${WARMUP:-60}"
RUN="$(date +%H%M%S)"   # unique suffix: texts and channel names cannot collide with a previous run

WORK="$(mktemp -d)"
PIDS=()
cleanup() {
  for pid in "${PIDS[@]:-}"; do kill "$pid" 2>/dev/null; done
  wait 2>/dev/null
  if [[ -n "${KEEP:-}" ]]; then echo "логи: $WORK"; else rm -rf "$WORK"; fi
}
trap cleanup EXIT

[[ -f "$LIBSTATUS" ]] || { echo "нет $LIBSTATUS (см. docs/BUILDING.md)" >&2; exit 1; }

PASSED=0
step() { echo; echo "=== $* ==="; }
ok()   { echo "  ✓ $*"; PASSED=$((PASSED + 1)); }
fail() { echo "  ✗ $*" >&2; echo "FAILED"; exit 1; }

# call <port> <method> [params-json] — CallRPC; prints the result as JSON.
# An RPC error yields a non-zero exit and the error text on stderr.
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

# direct <port> <endpoint> <json-body> — a direct endpoint (InitializeApplication etc.).
direct() {
  curl -s -m 120 -X POST "http://127.0.0.1:$1/statusgo/$2" \
    -H 'Content-Type: application/json' -d "$3"
}

# pick <json> <python-expr> — evaluates an expression over the variable r (the result).
# Example: pick "$res" "r.get('public-key')"
pick() {
  printf '%s' "$1" | python3 -c "
import json, sys
r = json.loads(sys.stdin.read())
print($2)
"
}

# json_arg <python-expr-builds-object…> — builds JSON from a python expression.
# Example: json_arg "{'id': 'x', 'message': 'hi'}"
json_arg() { python3 -c "import json; print(json.dumps($1))"; }

# wait_until <sec> <command…> — repeats the command until it exits 0.
wait_until() {
  local limit="$1"; shift
  local end=$((SECONDS + limit))
  while (( SECONDS < end )); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}

# start_node <port> <dir> — starts the libstatus facade and waits for it to answer.
#
# The library needs `libsds.so` at runtime, hence LD_LIBRARY_PATH. Each node is
# its own process: two profiles in one process would share the library's global
# state, which only the application can do (it has exactly one profile per run).
start_node() {
  local port="$1" dir="$2"
  mkdir -p "$dir"
  LD_LIBRARY_PATH="$LIBS" STAURI_LIBSTATUS="$LIBSTATUS" \
    python3 "$FACADE" "127.0.0.1:$port" >"$dir/node.out" 2>&1 &
  PIDS+=($!)
  wait_until 60 node_answers "$port" || fail "нода на порту $port не поднялась (лог: $dir/node.out)"
}

# node_answers <port> — the node answers over HTTP (the method does not matter:
# before login the messenger RPC methods are unavailable and return an error).
node_answers() {
  [[ "$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$1/statusgo/CallRPC" \
    -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"settings_getSettings","params":[]}')" == "200" ]]
}

# new_profile <name> <port> — node, fresh profile, login, messenger start.
#
# Every run creates a new profile in its own empty data directory: a rerun then
# starts from a clean backend, and accounts, contacts or chats left by an earlier
# run cannot leak into the assertions.
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
  # No RPC reports relay peers, so the wait is a fixed delay (see WARMUP).
  sleep "$WARMUP"
}

# settings_key_ready <port> — the profile has logged in: settings now carry a key-uid.
settings_key_ready() {
  [[ -n "$(call "$1" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("key-uid") or "")')" ]]
}

# pubkey <port> — the node's public key (0x-hex, 04…).
pubkey() { call "$1" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("public-key") or "")'; }

# compressed_key <port> — the key in zQ3… form (what "Invite a contact" uses).
compressed_key() { call "$1" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("compressedKey") or "")'; }

# first_address <port> — the profile's first wallet address.
#
# It must be the wallet account: `accounts_getAccounts` lists the chat account
# (`chat: true`) first, and status-go skips that one when generating signing
# requests (`generateCommunityRequestsForSigning`), so a join request built from
# it goes out empty.
first_address() {
  call "$1" accounts_getAccounts | python3 -c '
import json, sys
accounts = json.load(sys.stdin) or []
wallet = [a for a in accounts if a.get("wallet") and not a.get("chat")]
print((wallet or accounts)[0]["address"] if accounts else "")'
}

# add_contact <sender-port> <receiver-port> — request and acceptance, then mutual on both sides.
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

# texts_visible <port> <chatId> <text…> — all the texts are present in the chat timeline.
texts_visible() {
  local port="$1" chat="$2"; shift 2
  local params; params="$(json_arg "['$chat', '', 50]")"
  local res; res="$(call "$port" wakuext_chatMessages "$params")" || return 1
  # Pass JSON as an argument, not on stdin: a heredoc into python3 would take over stdin.
  python3 -c '
import json, sys
data = json.loads(sys.argv[1])
wanted = sys.argv[2:]
texts = [m.get("text", "") for m in (data or {}).get("messages", [])]
sys.exit(0 if all(w in texts for w in wanted) else 1)
' "$res" "$@"
}

# send <port> <chatId> <text> [communityId] [responseTo] — sends; prints the message id.
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

# report_summary — the run's tally.
report_summary() {
  echo
  echo "=== ИТОГ: пройдено проверок: $PASSED ==="
}

# ---------------------------------------------------------------------------
# CHANNELS (a Stauri channel is a community with a single channel, see docs/ru/akk_scheme.md)
# ---------------------------------------------------------------------------

# kind_access — kind → access: news is open to all, request/issues go by request
# (channelKind.ts).
kind_access() {
  case "$1" in
    news) echo 1 ;;      # CommunityPermissions_AUTO_ACCEPT
    *)    echo 3 ;;      # CommunityPermissions_MANUAL_ACCEPT
  esac
}

# create_channel <port> <name> <kind> — creates a community with a single channel.
# Prints "<communityId> <chatId>" (the chatId carries the community prefix).
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

# join_channel <participant-port> <communityId> — joins: address signature plus request.
# The password comes from PASSWORD (the test knows it; in the application a person types it).
join_channel() {
  local port="$1" cid="$2"
  local me addr
  me="$(pubkey "$port")"
  addr="$(first_address "$port")"
  [[ -n "$addr" ]] || { echo "нет адреса у профиля" >&2; return 1; }

  # The community must be known locally, or signing and the request cannot find it.
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

# channel_ids <port> <communityId> — "<communityId> <chatId>" when channels are visible.
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

# is_joined <port> <communityId> — the community counts as joined.
is_joined() {
  call "$1" wakuext_communities | python3 -c '
import json, sys
cid = sys.argv[1]
for c in json.load(sys.stdin) or []:
    if (c.get("id") or "").lower() == cid.lower() and c.get("joined"):
        sys.exit(0)
sys.exit(1)' "$2"
}

# accept_pending <owner-port> <communityId> — accepts every pending join request.
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

# wait_joined <port> <communityId> <owner-port> — waits for access.
# For news (auto-accept) acceptance is automatic; for request/issues the owner
# accepts the request here, as a person would in the application.
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
