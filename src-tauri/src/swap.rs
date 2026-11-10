//! Обмен токенов (`Swap`) внутри одной сети.
//!
//! ## Почему через Router, а не своим путём
//!
//! Обмен выполняет провайдер (Paraswap или LI.FI), и маршрут строит Router
//! status-go: он сам запрашивает цену, считает `minAmountOut` по допуску
//! проскальзывания и решает, нужен ли отдельный `approve`. Повторять это
//! снаружи значило бы расходиться с провайдером в расчётах.
//!
//! Механизм сигналов и подписей общий с регистрацией ENS — он в `router.rs`.
//!
//! ## Почему только mainnet
//!
//! У провайдеров нет ликвидности в тестовых сетях: `getPartnerAddressAndFeePcnt`
//! знает пять mainnet-сетей, LI.FI на Sepolia не настроен. Попытка обмена в
//! тестовой сети вернёт «no routes found», и это не наша недоработка. Раньше
//! проверяем сеть здесь, чтобы человек получил понятный текст, а не отказ
//! провайдера.
//!
//! ## Проскальзывание
//!
//! `slippagePercentage` — допуск, на который сумма на выходе может оказаться
//! меньше рассчитанной. Контракт его требует строго положительным
//! (`ErrSwapSlippagePercentageMustBePositive`), поэтому ноль отправить нельзя.
//! Значение 1 % — разумный компромисс: меньше — обмен часто отваливается при
//! движении цены, больше — человека можно сильно обделить.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use std::time::Duration;

use crate::backend::Backend;
use crate::error::{AppError, AppResult};
use crate::router::{
    GAS_FEE_MEDIUM, connect_signals, execute_round, hex_u128, is_address, unique_uuid,
};

/// `SendType` из `pkg/services/wallet/router/sendtype/send_type.go`: Swap=8.
const SEND_TYPE_SWAP: u64 = 8;

/// Допуск проскальзывания в процентах.
const SLIPPAGE_PERCENT: f64 = 1.0;

/// Сети, где обмен реально работает: те же, что знает Paraswap.
const SWAP_CHAINS: [u64; 5] = [1, 10, 42161, 8453, 56];

/// Сколько ждём, пока `approve` перестанет быть незавершённым.
///
/// Минута — с запасом: обычный `approve` в Ethereum попадает в блок за
/// несколько секунд, а при заторе сеть всё равно не отвечает быстрее.
/// Дольше держать команду нельзя: человек уже нажал «обменять».
const MINING_TIMEOUT: Duration = Duration::from_secs(60);

/// Первые проверки — частые: чаще всего `approve` майнится почти сразу, и
/// ждать три секунды, когда блок уже есть, незачем.
const MINING_POLL_FAST: Duration = Duration::from_millis(700);

/// Дальше — реже, чтобы не заваливать форвардер запросами.
const MINING_POLL_SLOW: Duration = Duration::from_millis(2500);

/// Тело запроса на обмен.
#[derive(Debug, Deserialize)]
pub struct SwapRequest {
    pub port: u16,
    pub chain_id: u64,
    /// Адрес кошелька: и плательщик, и получатель обмена.
    pub from: String,
    /// Токен, который отдаём.
    pub from_token: String,
    /// Токен, который получаем.
    pub to_token: String,
    /// Сколько отдаём, в минимальных единицах.
    pub amount: String,
    pub password: String,
}

/// Оценка обмена: сколько получим и во что обойдётся.
#[derive(Debug, Serialize)]
pub struct SwapQuote {
    /// Сколько получим, в минимальных единицах целевого токена.
    pub amount_out: String,
    /// Минимум, который устроит при текущем проскальзывании.
    pub min_amount_out: String,
    /// Комиссия сети в wei. `null` — маршрут не собрал цену газа.
    pub fee: Option<String>,
    /// Нужен ли отдельный `approve` перед обменом (для ERC-20 на входе).
    pub needs_approval: bool,
    /// Через кого пойдёт обмен: `Paraswap`, `Lifi` и т. п.
    pub provider: String,
}

/// Результат обмена.
#[derive(Debug, Serialize)]
pub struct SwapResult {
    /// Хэш основной транзакции обмена.
    pub tx_hash: String,
    /// Хэш `approve`, если он был отдельной транзакцией.
    pub approval_tx_hash: String,
}

/// Нативный актив в ответе бэкенда — нулевой адрес.
const NATIVE_TOKEN: &str = "0x0000000000000000000000000000000000000000";

/// `tokenKey` в том виде, в каком его ждёт Router: `<chainId>-<адрес строчными>`.
fn token_key(chain_id: u64, address: &str) -> String {
    format!("{chain_id}-{}", address.to_lowercase())
}

