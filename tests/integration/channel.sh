#!/usr/bin/env bash
# channel.sh — three channel kinds on two nodes (see src/lib/status/channelKind.ts).
#
#   ./tests/integration/channel.sh
#
# Channel kinds:
#   news    — open: anyone may join (auto-accept);
#   request — by request: the author posts, members comment;
#   issues  — by request: members post and comment.
#
# Order matters: the participant joins first, then the author posts. Otherwise
# the participant never sees the posts — this build has no history catch-up
# (`requestCommunityInfoFromMailserver` does not exist), so messages sent before
# joining do not reach them.
#
# Checks, per kind:
#   1. The author creates the channel.
#   2. The participant joins (for request/issues: a request and the author's Accept).
#   3. The author writes two posts, the participant sees both.
#   4. The participant comments on each, the author sees both.
#   5. For issues, the participant also writes their own post and the author sees it.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

A_PORT=$BASE_PORT
B_PORT=$((BASE_PORT + 1))

step "1. Логин автора и участника"
new_profile "Chan-A" "$A_PORT"
new_profile "Chan-B" "$B_PORT"
ok "профили A (автор) и B (участник) созданы и вошли"

# replies_count <port> <chatId> — how many messages in the timeline are replies.
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

  # The author posts only after the participant has joined (see the header).
  local post1 post2
  post1="$(send "$A_PORT" "$chat" "$kind-post1-$RUN" "$cid")" || fail "пост 1 не отправлен"
  post2="$(send "$A_PORT" "$chat" "$kind-post2-$RUN" "$cid")" || fail "пост 2 не отправлен"
  [[ -n "$post1" && -n "$post2" ]] || fail "$kind: бэкенд не вернул id постов"
  ok "$kind: автор написал два поста"

  wait_until 90 texts_visible "$B_PORT" "$chat" "$kind-post1-$RUN" "$kind-post2-$RUN" \
    || fail "$kind: участник не видит посты"
  ok "$kind: участник видит оба поста"

  # A comment is an ordinary message with `responseTo` (threads are off in this
  # build, see docs/ru/akk_scheme.md §2–§4).
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
    # What sets issues apart: not only the author may write a standalone post.
    send "$B_PORT" "$chat" "$kind-own-$RUN" "$cid" >/dev/null || fail "$kind: участник не смог написать пост"
    wait_until 90 texts_visible "$A_PORT" "$chat" "$kind-own-$RUN" \
      || fail "$kind: автор не видит пост участника"
    ok "$kind: участник написал свой пост, автор его видит"
  fi
}

check_kind news "все читают, пишет автор"
check_kind request "по заявке, комментируют все"
check_kind issues "по заявке, пишут и комментируют все"

# For news and request, the "only the author posts" rule lives in the interface
# (`channelRights.ts`): status-go does not distinguish write permission, so
# checking it at the API level would prove nothing — vitest covers it.

report_summary
echo "PASSED"
