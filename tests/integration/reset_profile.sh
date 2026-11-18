#!/usr/bin/env bash
# reset_profile.sh — the recovery screen's two paths on one device.
#
#   ./tests/integration/reset_profile.sh
#
# Checks:
#   1. Profile A is created; its seed phrase and key-uid are read.
#   2. ValidateMnemonicV2 derives the same key-uid as the local profile. That match
#      is what the app uses to tell "profile already here" from "first time here",
#      and what makes it log in instead of calling RestoreAccountAndLogin.
#   3. Logged out, RestoreAccountAndLogin with a new password is refused, because the
#      local database is encrypted with the old one. This is the situation the reset
#      offer exists for.
#   4. DeleteMultiaccount removes the local copy.
#   5. RestoreAccountAndLogin then succeeds: same key-uid and wallet address, new
#      password.
#
# Local only: no money moves, no network fees, no messenger. Needs only the library.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

A_PORT=$BASE_PORT
A_NAME="Reset-A"
NEW_PASSWORD="reset-pass-456"

# Extraction of the error of a direct endpoint reply.
error_of() {
  python3 -c '
import json, sys
d = json.loads(sys.argv[1])
r = d.get("result") if isinstance(d.get("result"), dict) else d
print(r.get("error") or "")' "$1"
}

step "1. Профиль A: seed-фраза и ключи"
start_node "$A_PORT" "$WORK/$A_NAME"
mkdir -p "$WORK/$A_NAME/data"
direct "$A_PORT" InitializeApplication \
  "{\"dataDir\":\"$WORK/$A_NAME/data\",\"rootDataDir\":\"$WORK/$A_NAME/data\",\"networkId\":1}" >/dev/null
CREATE_BODY=$(json_arg "{
  'rootDataDir': '$WORK/$A_NAME/data', 'kdfIterations': 1024, 'displayName': '$A_NAME',
  'password': '$PASSWORD', 'customizationColor': 'primary',
  'thirdpartyServicesEnabled': True, 'statusProxyStageName': 'prod',
  'logFilePath': '$WORK/$A_NAME/status.log', 'logLevel': 'ERROR'}")
CREATE_RES="$(direct "$A_PORT" CreateAccountAndLogin "$CREATE_BODY")"
[[ -z "$(error_of "$CREATE_RES")" ]] || fail "профиль A не создан: $(error_of "$CREATE_RES")"
wait_until "$TIMEOUT" settings_key_ready "$A_PORT" || fail "профиль A не вошёл за $TIMEOUT с"

SETTINGS="$(call "$A_PORT" settings_getSettings)"
MNEMONIC="$(pick "$SETTINGS" "r.get('mnemonic')")"
A_KEY_UID="$(pick "$SETTINGS" "r.get('key-uid')")"
A_ADDR="$(first_address "$A_PORT")"
[[ -n "$MNEMONIC" ]] || fail "у профиля A нет seed-фразы"
ok "A: key-uid ${A_KEY_UID:0:12}…, адрес ${A_ADDR:0:10}…"

step "2. ValidateMnemonicV2: та же фраза — тот же key-uid"
V_RES="$(direct "$A_PORT" ValidateMnemonicV2 "$(json_arg "{'mnemonic': '$MNEMONIC'}")")"
V_KEY_UID="$(pick "$V_RES" "r.get('keyUID')")"
[[ -n "$V_KEY_UID" ]] || fail "ValidateMnemonicV2 не вернул keyUID: $V_RES"
[[ "$V_KEY_UID" == "$A_KEY_UID" ]] \
  || fail "key-uid не совпадает: фраза даёт $V_KEY_UID, профиль — $A_KEY_UID"
ok "фраза опознаёт профиль (${V_KEY_UID:0:12}…)"
V_BAD="$(direct "$A_PORT" ValidateMnemonicV2 "$(json_arg "{'mnemonic': 'one two three'}")")"
# `keyUidFromMnemonic` in the app returns null on a non-empty `error`; the same
# condition is checked here, so a phrase of the wrong length cannot be mistaken for
# a profile on this device.
if python3 -c 'import json,sys
r = json.loads(sys.argv[1]) or {}
sys.exit(0 if not r.get("keyUID") else 1)' "$V_BAD"; then
  ok "неверная фраза keyUID не даёт"
else
  fail "неверная фраза дала keyUID: $V_BAD"
fi

