#!/usr/bin/env bash
# contact.sh — приглашение в контакты на двух нодах.
#
#   ./tests/integration/contact.sh
#
# Проверяет:
#   1. Две ноды с разными каталогами и портами, в каждой новый профиль.
#   2. A берёт свой compressedKey (как «Invite a contact»).
#   3. B отправляет заявку на этот ключ (как Join by invite).
#   4. A ждёт входящую заявку и принимает её.
#   5. На обеих сторонах mutual=true.
#
# Шаги 1–3 и 5 детерминированы. Шаг 4 зависит от доставки через Waku:
# таймаут TIMEOUT, при неудаче — понятное сообщение, а не падение.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

A_PORT=$BASE_PORT
B_PORT=$((BASE_PORT + 1))

step "1. Логин двух профилей"
new_profile "Contact-A" "$A_PORT"
new_profile "Contact-B" "$B_PORT"
ok "профили A и B созданы и вошли"

step "2. Ключ A для приглашения"
KEY_A="$(compressed_key "$A_PORT")"
[[ -n "$KEY_A" ]] || fail "у A нет compressedKey"
echo "  A compressedKey: ${KEY_A:0:20}…"

step "3. B отправляет заявку на ключ A, A принимает"
add_contact "$B_PORT" "$A_PORT"

step "4. Проверка mutual на обеих сторонах"
# add_contact уже проверил mutual; здесь дублируем отдельно, чтобы падение
# на этом шаге читалось как проблема синка, а не отправки.
KEY_A_HEX="$(pubkey "$A_PORT")"
KEY_B_HEX="$(pubkey "$B_PORT")"
is_mutual() { call "$1" wakuext_contacts | python3 -c "
import json,sys
c=[x for x in json.load(sys.stdin) or [] if x.get('id')=='$2' and x.get('mutual')]
sys.exit(0 if c else 1)"; }
wait_until 60 is_mutual "$A_PORT" "$KEY_B_HEX" || fail "A не видит B как mutual"
wait_until 60 is_mutual "$B_PORT" "$KEY_A_HEX" || fail "B не видит A как mutual"
ok "A видит B как mutual"
ok "B видит A как mutual"

report_summary
echo "PASSED"
