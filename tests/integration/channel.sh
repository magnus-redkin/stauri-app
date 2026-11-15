#!/usr/bin/env bash
# channel.sh — каналы трёх типов на двух нодах (см. src/lib/status/channelKind.ts).
#
#   ./tests/integration/channel.sh
#
# Типы канала:
#   news    — открытый: вступить может любой (auto-accept);
#   request — по заявке: посты пишет автор, комментируют вступившие;
#   issues  — по заявке: посты и комментарии пишут все вступившие.
#
# Порядок важен: сначала участник вступает, потом автор пишет посты. Иначе
# участник их не увидит — в этой сборке нет догоняющего запроса истории
# (`requestCommunityInfoFromMailserver` не существует), и сообщения,
# отправленные до вступления, до него не доходят.
#
# Проверяет для каждого типа:
#   1. Автор создаёт канал.
#   2. Участник вступает (для request/issues — с заявкой и Accept автора).
#   3. Автор пишет два поста, участник видит оба.
#   4. Участник оставляет комментарий к каждому, автор видит оба.
#   5. Для issues участник пишет ещё и свой пост, автор его видит.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

A_PORT=$BASE_PORT
B_PORT=$((BASE_PORT + 1))

step "1. Логин автора и участника"
new_profile "Chan-A" "$A_PORT"
new_profile "Chan-B" "$B_PORT"
ok "профили A (автор) и B (участник) созданы и вошли"

# replies_count <порт> <chatId> — сколько сообщений в ленте являются ответами.
replies_count() {
  call "$1" wakuext_chatMessages "$(json_arg "['$2', '', 50]")" | python3 -c '
import json, sys
msgs = (json.load(sys.stdin) or {}).get("messages", [])
print(sum(1 for m in msgs if m.get("responseTo")))'
}

check_kind() {
  local kind="$1" label="$2"
  step "Канал $kind ($label)"

  local ids cid chat
  ids="$(create_channel "$A_PORT" "$kind-$RUN" "$kind")" || fail "канал $kind не создан"
  cid="${ids%% *}"; chat="${ids##* }"
  [[ -n "$cid" && -n "$chat" ]] || fail "канал $kind: пустой ответ createCommunity ($ids)"
  ok "создан канал $kind ($label)"

  step "  $kind: вступление участника"
  join_channel "$B_PORT" "$cid" || fail "$kind: заявка на вступление не отправлена"
  wait_joined "$B_PORT" "$cid" "$A_PORT" || fail "$kind: доступ не получен за $TIMEOUT с"
  ok "$kind: участник вступил"

  # Посты пишет автор и только после вступления участника (см. шапку).
  local post1 post2
  post1="$(send "$A_PORT" "$chat" "$kind-post1-$RUN" "$cid")" || fail "пост 1 не отправлен"
  post2="$(send "$A_PORT" "$chat" "$kind-post2-$RUN" "$cid")" || fail "пост 2 не отправлен"
  [[ -n "$post1" && -n "$post2" ]] || fail "$kind: бэкенд не вернул id постов"
  ok "$kind: автор написал два поста"

  wait_until 90 texts_visible "$B_PORT" "$chat" "$kind-post1-$RUN" "$kind-post2-$RUN" \
    || fail "$kind: участник не видит посты"
  ok "$kind: участник видит оба поста"

  # Комментарий — обычное сообщение с `responseTo` (threads в сборке выключены,
  # см. docs/ru/akk_scheme.md §2–§4).
  local c1 c2
  c1="$(send "$B_PORT" "$chat" "$kind-comment1-$RUN" "$cid" "$post1")" || fail "$kind: комментарий 1 не отправлен"
  c2="$(send "$B_PORT" "$chat" "$kind-comment2-$RUN" "$cid" "$post2")" || fail "$kind: комментарий 2 не отправлен"
  [[ -n "$c1" && -n "$c2" ]] || fail "$kind: бэкенд не вернул id комментариев"
  ok "$kind: участник оставил два комментария"

  wait_until 90 texts_visible "$A_PORT" "$chat" "$kind-comment1-$RUN" "$kind-comment2-$RUN" \
    || fail "$kind: автор не видит комментарии"

  local replies
  replies="$(replies_count "$A_PORT" "$chat")"
  (( replies >= 2 )) || fail "$kind: комментарии не отмечены responseTo (найдено $replies)"
  ok "$kind: автор видит оба комментария"

  if [[ "$kind" == "issues" ]]; then
    # Отличие issues: самостоятельный пост пишет не только автор.
    send "$B_PORT" "$chat" "$kind-own-$RUN" "$cid" >/dev/null || fail "$kind: участник не смог написать пост"
    wait_until 90 texts_visible "$A_PORT" "$chat" "$kind-own-$RUN" \
      || fail "$kind: автор не видит пост участника"
    ok "$kind: участник написал свой пост, автор его видит"
  fi
}

check_kind news "все читают, пишет автор"
check_kind request "по заявке, комментируют все"
check_kind issues "по заявке, пишут и комментируют все"

# Для news и request ограничение «посты пишет только автор» живёт в интерфейсе
# (`channelRights.ts`): status-go право записи не различает, поэтому проверять
# его на уровне API бессмысленно — проверяется в vitest.

report_summary
echo "PASSED"
