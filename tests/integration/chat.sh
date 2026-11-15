#!/usr/bin/env bash
# chat.sh — личный чат на двух нодах: логин, контакт, сообщение и ответ.
#
#   ./tests/integration/chat.sh
#
# Проверяет:
#   1. Оба профиля создаются и входят (мессенджер запущен).
#   2. A отправляет заявку в контакты по ключу B, B принимает, контакт mutual на обеих сторонах.
#   3. A пишет сообщение B — B его видит.
#   4. B отвечает A — A видит ответ.

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
