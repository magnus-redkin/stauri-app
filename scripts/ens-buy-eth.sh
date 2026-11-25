#!/usr/bin/env bash
# ens-buy-eth.sh — покупка <name>.eth через ETHRegistrarController (v3), только cast.
#
#   ./scripts/ens-buy-eth.sh stauri                      # проверка (режим по умолчанию)
#   ./scripts/ens-buy-eth.sh stauri --check              # то же самое, явно
#   ./scripts/ens-buy-eth.sh stauri --check --owner 0x…  # с проверкой баланса
#   ./scripts/ens-buy-eth.sh stauri --buy --account stauri-ens
#   ./scripts/ens-buy-eth.sh stauri --buy --account stauri-ens --yes
#
# --check (по умолчанию) ничего не отправляет и ключа не требует. Проверяет то,
# что решает исход покупки:
#   - контроллер авторизован в BaseRegistrar: без этого register() отвергается
#     в самом контракте — у любого клиента и любого скрипта;
#   - имя свободно и что о нём знает реестр (владелец, резолвер);
#   - аренду на выбранный срок и хватает ли баланса с учётом газа;
#   - симулирует commit() через eth_call.
# Код выхода: 0 — покупка возможна, 1 — ошибка, 2 — сейчас невозможна.
#
# --buy: commit → ожидание minCommitmentAge → повторная проверка имени и цены →
# симуляция register через eth_call (отказ стоит 0, а не газ) → register с
# value = аренда → проверка владельца в реестре.
# Секрет коммита пишется в файл состояния, поэтому прерванную покупку можно
# доделать в пределах maxCommitmentAge без второго коммита.
#
# Ключ только из keystore Foundry (--account NAME или --keystore PATH).
# Приватный ключ аргументом не принимается: он остался бы в истории shell.
#
# Состояние: ${XDG_STATE_HOME:-$HOME/.local/state}/stauri/ens-buy/<chain>-<label>.json
# (права 0600: там лежит секрет коммита; он не является ключом кошелька).

set -euo pipefail

CHAIN=mainnet
RPC=""
LABEL=""
BUY=0
YES=0
OWNER=""
YEARS=1
ACCOUNT=""
KEYSTORE=""
PASSWORD_FILE=""
REVERSE=0
PRINT_CALLDATA=0
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/stauri/ens-buy"

CONTROLLER=""
REGISTRAR=""
REGISTRY=""

ZERO=0x0000000000000000000000000000000000000000
# referrer в Registration — bytes32 (ключ реферера), не адрес: 32 байта нулей.
REFERRER=0x0000000000000000000000000000000000000000000000000000000000000000
SENDER_ARGS=()

die()  { echo "ERROR: $*" >&2; exit 1; }
say()  { echo "  $*"; }
ok()   { echo "  ✓ $*"; }
warn() { echo "  ! $*"; }

usage() { sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --check)   BUY=0 ;;
    --buy)     BUY=1 ;;
    --yes|-y)  YES=1 ;;
    --chain)   CHAIN="${2:?--chain требует значение}"; shift ;;
    --rpc)     RPC="${2:?--rpc требует значение}"; shift ;;
    --owner)   OWNER="${2:?--owner требует значение}"; shift ;;
    --years)   YEARS="${2:?--years требует значение}"; shift ;;
    --account) ACCOUNT="${2:?--account требует значение}"; shift ;;
    --keystore) KEYSTORE="${2:?--keystore требует значение}"; shift ;;
    --password-file) PASSWORD_FILE="${2:?--password-file требует значение}"; shift ;;
    --controller) CONTROLLER="${2:?--controller требует значение}"; shift ;;
    --registrar)  REGISTRAR="${2:?--registrar требует значение}"; shift ;;
    --registry)   REGISTRY="${2:?--registry требует значение}"; shift ;;
    --reverse) REVERSE=1 ;;
    --print-calldata) PRINT_CALLDATA=1 ;;
    -h|--help) usage; exit 0 ;;
    -*) die "неизвестный аргумент: $1" ;;
    *) [[ -z "$LABEL" ]] || die "лишний аргумент: $1"; LABEL="$1" ;;
  esac
  shift
