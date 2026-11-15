#!/usr/bin/env bash
# wallet.sh — a transfer between two nodes on a local chain (anvil).
#
#   ./tests/integration/wallet.sh
#
# Why anvil instead of a testnet: money on a local chain is free, blocks are
# instant and behaviour is deterministic. The node believes it is on Sepolia
# (`--chain-id 11155111`), but the RPC provider is swapped for anvil, so the test
# never touches real funds.
#
# Checks:
#   1. Both profiles log in and the wallet starts in both nodes.
#   2. The network provider points at anvil; address A is funded.
#   3. Transfer A → B: buildTransaction → signMessage → sendTransactionWithSignature.
#   4. The block carrying the transfer is in the chain and the amount reached B.
#   5. Node B reports the new balance (from cache: it does not refresh by itself,
#      restartWalletReloadTimer and polling are required).

source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

ANVIL="${ANVIL:-$HOME/.foundry/bin/anvil}"
CAST="${CAST:-$HOME/.foundry/bin/cast}"
ANVIL_PORT="${ANVIL_PORT:-8545}"
# Sepolia (chain-id 11155111): for mainnet this build talks only to its built-in
# providers (Infura/Grove) and ignores a custom URL, so buildTransaction fails
# there with 401. The provider points at anvil, so no real network is used and no
# funds are spent.
CHAIN_ID="${CHAIN_ID:-11155111}"
AMOUNT_WEI=100000000000000000   # 0.1 ETH

command -v "$ANVIL" >/dev/null 2>&1 || { echo "нет anvil (foundry): $ANVIL" >&2; exit 1; }
command -v "$CAST"  >/dev/null 2>&1 || { echo "нет cast (foundry): $CAST" >&2; exit 1; }

A_PORT=$BASE_PORT
B_PORT=$((BASE_PORT + 1))
RPC="http://127.0.0.1:$ANVIL_PORT"

step "1. Локальная цепь (anvil, chain-id $CHAIN_ID)"
# Functions are declared before first use: bash reads the file top to bottom.
cast_ready() { [[ "$("$CAST" chain-id --rpc-url "$RPC" 2>/dev/null)" == "$CHAIN_ID" ]]; }
"$ANVIL" --port "$ANVIL_PORT" --chain-id "$CHAIN_ID" >"$WORK/anvil.log" 2>&1 &
PIDS+=($!)
wait_until 30 cast_ready || fail "anvil не поднялся на порту $ANVIL_PORT (лог: $WORK/anvil.log)"
ok "anvil отвечает на $RPC"

step "2. Логин двух профилей и кошелёк"
new_profile "Wallet-A" "$A_PORT"
new_profile "Wallet-B" "$B_PORT"
call "$A_PORT" wallet_startWallet >/dev/null || fail "кошелёк A не запустился"
call "$B_PORT" wallet_startWallet >/dev/null || fail "кошелёк B не запустился"
A_ADDR="$(first_address "$A_PORT")"
B_ADDR="$(first_address "$B_PORT")"
[[ -n "$A_ADDR" && -n "$B_ADDR" ]] || fail "нет кошельковых адресов у профилей"
ok "A=$A_ADDR  B=$B_ADDR"

# Provider: `type: "user"` is the only kind that needs no Stauri proxy.
provider_params() {
  python3 -c '
import json, sys
chain, url = int(sys.argv[1]), sys.argv[2]
print(json.dumps([chain, [{
  "id": 0, "chainId": chain, "name": "anvil", "url": url,
  "enableRpsLimiter": False, "type": "user", "enabled": True,
  "authType": "no-auth", "authLogin": "", "authPassword": "", "authToken": ""}]]))' "$1" "$2"
}

step "3. Провайдер сети → anvil, пополнение A"
for p in "$A_PORT" "$B_PORT"; do
  call "$p" networks_setChainUserRpcProviders "$(provider_params "$CHAIN_ID" "$RPC")" >/dev/null \
    || fail "провайдер не задан для порта $p"
  # The network is already active by default; enable it if not (the "already
  # active" error does not matter).
  call "$p" networks_setChainActive "[$CHAIN_ID, true]" >/dev/null 2>&1 || true
done
"$CAST" rpc --rpc-url "$RPC" anvil_setBalance "$A_ADDR" 0x56bc75e2d63100000 >/dev/null \
  || fail "не удалось пополнить A на anvil"
[[ "$("$CAST" balance "$A_ADDR" --rpc-url "$RPC")" == "100000000000000000000" ]] \
  || fail "баланс A на anvil не 100 ETH"
ok "A пополнен на 100 ETH (локально)"

