#!/usr/bin/env bash
# chat.sh — a direct chat between two nodes: login, contact, message and reply.
#
#   ./tests/integration/chat.sh
#
# Checks:
#   1. Both profiles are created and log in (messenger running).
#   2. A sends a contact request to B's key, B accepts, the contact is mutual on
#      both sides.
#   3. A messages B — B sees it.
#   4. B replies to A — A sees the reply.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

A_PORT=$BASE_PORT
B_PORT=$((BASE_PORT + 1))

step "1. Логин двух профилей"
new_profile "Chat-A" "$A_PORT"
new_profile "Chat-B" "$B_PORT"
ok "профили A и B созданы и вошли"

step "2. Контакт: A → B"
add_contact "$A_PORT" "$B_PORT"
A_KEY="$(pubkey "$A_PORT")"
B_KEY="$(pubkey "$B_PORT")"

step "3. A пишет B"
MSG_A="chat-A-$RUN: привет от A"
send "$A_PORT" "$B_KEY" "$MSG_A" >/dev/null || fail "A не отправил сообщение"
wait_until "$TIMEOUT" texts_visible "$B_PORT" "$A_KEY" "$MSG_A" \
  || fail "B не получил сообщение от A за $TIMEOUT с"
ok "B получил сообщение от A"

step "4. B отвечает A"
MSG_B="chat-B-$RUN: ответ от B"
send "$B_PORT" "$A_KEY" "$MSG_B" >/dev/null || fail "B не отправил ответ"
wait_until "$TIMEOUT" texts_visible "$A_PORT" "$B_KEY" "$MSG_B" \
  || fail "A не получил ответ от B за $TIMEOUT с"
ok "A получил ответ от B"

report_summary
echo "PASSED"