done

command -v cast >/dev/null 2>&1 || die "cast не найден (foundry)"
command -v python3 >/dev/null 2>&1 || die "python3 не найден"

case "$CHAIN" in
  mainnet)
    RPC="${RPC:-https://ethereum-rpc.publicnode.com}"
    CONTROLLER="${CONTROLLER:-0x253553366Da8546fC250F225fe3d25d0C782303b}"
    REGISTRAR="${REGISTRAR:-0x57f1887a8BF19b14fC0dF6Fd9B2Acc9Af147eA85}"
    REGISTRY="${REGISTRY:-0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e}" ;;
  *)
    RPC="${RPC:?для сети $CHAIN нужен --rpc}"
    [[ -n "$CONTROLLER" && -n "$REGISTRAR" && -n "$REGISTRY" ]] \
      || die "для сети $CHAIN задайте --controller, --registrar и --registry: адреса не угадываются" ;;
esac

# ---------- Имя ----------

[[ -n "$LABEL" ]] || { usage; die "не задано имя"; }
[[ "$YEARS" =~ ^[1-9][0-9]*$ ]] || die "--years: целое положительное число"

LABEL="$(printf '%s' "$LABEL" | tr '[:upper:]' '[:lower:]')"
LABEL="${LABEL%.eth}"
[[ "$LABEL" =~ ^[a-z0-9-]{3,63}$ ]] \
  || die "имя должно быть 3–63 символа: строчные латинские буквы, цифры, дефис"
[[ "$LABEL" != -* && "$LABEL" != *- ]] || die "имя не может начинаться или кончаться дефисом"

DURATION=$(( YEARS * 31536000 ))
NAME="$LABEL.eth"
NAMEHASH="$(cast namehash "$NAME")"

# 32 случайных байта для коммита. Это не ключ, но пока коммит жив, по этому
# секрету можно зарегистрировать имя на указанного владельца, поэтому файл
# состояния закрыт правами 0600.
new_secret() { printf '0x%s' "$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"; }

# Registration для makeCommitment/register:
# string,address,uint256,bytes32,address,bytes[],uint8,bytes32
registration_tuple() {
  printf '(%s,%s,%s,%s,%s,[],%s,%s)' \
    "$LABEL" "$1" "$DURATION" "$2" "$ZERO" "$REVERSE" "$REFERRER"
}

MAKE_COMMITMENT_SIG="makeCommitment((string,address,uint256,bytes32,address,bytes[],uint8,bytes32))(bytes32)"
REGISTER_SIG="register((string,address,uint256,bytes32,address,bytes[],uint8,bytes32))"
COMMIT_SIG="commit(bytes32)"

if [[ "$PRINT_CALLDATA" -eq 1 ]]; then
  # Офлайн-проверка ABI: ничего не читает из сети.
  tuple="$(registration_tuple "${OWNER:-0x000000000000000000000000000000000000dEaD}" "0x$(printf '11%.0s' {1..32})")"
  echo "tuple:    $tuple"
  echo "commit:   $(cast calldata "$COMMIT_SIG" "0x$(printf '22%.0s' {1..32})")"
  echo "register: $(cast calldata "$REGISTER_SIG" "$tuple")"
  exit 0
fi

read_chain() {
  # Публичные RPC рвут соединение пачками; три попытки дешевле, чем падение
  # проверки на ровном месте.
  local out i
  for i in 1 2 3; do
    if out="$(cast call "$@" --rpc-url "$RPC" 2>/dev/null)"; then printf '%s\n' "$out"; return 0; fi
    sleep 1
  done
  return 1
}
wei_eth() { python3 -c "import sys; print(f'{int(sys.argv[1])/10**18:.6f}')" "$1"; }
now_ts() { date +%s; }

HEAD_BLOCK=""
for _ in 1 2 3 4 5; do
  HEAD_BLOCK="$(cast block-number --rpc-url "$RPC" 2>/dev/null || true)"
  [[ -n "$HEAD_BLOCK" ]] && break
  sleep 2