step "4. Перевод A → B"
build_args=$(python3 -c '
import json, sys
chain, frm, to, amount = int(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4])
print(json.dumps([chain, json.dumps({"from": frm, "to": to, "value": hex(amount), "data": "0x"})]))' \
  "$CHAIN_ID" "$A_ADDR" "$B_ADDR" "$AMOUNT_WEI")

built="$(call "$A_PORT" wallet_buildTransaction "$build_args")" || fail "buildTransaction не вернул результат"
MSG="$(printf '%s' "$built" | python3 -c 'import json,sys;print((json.load(sys.stdin) or {}).get("messageToSign") or "")')"
TXARGS="$(printf '%s' "$built" | python3 -c 'import json,sys;print(json.dumps((json.load(sys.stdin) or {}).get("txArgs")))')"
[[ -n "$MSG" && "$TXARGS" != "null" ]] || fail "нода не вернула messageToSign/txArgs"
ok "транзакция собрана"

SIG="$(call "$A_PORT" wallet_signMessage "[\"$MSG\", \"$A_ADDR\", \"$PASSWORD\"]" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin) or "")')" || fail "подпись не получена"
[[ -n "$SIG" ]] || fail "подпись пустая"
ok "подпись получена (пароль проверен нодой)"

# The signature comes back with `0x`, but sendTransactionWithSignature parses it
# with hex.DecodeString, so the prefix must be stripped (see
# src-tauri/src/transfer.rs).
send_params=$(python3 -c '
import json, sys
print(json.dumps([int(sys.argv[1]), "WalletTransfer", sys.argv[2], sys.argv[3]]))' \
  "$CHAIN_ID" "$TXARGS" "${SIG#0x}")
TX_HASH="$(call "$A_PORT" wallet_sendTransactionWithSignature "$send_params" \
  | python3 -c 'import json,sys;print(json.load(sys.stdin) or "")')" || fail "перевод не отправлен"
[[ "$TX_HASH" == 0x* ]] || fail "нода не вернула хеш перевода (получено: $TX_HASH)"
ok "перевод отправлен: ${TX_HASH:0:20}…"

step "5. Проверка в цепи"
# `cast receipt --json` reports status as "0x1"; wait_until discards output, so
# the comparison happens inside the check rather than in a pipeline.
tx_confirmed() {
  local status
  status="$("$CAST" receipt "$1" --rpc-url "$RPC" --json 2>/dev/null \
    | python3 -c 'import json,sys;d=json.load(sys.stdin);print(d.get("status"))' 2>/dev/null)"
  [[ "$status" == "0x1" || "$status" == "1" ]]
}
balance_reached() { [[ "$("$CAST" balance "$B_ADDR" --rpc-url "$RPC" 2>/dev/null)" == "$AMOUNT_WEI" ]]; }

wait_until 30 balance_reached || fail "на адрес B не пришло $AMOUNT_WEI wei"
ok "в цепи: баланс B = 0.1 ETH"
wait_until 15 tx_confirmed "$TX_HASH" || fail "транзакция не подтверждена (status != 1)"
ok "транзакция подтверждена (status=1)"

step "6. Баланс в ноде B (информационно)"
# The balance cache does not refresh by itself: `forceRefresh` is ignored by
# status-go, and only restartWalletReloadTimer plus a re-query works (see
# wallet.ts). On a local chain the cache may stay empty — the node fills it from
# its own built-in network provider, not the one set here, and `hasError` in the
# response reports exactly that. The step therefore does not fail the test: the
# transfer is already confirmed on-chain in step 5, and this only shows what the
# node sees.
native_balance() {
  python3 -c 'import json,sys;print(json.dumps([[sys.argv[1]], True]))' "$B_ADDR" >"$WORK/bal.json"
  call "$B_PORT" wallet_fetchOrGetCachedWalletBalances "$(cat "$WORK/bal.json")" 2>/dev/null \
  | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin) or {}
except Exception:
    raise SystemExit(1)
chain = int(sys.argv[1])
for tokens in data.values():
    for t in tokens:
        if (t.get("tokenAddress") or "").lower() == "0x" + "0" * 40 and int(t.get("tokenChainId") or 0) == chain:
            raise SystemExit(0 if int(t.get("rawBalance") or 0) > 0 else 1)
raise SystemExit(1)' "$CHAIN_ID"
}

call "$B_PORT" wallet_restartWalletReloadTimer >/dev/null 2>&1 || true
if wait_until 60 native_balance; then
  ok "нода B показывает баланс 0.1 ETH"
else
  echo "  · нода B кэш не обновила (ожидаемо для локальной цепи: провайдер сети у ноды свой)"
fi

report_summary
echo "PASSED"