step "3. Вход после выхода и отказ восстановления под новым паролем"
direct "$A_PORT" Logout '{}' >/dev/null
sleep 3
LOGIN_RES="$(direct "$A_PORT" LoginAccount "$(json_arg "{'password': '$PASSWORD', 'keyUid': '$A_KEY_UID', 'statusProxyStageName': 'prod'}")")"
[[ -z "$(error_of "$LOGIN_RES")" ]] || fail "повторный вход не удался: $(error_of "$LOGIN_RES")"
wait_until "$TIMEOUT" settings_key_ready "$A_PORT" || fail "повторный вход не завершился"
ok "повторный вход со старым паролем проходит"
direct "$A_PORT" Logout '{}' >/dev/null
sleep 3

RESTORE_BODY=$(json_arg "{
  'mnemonic': '$MNEMONIC',
  'rootDataDir': '$WORK/$A_NAME/data', 'kdfIterations': 1024, 'displayName': '$A_NAME',
  'password': '$NEW_PASSWORD', 'customizationColor': 'primary',
  'thirdpartyServicesEnabled': True, 'statusProxyStageName': 'prod',
  'logFilePath': '$WORK/$A_NAME/status.log', 'logLevel': 'ERROR'}")
RESTORE_RES="$(direct "$A_PORT" RestoreAccountAndLogin "$RESTORE_BODY")"
# The reply is NOT where the failure appears: status-go answers `{"error":""}` and
# reports the real reason later through the `node.login` signal (the app reads it
# there, in `waitForLogin`). So the check is the outcome — no login — not the text.
sleep 5
if wait_until 20 settings_key_ready "$A_PORT"; then
  fail "восстановление под новым паролем вошло в профиль — сценарий сброса не нужен"
fi
ok "восстановление под новым паролем профиль не открыло"
OK_ERR="$(error_of "$RESTORE_RES")"
[[ -z "$OK_ERR" ]] || fail "ожидался пустой ответ, пришло: $OK_ERR"
ok "ответ самого вызова пустой — причина приходит сигналом node.login"
# The old password must still work: that is what "the phrase cannot replace the local
# password" means, and it is why the reset offer deletes instead of retyping.
LOGIN_RES="$(direct "$A_PORT" LoginAccount "$(json_arg "{'password': '$PASSWORD', 'keyUid': '$A_KEY_UID', 'statusProxyStageName': 'prod'}")")"
[[ -z "$(error_of "$LOGIN_RES")" ]] || fail "старый пароль перестал работать: $(error_of "$LOGIN_RES")"
wait_until "$TIMEOUT" settings_key_ready "$A_PORT" || fail "вход со старым паролем не завершился"
ok "старый пароль по-прежнему открывает профиль"
direct "$A_PORT" Logout '{}' >/dev/null
sleep 3

step "4. DeleteMultiaccount удаляет локальную копию"
DEL_RES="$(direct "$A_PORT" DeleteMultiaccount "$(json_arg "{'keyUID': '$A_KEY_UID', 'keyStoreDir': '$WORK/$A_NAME/data/keystore/$A_KEY_UID'}")")"
DEL_ERR="$(error_of "$DEL_RES")"
[[ -z "$DEL_ERR" ]] || fail "удаление не удалось: $DEL_ERR"
[[ ! -d "$WORK/$A_NAME/data/keystore/$A_KEY_UID" ]] \
  || fail "каталог keystore профиля остался на месте"
ok "локальная копия удалена"

step "5. Восстановление после удаления: тот же профиль, новый пароль"
RESTORE_RES="$(direct "$A_PORT" RestoreAccountAndLogin "$RESTORE_BODY")"
RESTORE_ERR="$(error_of "$RESTORE_RES")"
[[ -z "$RESTORE_ERR" ]] || fail "восстановление после удаления не удалось: $RESTORE_ERR"
wait_until "$TIMEOUT" settings_key_ready "$A_PORT" || fail "восстановленный профиль не вошёл"
B_KEY_UID="$(call "$A_PORT" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("key-uid") or "")')"
B_ADDR="$(first_address "$A_PORT")"
[[ "$B_KEY_UID" == "$A_KEY_UID" ]] || fail "key-uid различается: $B_KEY_UID ≠ $A_KEY_UID"
ok "key-uid совпадает"
[[ "$B_ADDR" == "$A_ADDR" ]] || fail "адрес кошелька различается: $B_ADDR ≠ $A_ADDR"
ok "адрес кошелька совпадает (${B_ADDR:0:10}…) — деньги и профиль вернулись"

report_summary
echo "PASSED"