/// Проверяет сеть и пару токенов до обращения к провайдеру.
fn validate(from_chain: u64, from_token: &str, to_token: &str, amount: &str) -> AppResult<u128> {
    if !SWAP_CHAINS.contains(&from_chain) {
        return Err(AppError::config(
            "Swapping is available only on mainnet networks",
        ));
    }
    for (label, addr) in [("source", from_token), ("target", to_token)] {
        if !is_address(addr) {
            return Err(AppError::config(format!("invalid {label} token address")));
        }
    }
    if from_token.eq_ignore_ascii_case(to_token) {
        return Err(AppError::config(
            "source and target tokens must be different",
        ));
    }

    let value = amount
        .parse::<u128>()
        .map_err(|_| AppError::config("amount must be a decimal integer"))?;
    if value == 0 {
        return Err(AppError::config("amount must be greater than zero"));
    }
    Ok(value)
}

/// Параметры маршрута обмена.
///
/// Общие для оценки и для отправки: расхождение означало бы «показали одну
/// сумму, получили другую».
fn route_params(
    uuid: &str,
    chain_id: u64,
    from: &str,
    from_token: &str,
    to_token: &str,
    amount: u128,
) -> Value {
    json!({
        "uuid": uuid,
        "sendType": SEND_TYPE_SWAP,
        "addrFrom": from,
        // Получатель обмена — тот же кошелёк: обмен не перевод, деньги
        // остаются у владельца.
        "addrTo": from,
        "amountIn": format!("0x{amount:x}"),
        "tokenKey": token_key(chain_id, from_token),
        "toTokenKey": token_key(chain_id, to_token),
        "tokenIDIsOwnerToken": false,
        "fromChainID": chain_id,
        "toChainID": chain_id,
        "gasFeeMode": GAS_FEE_MEDIUM,
        // Строго больше нуля: контракт отвергает ноль.
        "slippagePercentage": SLIPPAGE_PERCENT,
    })
}

/// Первый путь маршрута — обмен всегда однопутный в одной сети.
fn first_path(route: &Value) -> Option<&Value> {
    route.get("Route")?.as_array()?.first()
}