done
[[ -n "$HEAD_BLOCK" ]] || die "RPC не отвечает: $RPC (другой можно задать через --rpc)"

echo "=== ENS: $NAME на $CHAIN (блок $HEAD_BLOCK) ==="
say "контроллер  $CONTROLLER"
say "регистратор $REGISTRAR"
say "реестр      $REGISTRY"

# ---------- Владелец и ключ ----------

resolve_owner() {
  # Keystore Foundry зашифрован: без --password-file cast спросит пароль в
  # терминале (в неинтерактивном запуске это зависание, поэтому и есть --owner).
  local pw=()
  [[ -n "$PASSWORD_FILE" ]] && pw=(--password-file "$PASSWORD_FILE")
  if [[ -n "$OWNER" ]]; then echo "$OWNER"; return; fi
  if [[ -n "$ACCOUNT" ]]; then cast wallet address --account "$ACCOUNT" "${pw[@]+"${pw[@]}"}" 2>/dev/null && return; fi
  if [[ -n "$KEYSTORE" ]]; then cast wallet address --keystore "$KEYSTORE" "${pw[@]+"${pw[@]}"}" 2>/dev/null && return; fi
  echo ""
}

if [[ "$BUY" -eq 1 ]]; then
  [[ -n "$ACCOUNT" || -n "$KEYSTORE" ]] \
    || die "для --buy нужен --account NAME или --keystore PATH (создать: cast wallet import)"
  [[ -n "$ACCOUNT" ]] && SENDER_ARGS+=(--account "$ACCOUNT")
  [[ -n "$KEYSTORE" ]] && SENDER_ARGS+=(--keystore "$KEYSTORE")
  [[ -n "$PASSWORD_FILE" ]] && SENDER_ARGS+=(--password-file "$PASSWORD_FILE")
  OWNER="${OWNER:-$(resolve_owner)}"
  [[ -n "$OWNER" ]] || die "не удалось определить адрес владельца: задайте --owner"
else
  OWNER="${OWNER:-$(resolve_owner)}"
fi

# ---------- Проверки ----------

echo
echo "[1/4] Контроллер регистратора"
ctl="$(read_chain "$REGISTRAR" "controllers(address)(bool)" "$CONTROLLER" | tr -d '[:space:]')" \
  || die "не удалось прочитать controllers() на регистраторе"
CONTROLLER_OK=0
if [[ "$ctl" == "true" ]]; then
  ok "контроллер авторизован в BaseRegistrar"
  CONTROLLER_OK=1
else
  warn "BaseRegistrar не авторизует контроллер: register() отвергается в контракте"
  warn "это отказ для любого клиента — ensvision, app.ens.domains и этот скрипт"
fi

echo
echo "[2/4] Имя"
available="$(read_chain "$CONTROLLER" "available(string)(bool)" "$LABEL" | tr -d '[:space:]')" \
  || die "не удалось прочитать available()"
[[ "$available" == "true" ]] && ok "свободно" || warn "занято"

reg_owner="$(read_chain "$REGISTRY" "owner(bytes32)(address)" "$NAMEHASH" | head -1 | awk '{print $1}')" || reg_owner=""
resolver="$(read_chain "$REGISTRY" "resolver(bytes32)(address)" "$NAMEHASH" | head -1 | awk '{print $1}')" || resolver=""
say "реестр: owner ${reg_owner:-?}, resolver ${resolver:-?}"

MIN_AGE="$(read_chain "$CONTROLLER" "minCommitmentAge()(uint256)" 2>/dev/null | head -1 | awk '{print $1}')" || MIN_AGE=60
MAX_AGE="$(read_chain "$CONTROLLER" "maxCommitmentAge()(uint256)" 2>/dev/null | head -1 | awk '{print $1}')" || MAX_AGE=86400
[[ "$MIN_AGE" =~ ^[0-9]+$ ]] || MIN_AGE=60
[[ "$MAX_AGE" =~ ^[0-9]+$ ]] || MAX_AGE=86400
say "коммит действует от ${MIN_AGE} с до ${MAX_AGE} с"

