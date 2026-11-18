#!/usr/bin/env bash
# display_name.sh — a new display name reaches settings, the contact list and
# the contact card that other nodes see, and it arrives at the other node as a
# signal rather than only in a later RPC read.
#
#   ./tests/integration/display_name.sh
#
# Checks:
#   1. Profile A logs in; its display name is read from settings.
#   2. `settings_saveSetting("display-name", …)` changes it.
#   3. `wakuext_contacts` for A and for a second node B carry the new name after
#      B has A as a contact (the name travels with the contact updates).
#   4. B receives the name inside a `messages.new` signal's `contacts` field.
#      This is what the application reads to show a rename at once; without it
#      the name only appears at the next contacts poll.
#
# Text-only: no money, no on-chain transaction.

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

A_PORT=$BASE_PORT
B_PORT=$((BASE_PORT + 1))
NEW_NAME="Renamed-$(date +%H%M%S)"

name_of() { call "$1" settings_getSettings | python3 -c 'import json,sys;print(json.load(sys.stdin).get("display-name") or "")'; }
contact_name_of() { call "$1" wakuext_contacts | python3 -c "
import json,sys
c=[x for x in (json.load(sys.stdin) or []) if x.get('id')=='$2']
print((c[0].get('displayName') or '') if c else '')"; }

step "1. Два профиля и контакт между ними"
new_profile "Name-A" "$A_PORT"
new_profile "Name-B" "$B_PORT"
add_contact "$A_PORT" "$B_PORT"
A_HEX="$(pubkey "$A_PORT")"
OLD_NAME="$(name_of "$A_PORT")"
ok "A: имя в настройках: $OLD_NAME"

step "2. A меняет экранное имя"
# Cursor before the rename: everything after it is new, so an earlier contact
# update from setting the profile up cannot satisfy the check below.
B_SIGNALS_BEFORE="$(signal_count "$B_PORT")"
call "$A_PORT" settings_saveSetting "[\"display-name\", \"$NEW_NAME\"]" >/dev/null || fail "settings_saveSetting не сработал"
SAVED="$(name_of "$A_PORT")"
[[ "$SAVED" == "$NEW_NAME" ]] || fail "в настройках осталось '$SAVED', ожидалось '$NEW_NAME'"
ok "настройки A: $SAVED"

step "3. Новое имя уходит контактам"
call "$A_PORT" wakuext_sendContactUpdates "[\"$NEW_NAME\", \"\", \"primary\"]" >/dev/null || true
seen_by_b() { [[ "$(contact_name_of "$B_PORT" "$A_HEX")" == "$NEW_NAME" ]]; }
wait_until "$TIMEOUT" seen_by_b || fail "B видит имя '$(contact_name_of "$B_PORT" "$A_HEX")' вместо '$NEW_NAME'"
ok "B видит A как $NEW_NAME"

step "4. Новое имя приходит в сигнале messages.new"
# The application must be able to show the rename without polling, so the record
# has to be in the signal itself, not only in `wakuext_contacts`.
signal_has_name() { signals_contact_names "$B_PORT" "$B_SIGNALS_BEFORE" | grep -Fxq "$NEW_NAME"; }
wait_until "$TIMEOUT" signal_has_name || {
  echo "  имена в сигналах после переименования:" >&2
  signals_contact_names "$B_PORT" "$B_SIGNALS_BEFORE" | sed 's/^/    /' >&2
  fail "имя '$NEW_NAME' не пришло в messages.new.contacts"
}
ok "B получил '$NEW_NAME' в сигнале"

step "5. Имя переживает повторное чтение настроек"
AGAIN="$(name_of "$A_PORT")"
[[ "$AGAIN" == "$NEW_NAME" ]] || fail "после перечитывания в настройках '$AGAIN'"
ok "настройки A стабильны: $AGAIN"

report_summary
echo "PASSED"