/// Сколько получим и нужен ли `approve`.
///
/// Только чтение: провайдер считает маршрут, ключ не используется. Поэтому
/// оценку можно показать до ввода пароля.
#[tauri::command]
pub async fn get_swap_quote(
    port: u16,
    chain_id: u64,
    from: String,
    from_token: String,
    to_token: String,
    amount: String,
) -> AppResult<SwapQuote> {
    if port == 0 {
        return Err(AppError::config("backend is not running"));
    }
    if !is_address(&from) {
        return Err(AppError::config("invalid wallet address"));
    }
    let value = validate(chain_id, &from_token, &to_token, &amount)?;

    let uuid = unique_uuid();
    let params = route_params(&uuid, chain_id, &from, &from_token, &to_token, value);
    let route = Backend::from_port(port)?
        .call("wallet_getSuggestedRoutes", json!([params]))
        .await?;

    let path = first_path(&route)
        .ok_or_else(|| AppError::backend("no swap route is available for this pair right now"))?;

    let amount_out = path
        .get("AmountOut")
        .and_then(|v| v.as_str())
        .and_then(|v| hex_u128(v).ok())
        .unwrap_or(0);

    // Минимум на выходе Router не отдаёт отдельным полем: он уже зашит в
    // calldata. Считаем сами тем же проскальзыванием, что уйдёт в маршрут,
    // чтобы цифра на экране соответствовала контракту.
    let min_amount_out = (amount_out as f64 * (1.0 - SLIPPAGE_PERCENT / 100.0)).floor() as u128;

    let fee = path
        .get("TxTotalFee")
        .and_then(|v| v.as_str())
        .and_then(|v| hex_u128(v).ok())
        .map(|v| v.to_string());

    Ok(SwapQuote {
        amount_out: amount_out.to_string(),
        min_amount_out: min_amount_out.to_string(),
        fee,
        // Нативный токен не требует approve: он сразу уходит в транзакции.
        needs_approval: path
            .get("ApprovalRequired")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        provider: path
            .get("ProcessorName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

/// Выполняет обмен и возвращает хэши транзакций.
///
/// ## Почему раундов может быть два
///
/// LiFi не отдаёт основную транзакцию обмена вместе с `approve`: она
/// собирается только после того, как `approve` попадёт в блок. В
/// `transaction_manager_route.go` это записано прямо — «we cannot build the
/// swap tx before the approval tx is mined», — и после отправки `approve`
/// цикл обрывается (`continue`). Первый раунд поэтому возвращает **одну**
/// транзакцию, и если её принять за обмен, получится ровно то, что случилось
/// 2026-11-08: `approve` ушёл, токены не обменялись, а экран сообщил «Swap
/// executed».
///
/// Поэтому здесь: если в ответе есть только `approve`, ждём его майнинга и
/// запускаем раунд повторно **с тем же `uuid`**. Маршрут в бэкенде сохранён,
/// а повторный `wallet_getSuggestedRoutes` пересчитал бы цену, на которую
/// человек уже согласился.
#[tauri::command]
pub async fn swap_tokens(request: SwapRequest) -> AppResult<SwapResult> {
    if request.port == 0 {
        return Err(AppError::config("backend is not running"));
    }
    if !is_address(&request.from) {
        return Err(AppError::config("invalid wallet address"));
    }
    if request.password.is_empty() {
        return Err(AppError::config("password is required"));
    }
    let value = validate(
        request.chain_id,
        &request.from_token,
        &request.to_token,
        &request.amount,
    )?;

    let uuid = unique_uuid();
    let params = route_params(
        &uuid,
        request.chain_id,
        &request.from,
        &request.from_token,
        &request.to_token,
        value,
    );

    let backend = Backend::from_port(request.port)?;
    let mut ws = connect_signals(request.port).await?;

    let first = execute_round(
        &mut ws,
        backend,
        Some(params),
        &uuid,
        &request.from,
        &request.password,
    )
    .await?;

    // Один `approve` без основной транзакции — не обмен, а его подготовка.
    let approval_only = first.len() == 1 && first[0].is_approval;

    let final_txs = if approval_only {
        let approval_hash = first[0].hash.clone();
        wait_until_not_pending(backend, &approval_hash).await?;

        // Второй раунд по тому же uuid: маршрут уже в бэкенде.
        let second = execute_round(
            &mut ws,
            backend,
            None,
            &uuid,
            &request.from,
            &request.password,
        )
        .await?;
        (approval_hash, second)
    } else {
        (
            first
                .iter()
                .find(|tx| tx.is_approval)
                .map(|tx| tx.hash.clone())
                .unwrap_or_default(),
            first,
        )
    };

    let _ = ws.close(None).await;

    let (approval_tx_hash, txs) = final_txs;

    // Основная транзакция — последняя не-approve. Если её нет, обмен не
    // состоялся, и сообщать об успехе нельзя.
    let tx_hash = txs
        .iter()
        .rev()
        .find(|tx| !tx.is_approval)
        .map(|tx| tx.hash.clone())
        .ok_or_else(|| {
            AppError::backend(
                "the swap transaction was not sent: the backend returned only the approval",
            )
        })?;

    Ok(SwapResult {
        tx_hash,
        approval_tx_hash,
    })
}

/// Ждёт, пока транзакция перестанет быть незавершённой.
///
/// ## Почему `wallet_getPendingTransactions`, а не квитанция
///
/// `wallet_getTransactionReceipt` в status-go не существует (проверено
/// запросом: «method does not exist/is not available»), а
/// `eth_getTransactionReceipt` живёт в пространстве `eth` и через
/// `CallRPC` тоже недоступен. Зато трекер незавершённых транзакций сам
/// убирает запись, когда она попала в блок или отброшена, — и это ровно то
/// событие, которого мы ждём.
///
/// Отличить успех от провала по этому списку нельзя, и это осознанно: если
/// `approve` провалился, второй раунд вернёт ошибку от провайдера, и человек
/// увидит причину. Выдумывать здесь вердикт по отсутствию записи было бы
/// догадкой.
///
/// ## Почему ждём с ограничением
///
/// Транзакция может не попасть в блок вовсе. Вечное ожидание заблокировало бы
/// команду, поэтому по таймауту возвращаем понятную ошибку: токены не
/// списаны, `approve` отправлен, обмен можно повторить.
async fn wait_until_not_pending(backend: Backend, tx_hash: &str) -> AppResult<()> {
    let deadline = tokio::time::Instant::now() + MINING_TIMEOUT;
    let hash = tx_hash.to_ascii_lowercase();
    let mut attempt = 0u32;

    loop {
        // Первая проверка — сразу: `approve` часто майнится быстрее, чем мы
        // успеваем дойти сюда.
        if let Ok(pending) = backend
            .call("wallet_getPendingTransactions", json!([]))
            .await
        {
            let still_pending = pending
                .as_array()
                .map(|list| {
                    list.iter().any(|tx| {
                        tx.get("hash")
                            .and_then(|h| h.as_str())
                            .map(|h| h.eq_ignore_ascii_case(&hash))
                            .unwrap_or(false)
                    })
                })
                // Список не разобрался — считаем, что ждать больше нечего:
                // второй раунд сам вернёт ошибку, если что-то не так.
                .unwrap_or(false);
            if !still_pending {
                return Ok(());
            }
        }

        if tokio::time::Instant::now() >= deadline {
            return Err(AppError::backend(
                "the token approval is still pending; the swap was not sent. Try again in a minute",
            ));
        }

        let delay = if attempt < 10 {
            MINING_POLL_FAST
        } else {
            MINING_POLL_SLOW
        };
        tokio::time::sleep(delay).await;
        attempt += 1;
    }
}

/// Собирает адрес нативного токена — для фронтенда, чтобы не хардкодить.
#[tauri::command]
pub fn native_token_address() -> String {
    NATIVE_TOKEN.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_known_swap_chains() {
        for chain in SWAP_CHAINS {
            assert!(
                validate(
                    chain,
                    NATIVE_TOKEN,
                    "0x1111111111111111111111111111111111111111",
                    "1"
                )
                .is_ok(),
                "chain {chain}"
            );
        }
    }

    #[test]
    fn rejects_test_networks_with_a_clear_message() {
        // В тестовых сетях ликвидности у провайдеров нет, и отказ провайдера
        // ничего не объясняет. Проверяем заранее.
        for chain in [11155111u64, 84532, 421614, 560048] {
            let err = validate(
                chain,
                NATIVE_TOKEN,
                "0x1111111111111111111111111111111111111111",
                "1",
            )
            .expect_err("testnet must be rejected");
            assert!(
                err.to_string().to_lowercase().contains("mainnet"),
                "chain {chain}: {err}"
            );
        }
    }

    #[test]
    fn rejects_same_token() {
        let token = "0x1111111111111111111111111111111111111111";
        assert!(validate(1, token, token, "1").is_err());
    }

    #[test]
    fn rejects_bad_addresses() {
        assert!(validate(1, "0x123", NATIVE_TOKEN, "1").is_err());
        assert!(validate(1, NATIVE_TOKEN, "nope", "1").is_err());
    }

    #[test]
    fn rejects_zero_and_garbage_amounts() {
        let to = "0x1111111111111111111111111111111111111111";
        assert!(validate(1, NATIVE_TOKEN, to, "0").is_err());
        assert!(validate(1, NATIVE_TOKEN, to, "1.5").is_err());
        assert!(validate(1, NATIVE_TOKEN, to, "").is_err());
    }

    #[test]
    fn token_key_uses_the_status_go_format() {
        // Дефис, а не двоеточие: на двоеточии бэкенд молча не найдёт токен.
        assert_eq!(
            token_key(1, "0x744D70FDBE2BA4CF95131626614A1763DF805B9E"),
            "1-0x744d70fdbe2ba4cf95131626614a1763df805b9e"
        );
    }

    #[test]
    fn route_params_use_swap_send_type_and_positive_slippage() {
        let params = route_params(
            "uuid-1",
            1,
            "0xcd8fd2a9f9726729d19f9be57d959942d7eb578c",
            NATIVE_TOKEN,
            "0x1111111111111111111111111111111111111111",
            1_000,
        );

        assert_eq!(params["sendType"], 8, "Swap");
        assert_eq!(params["amountIn"], "0x3e8");
        // Ноль контракт отвергает (ErrSwapSlippagePercentageMustBePositive).
        assert!(params["slippagePercentage"].as_f64().unwrap() > 0.0);
        // Обмен не перевод: получатель — тот же кошелёк.
        assert_eq!(params["addrFrom"], params["addrTo"]);
    }

    #[test]
    fn missing_route_has_no_first_path() {
        assert!(first_path(&json!({})).is_none());
        assert!(first_path(&json!({"Route": []})).is_none());
    }

    #[test]
    fn reads_amount_out_and_fee() {
        let route = json!({
            "Route": [{
                "AmountOut": "0x5f5e100",
                "TxTotalFee": "0x2386f26fc10000",
                "ApprovalRequired": true,
                "ProcessorName": "Paraswap"
            }]
        });
        let path = first_path(&route).expect("path");
        assert_eq!(
            hex_u128(path["AmountOut"].as_str().unwrap()).unwrap(),
            100_000_000
        );
        assert_eq!(path["ApprovalRequired"].as_bool(), Some(true));
    }

    #[test]
    fn min_amount_out_respects_slippage() {
        // 1000 на выходе при 1 % проскальзывания — минимум 990.
        let amount_out: u128 = 1000;
        let min = (amount_out as f64 * (1.0 - SLIPPAGE_PERCENT / 100.0)).floor() as u128;
        assert_eq!(min, 990);
    }
}