echo
echo "[3/4] Цена"
price_out="$(read_chain "$CONTROLLER" 'rentPrice(string,uint256)(uint256,uint256)' "$LABEL" "$DURATION")" \
  || die "не удалось прочитать rentPrice()"
BASE="$(printf '%s\n' "$price_out" | sed -n '1p' | awk '{print $1}')"
PREMIUM="$(printf '%s\n' "$price_out" | sed -n '2p' | awk '{print $1}')"
[[ "$BASE" =~ ^[0-9]+$ ]] || die "не разобрал цену аренды: $price_out"
[[ "$PREMIUM" =~ ^[0-9]+$ ]] || PREMIUM=0
RENT=$(( BASE + PREMIUM ))

GAS_PRICE="$(cast gas-price --rpc-url "$RPC" 2>/dev/null || echo 0)"
[[ "$GAS_PRICE" =~ ^[0-9]+$ ]] || GAS_PRICE=0
GAS_EST=$(( GAS_PRICE * 267000 ))   # commit ≈ 47k + register ≈ 220k
TOTAL=$(( RENT + GAS_EST ))

say "аренда на $YEARS г.: $(wei_eth "$RENT") ETH (base $(wei_eth "$BASE"), premium $(wei_eth "$PREMIUM"))"
say "газ по текущей цене ($(python3 -c "print(f'{int(\"$GAS_PRICE\")/10**9:.4f}')") gwei): ~$(wei_eth "$GAS_EST") ETH"
say "итого ориентировочно: $(wei_eth "$TOTAL") ETH"

BALANCE_OK=1
if [[ -z "$OWNER" ]]; then
  warn "адрес владельца неизвестен — баланс не проверен (--owner 0x…)"
else
  BALANCE="$(cast balance "$OWNER" --rpc-url "$RPC" 2>/dev/null || true)"
  if [[ "$BALANCE" =~ ^[0-9]+$ ]]; then
    say "баланс $OWNER: $(wei_eth "$BALANCE") ETH"
    if [[ "$BALANCE" -lt "$TOTAL" ]]; then
      warn "баланса не хватает: нужно ≥ $(wei_eth "$TOTAL") ETH"
      BALANCE_OK=0
    else
      ok "баланса хватает"
    fi
  else
    warn "баланс $OWNER не прочитан"
  fi
fi

# ---------- Состояние прошлых запусков ----------

STATE_FILE="$STATE_DIR/${CHAIN}-${LABEL}.json"
ST_SECRET=""
ST_COMMITTED_AT=0

if [[ -f "$STATE_FILE" ]]; then
  state="$(python3 - "$STATE_FILE" <<'PY' || true
import json, sys
try:
    d = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(1)
if not all(k in d for k in ("owner", "secret", "commitment", "duration", "controller", "name")):
    sys.exit(1)
print(d["name"], d["owner"], d["secret"], d["commitment"], d["duration"], d["controller"])
PY
)"
  if [[ -n "$state" ]]; then
    read -r st_name st_owner st_secret st_commitment st_duration st_controller <<<"$state"
    if [[ "$st_name" == "$NAME" && "$st_duration" == "$DURATION" \
          && "$st_controller" == "$CONTROLLER" && "$st_secret" =~ ^0x[0-9a-f]{64}$ ]] \
       && { [[ -z "$OWNER" ]] || [[ "$st_owner" == "$OWNER" ]]; }; then
      ST_SECRET="$st_secret"
    else
      warn "файл состояния не от этой покупки — игнорирую ($STATE_FILE)"
    fi
  fi
fi

SECRET="${ST_SECRET:-$(new_secret)}"
TUPLE="$(registration_tuple "$(printf '%s' "${OWNER:-$ZERO}")" "$SECRET")"

echo
echo "[4/4] Коммит"
COMMIT_OK=1
COMMITMENT=""
COMMITTED_AT=0
if [[ -z "$OWNER" ]]; then
  warn "адрес владельца неизвестен — коммит не считаю (нужен --owner)"
