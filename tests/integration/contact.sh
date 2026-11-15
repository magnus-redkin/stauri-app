#!/usr/bin/env bash
# contact.sh — a contact invitation between two nodes.
#
#   ./tests/integration/contact.sh
#
# Checks:
#   1. Two nodes with separate directories and ports, a fresh profile in each.
#   2. A takes its compressedKey (as "Invite a contact" does).
#   3. B sends a request to that key (as Join by invite does).
#   4. A waits for the incoming request and accepts it.
#   5. mutual=true on both sides.
#
# Steps 1–3 and 5 are deterministic. Step 4 depends on delivery through Waku: it
# waits TIMEOUT and, on failure, reports a clear message instead of crashing.

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
# add_contact already checked mutual; this repeats it separately so that a
# failure here reads as a sync problem rather than a sending one.
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
