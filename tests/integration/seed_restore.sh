#!/usr/bin/env bash
# seed_restore.sh — a profile restored from its seed phrase is the same profile.
#
#   ./tests/integration/seed_restore.sh
#
# Checks:
#   1. Profile A is created; its seed phrase (mnemonic) and keys are read.
#   2. A second, empty node restores the account from that phrase
#      (RestoreAccountAndLogin) and logs in.
#   3. Restored node has the same key-uid, public key and first wallet address.
#   4. The restored messenger starts.
#
# Local only: no money moves, no network fees. Needs the Waku fleet for the
# messenger step, like the other integration tests.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

A_PORT=$BASE_PORT
R_PORT=$((BASE_PORT + 1))
R_NAME="Restore-B"

step "1. Профиль A: seed-фраза и ключи"
new_profile "Seed-A" "$A_PORT"
MNEMONIC="$(call "$A_PORT" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("mnemonic") or "")')"
[[ -n "$MNEMONIC" ]] || fail "у профиля A нет seed-фразы в настройках"
WORDS=$(printf '%s' "$MNEMONIC" | wc -w)
[[ "$WORDS" -eq 12 ]] || fail "seed-фраза из $WORDS слов, ожидалось 12"
A_KEY_UID="$(call "$A_PORT" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("key-uid") or "")')"
A_PUB="$(pubkey "$A_PORT")"
A_ADDR="$(first_address "$A_PORT")"
ok "A: 12 слов, key-uid ${A_KEY_UID:0:12}…, адрес ${A_ADDR:0:10}…"

step "2. Чистый узел B: восстановление по seed-фразе"
start_node "$R_PORT" "$WORK/$R_NAME"
mkdir -p "$WORK/$R_NAME/data"
direct "$R_PORT" InitializeApplication \
  "{\"dataDir\":\"$WORK/$R_NAME/data\",\"rootDataDir\":\"$WORK/$R_NAME/data\",\"networkId\":1}" >/dev/null
RBODY=$(json_arg "{
  'mnemonic': '$MNEMONIC',
  'rootDataDir': '$WORK/$R_NAME/data', 'kdfIterations': 1024, 'displayName': '$R_NAME',
  'password': '$PASSWORD', 'customizationColor': 'primary',
  'thirdpartyServicesEnabled': True, 'statusProxyStageName': 'prod',
  'logFilePath': '$WORK/$R_NAME/status.log', 'logLevel': 'ERROR'}")
RES="$(direct "$R_PORT" RestoreAccountAndLogin "$RBODY")"
RERR="$(python3 -c '
import json, sys
d = json.loads(sys.argv[1])
r = d.get("result") if isinstance(d.get("result"), dict) else d
print(r.get("error") or "")' "$RES")"
[[ -z "$RERR" ]] || fail "восстановление не удалось: $RERR"
wait_until "$TIMEOUT" settings_key_ready "$R_PORT" || fail "восстановленный профиль не вошёл за $TIMEOUT с"
ok "B: восстановление и вход выполнены"

step "3. Совпадение ключей и адреса"
B_KEY_UID="$(call "$R_PORT" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("key-uid") or "")')"
B_PUB="$(pubkey "$R_PORT")"
B_ADDR="$(first_address "$R_PORT")"
[[ "$A_KEY_UID" == "$B_KEY_UID" ]] || fail "key-uid различается: $A_KEY_UID ≠ $B_KEY_UID"
ok "key-uid совпадает"
[[ "$A_PUB" == "$B_PUB" ]] || fail "public key различается"
ok "public key совпадает"
[[ "$A_ADDR" == "$B_ADDR" ]] || fail "адрес кошелька различается: $A_ADDR ≠ $B_ADDR"
ok "адрес кошелька совпадает (${B_ADDR:0:10}…)"

step "4. Мессенджер восстановленного профиля"
call "$R_PORT" wakuext_startMessenger >/dev/null 2>&1 || true
wait_until 60 call "$R_PORT" wakuext_chats || fail "мессенджер восстановленного профиля не запустился"
ok "мессенджер запущен"

report_summary
echo "PASSED"