elif ! COMMITMENT="$(read_chain "$CONTROLLER" "$MAKE_COMMITMENT_SIG" "$TUPLE" 2>/dev/null | tr -d '[:space:]()')"; then
  # makeCommitment — view-функция: её отказ означает, что и commit() не пройдёт.
  COMMIT_OK=0
  COMMITMENT=""
  warn "makeCommitment() ревертнул: контроллер не считает коммит и сейчас"
else
  [[ "$COMMITMENT" =~ ^0x[0-9a-f]{64}$ ]] || { COMMIT_OK=0; warn "makeCommitment вернул непонятное: $COMMITMENT"; }
fi

if [[ "$COMMIT_OK" -eq 1 && -n "$COMMITMENT" ]]; then
  COMMITTED_AT="$(read_chain "$CONTROLLER" "commitments(bytes32)(uint256)" "$COMMITMENT" 2>/dev/null | head -1 | awk '{print $1}')" \
    || COMMITTED_AT=0
  [[ "$COMMITTED_AT" =~ ^[0-9]+$ ]] || COMMITTED_AT=0
  if [[ "$COMMITTED_AT" -gt 0 ]]; then
    say "коммит уже есть: возраст $(( $(now_ts) - COMMITTED_AT )) с"
  else
    say "коммита нет"
  fi

  # Симуляция commit(): бесплатно и показывает, примет ли его контроллер.
  if cast call --from "$OWNER" "$CONTROLLER" "$COMMIT_SIG" "$COMMITMENT" --rpc-url "$RPC" >/dev/null 2>&1; then
    ok "commit() симулируется без ошибок"
  else
    COMMIT_OK=0
    warn "commit() в симуляции ревертнул"
  fi
fi

# ---------- Итог проверки ----------

BLOCKERS=()
[[ "$CONTROLLER_OK" -eq 1 ]] || BLOCKERS+=("регистратор не авторизует контроллер")
[[ "$available" == "true" ]] || BLOCKERS+=("имя занято")
[[ "$BALANCE_OK" -eq 1 ]] || BLOCKERS+=("не хватает баланса")
# Коммит не проверен (нет адреса) — это не блокер: без --owner проверка неполная.
if [[ -n "$OWNER" && -z "$COMMITMENT" ]]; then
  BLOCKERS+=("контроллер не принимает коммит")
fi

if [[ "$BUY" -eq 0 ]]; then
  echo
  if [[ ${#BLOCKERS[@]} -gt 0 ]]; then
    echo "Итог: покупка сейчас невозможна:"
    for b in "${BLOCKERS[@]}"; do echo "  - $b"; done
    echo "Проверить снова: ./scripts/ens-buy-eth.sh $LABEL --check"
    exit 2
  fi
  echo "Итог: покупка возможна."
  echo "Стоимость ~$(wei_eth "$TOTAL") ETH на $YEARS г., из них $(wei_eth "$RENT") — аренда."
  echo "Запуск: ./scripts/ens-buy-eth.sh $LABEL --buy --account <имя-keystore>"
  echo "Ничего не отправлено (--check)."
  exit 0
fi

# ---------- Покупка ----------

[[ ${#BLOCKERS[@]} -eq 0 ]] || die "покупка невозможна: ${BLOCKERS[0]}"

if [[ "$YES" -ne 1 ]]; then
  [[ -t 0 ]] || die "неинтерактивный запуск требует --yes"
  echo
  echo "Купить $NAME на $CHAIN за ~$(wei_eth "$TOTAL") ETH (аренда $(wei_eth "$RENT"))?"
  read -r -p "Введите yes: " answer
  [[ "$answer" == "yes" ]] || die "отменено"
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

send_tx() { cast send "$@" --rpc-url "$RPC" "${SENDER_ARGS[@]+"${SENDER_ARGS[@]}"}" --json; }

save_state() {
  python3 - "$STATE_FILE" "$NAME" "$OWNER" "$SECRET" "$COMMITMENT" "$DURATION" "$CONTROLLER" <<'PY'
import json, sys, time
path, name, owner, secret, commitment, duration, controller = sys.argv[1:8]
json.dump({
    "name": name,
    "owner": owner,
    "secret": secret,
    "commitment": commitment,
    "duration": int(duration),
    "controller": controller,
    "updated": int(time.time()),
}, open(path, "w"), indent=2)
PY
  chmod 600 "$STATE_FILE"
}

# 1. Коммит, если его нет, он молод или устарел.
NEED_COMMIT=1
if [[ "$COMMITTED_AT" -gt 0 ]]; then
  age=$(( $(now_ts) - COMMITTED_AT ))
  if [[ "$age" -ge "$MIN_AGE" && "$age" -le "$MAX_AGE" && -n "$ST_SECRET" ]]; then
    NEED_COMMIT=0
  fi
fi

if [[ "$NEED_COMMIT" -eq 1 ]]; then
  echo
  echo "commit: $COMMITMENT"
  commit_json="$(send_tx "$CONTROLLER" "$COMMIT_SIG" "$COMMITMENT")" || die "commit() не отправлен"
  save_state
  say "commit: $(printf '%s' "$commit_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("transactionHash",""))')"
  COMMITTED_AT="$(now_ts)"
fi

# 2. Ожидание minCommitmentAge: считается от коммита в цепи.
target=$(( COMMITTED_AT + MIN_AGE ))
if [[ "$(now_ts)" -lt "$target" ]]; then
  echo
  echo "ожидание коммита: $(( target - $(now_ts) )) с"
  while [[ "$(now_ts)" -lt "$target" ]]; do sleep 3; done
fi

# 3. Перед отправкой: имя могло быть занято, цена изменилась.
echo
echo "проверка перед register"
available="$(read_chain "$CONTROLLER" "available(string)(bool)" "$LABEL" | tr -d '[:space:]')"
[[ "$available" == "true" ]] || die "имя занято — register не отправлен"
price_out="$(read_chain "$CONTROLLER" 'rentPrice(string,uint256)(uint256,uint256)' "$LABEL" "$DURATION")"
BASE="$(printf '%s\n' "$price_out" | sed -n '1p' | awk '{print $1}')"
PREMIUM="$(printf '%s\n' "$price_out" | sed -n '2p' | awk '{print $1}')"
[[ "$BASE" =~ ^[0-9]+$ ]] || die "не разобрал цену: $price_out"
[[ "$PREMIUM" =~ ^[0-9]+$ ]] || PREMIUM=0
RENT=$(( BASE + PREMIUM ))
say "аренда сейчас: $(wei_eth "$RENT") ETH"

# 4. Симуляция register с точной суммой: отказ стоит 0, а не газ.
if ! cast call --from "$OWNER" --value "$RENT" "$CONTROLLER" "$REGISTER_SIG" "$TUPLE" --rpc-url "$RPC" >/dev/null 2>&1; then
  die "register в симуляции ревертнул — транзакция не отправлена (газ не потрачен)"
fi
ok "register симулируется"

# 5. Отправка.
echo
register_json="$(send_tx "$CONTROLLER" "$REGISTER_SIG" "$TUPLE" --value "$RENT")" || die "register не отправлен"
TX="$(printf '%s' "$register_json" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("transactionHash",""))')"
echo "register: $TX"

# 6. Результат проверяется по реестру, а не по статусу транзакции: контракт может
#    вернуть успех, не выдав имя.
echo
echo "проверка результата"
new_owner="$(read_chain "$REGISTRY" "owner(bytes32)(address)" "$NAMEHASH" | head -1 | awk '{print $1}')"
say "registry.owner($NAME) = ${new_owner:-?}"
if [[ -z "$new_owner" || "$new_owner" == "$ZERO" ]]; then
  echo "Имя в реестре не появилось: транзакция $TX прошла, но регистрацию не дала." >&2
  echo "Смотрите controllers() на регистраторе и событие NameRegistered в транзакции." >&2
  exit 1
fi

rm -f "$STATE_FILE"
echo
echo "Готово: $NAME принадлежит $new_owner."
echo "Транзакция: $TX"
echo "Привязать к профилю: Profile → Edit → .eth → $LABEL → Attach to this profile."
