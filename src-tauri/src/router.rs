//! Общий путь отправки через Router status-go.
//!
//! ## Зачем отдельный модуль
//!
//! Регистрация ENS и обмен токенов идут через один и тот же механизм: маршрут
//! → сборка → подпись → отправка. Отличаются только параметры маршрута
//! (`sendType`, токены, сумма). Если бы каждая операция реализовывала этот путь
//! сама, любая правка в обработке сигналов делалась бы дважды, и одна из копий
//! неизбежно отстала бы.
//!
//! ## Почему это не похоже на перевод
//!
//! `transfer.rs` — три синхронных вызова. Здесь два шага из четырёх
//! асинхронны: `buildTransactionsFromRoute` и
//! `sendRouterTransactionsWithSignatures` ничего не возвращают, а результат
//! приходит сигналом по WebSocket. Отсюда отдельное соединение к `/signals`.
//!
//! ## Почему подпись здесь, а не в webview
//!
//! Router может вернуть несколько транзакций (например, approve + обмен), и
//! `wallet_signMessage` подписывает любые 32 байта, не зная, что это. Если бы
//! хэши уходили во фронтенд, чужой скрипт мог бы попросить подписать любой из
//! них. Поэтому хэши, пароль и разбор подписи не покидают Rust.

use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{Value, json};

use crate::auth_proxy;
use crate::backend::Backend;
use crate::error::{AppError, AppResult};

/// `fees.GasFeeMode`: Low=0, Medium=1, High=2.
pub const GAS_FEE_MEDIUM: u64 = 1;

/// Сигнал с хэшами, которые нужно подписать.
const SIGNAL_ROUTER_TXS: &str = "wallet.router.sign-transactions";

/// Сигнал о том, что транзакции отправлены.
const SIGNAL_TXS_SENT: &str = "wallet.router.transactions-sent";

/// Сколько ждём ответа бэкенда.
///
/// Сборка маршрута ходит в сеть за газом и ценой провайдера, затем ждёт
/// подписи. На медленной сети и при обмене через агрегатор это небыстро.
const SIGNAL_TIMEOUT: Duration = Duration::from_secs(120);

/// Адрес EVM: `0x` и ровно 40 шестнадцатеричных цифр.
pub fn is_address(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 42
        && bytes[0] == b'0'
        && (bytes[1] == b'x' || bytes[1] == b'X')
        && bytes[2..].iter().all(|b| b.is_ascii_hexdigit())
}

/// Снимает префикс `0x`, если он есть.
pub fn strip_hex_prefix(value: &str) -> &str {
    value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value)
}

/// Читает hex-число из ответа бэкенда (`0x…` или голый hex).
pub fn hex_u128(value: &str) -> AppResult<u128> {
    u128::from_str_radix(strip_hex_prefix(value), 16)
        .map_err(|e| AppError::backend(format!("invalid hex number from backend: {e}")))
}

/// Разбирает 65-байтную подпись на компоненты, как их ждёт status-go.
///
/// `SignatureDetails.Validate` требует ровно 64 hex-символа в `r`, 64 в `s`
/// и 2 в `v`; значение `v` читается как «единица только если строка равна
/// `01`», поэтому 27/28 (как в подписи Ethereum) здесь означали бы `0`.
/// Единицу восстанавливаем сами.
pub fn split_signature(signature: &str) -> AppResult<(String, String, String)> {
    let raw = strip_hex_prefix(signature);
    if raw.len() != 130 {
        return Err(AppError::backend(format!(
            "unexpected signature length: {} hex chars, expected 130",
            raw.len()
        )));
    }

    let r = raw[0..64].to_string();
    let s = raw[64..128].to_string();

    let v_byte = u8::from_str_radix(&raw[128..130], 16)
        .map_err(|e| AppError::backend(format!("invalid signature v: {e}")))?;
    // 0/1 — «сырой» recovery id (так подписывает status-go), 27/28 — вариант
    // Ethereum. Оба приводим к одному виду.
    let v = match v_byte {
        0 | 1 => v_byte,
        27 | 28 => v_byte - 27,
        other => {
            return Err(AppError::backend(format!(
                "unexpected signature v: {other}"
            )));
        }
    };

    Ok((r, s, format!("{v:02x}")))
}

/// Идентификатор запроса для Router.
///
/// Бэкенд хранит только последний маршрут, поэтому достаточно уникальности в
/// пределах процесса. Случайные байты надёжнее счётчика: при перезапуске
/// счётчик начался бы снова, а при двух одновременных запросах совпал бы.
pub fn unique_uuid() -> String {
    let mut buf = [0u8; 8];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom")
        && std::io::Read::read_exact(&mut f, &mut buf).is_ok()
    {
        let hex: String = buf.iter().map(|b| format!("{b:02x}")).collect();
        return format!("stauri-{hex}");
    }

    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("stauri-{nanos:x}")
}

/// Подключение к `/signals` через аутентифицирующий прокси.
///
/// Прокси проверяет токен до upgrade и дальше просто перекачивает байты
/// (`auth_proxy.rs`, `copy_bidirectional`), поэтому WebSocket проходит насквозь.
/// Соединение своё: бэкенд рассылает сигналы во все подключения, так что
/// фронтенд о нём не догадывается и ничего не теряет.
pub async fn connect_signals(
    port: u16,
) -> AppResult<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;

    let token = auth_proxy::token()?;
    let url = format!("ws://127.0.0.1:{port}/signals");
    let mut request = url
        .into_client_request()
        .map_err(|e| AppError::internal(format!("cannot build signals request: {e}")))?;
    request.headers_mut().insert(
        auth_proxy::TOKEN_HEADER,
        HeaderValue::from_str(&token)
            .map_err(|e| AppError::internal(format!("invalid auth token: {e}")))?,
    );

    let (ws, _response) = tokio_tungstenite::connect_async(request)
        .await
        .map_err(|e| AppError::backend(format!("cannot subscribe to signals: {e}")))?;
    Ok(ws)
}

/// Ждёт сигнал заданного типа, относящийся к нашему `uuid`.
///
/// Сигналы чужих запросов (другой uuid) пропускаются: в соединении идёт
/// общий поток, и первый пришедший может быть не нашим.
async fn wait_for_signal<S>(ws: &mut S, signal_type: &str, uuid: &str) -> AppResult<Value>
where
    S: futures_util::Stream<
            Item = Result<
                tokio_tungstenite::tungstenite::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    let deadline = tokio::time::Instant::now() + SIGNAL_TIMEOUT;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err(AppError::backend(
                "the backend did not respond in time; the transaction may still be pending",
            ));
        }

        let message = match tokio::time::timeout(remaining, ws.next()).await {
            Err(_) => {
                return Err(AppError::backend(
                    "the backend did not respond in time; the transaction may still be pending",
                ));
            }
            Ok(None) => {
                return Err(AppError::backend("signals connection closed unexpectedly"));
            }
            Ok(Some(Err(e))) => {
                return Err(AppError::backend(format!("signals connection failed: {e}")));
            }
            Ok(Some(Ok(message))) => message,
        };

        let text = match message {
            tokio_tungstenite::tungstenite::Message::Text(text) => text.to_string(),
            tokio_tungstenite::tungstenite::Message::Binary(bytes) => {
                String::from_utf8_lossy(&bytes).to_string()
            }
            _ => continue,
        };

        let parsed: Value = match serde_json::from_str(&text) {
            Ok(v) => v,
            Err(_) => continue,
        };

        if parsed.get("type").and_then(|t| t.as_str()) != Some(signal_type) {
            continue;
        }

        let event = parsed.get("event").cloned().unwrap_or(Value::Null);
        // uuid лежит в sendDetails; сигнал другого запроса нам не подходит.
        let matches_uuid = event
            .get("sendDetails")
            .and_then(|d| d.get("uuid"))
            .and_then(|u| u.as_str())
            .map(|u| u == uuid)
            .unwrap_or(false);
        if !matches_uuid {
            continue;
        }

        // Ошибку бэкенд кладёт в sendDetails.errorResponse.
        if let Some(err) = event
            .get("sendDetails")
            .and_then(|d| d.get("errorResponse"))
            .filter(|e| !e.is_null())
        {
            let details = err
                .get("details")
                .and_then(|d| d.as_str())
                .or_else(|| err.get("message").and_then(|m| m.as_str()))
                .unwrap_or("the backend rejected the route");
            return Err(AppError::backend(details.to_string()));
        }

        return Ok(event);
    }
}

/// Выполняет маршрут целиком и возвращает хэши отправленных транзакций.
///
/// Подключение к сигналам открывается ДО первого запроса: сборка маршрута
/// может ответить быстрее, чем мы успели бы подписаться, и тогда сигнал ушёл
/// бы в пустоту.
pub async fn execute_route(
    backend: Backend,
    params: Value,
    from: &str,
    password: &str,
) -> AppResult<Vec<String>> {
    let uuid = params
        .get("uuid")
        .and_then(|u| u.as_str())
        .ok_or_else(|| AppError::internal("route params have no uuid"))?
        .to_string();

    let signals_port = backend
        .signals_port()
        .ok_or_else(|| AppError::backend("signals are not available for this backend"))?;
    let mut ws = connect_signals(signals_port).await?;
    let sent = execute_round(&mut ws, backend, Some(params), &uuid, from, password).await?;
    let _ = ws.close(None).await;

    Ok(sent.into_iter().map(|tx| tx.hash).collect())
}

/// Отправленная транзакция из сигнала `wallet.router.transactions-sent`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SentTx {
    pub hash: String,
    /// Это `approve`, а не основная операция.
    pub is_approval: bool,
}

/// Один раунд «собрать → подписать → отправить».
///
/// ## Зачем параметры опциональны
///
/// `wallet_getSuggestedRoutes` запоминает маршрут в бэкенде под `uuid`. Второй
/// раунд (у обмена после майнинга `approve`) переиспользует **тот же** маршрут
/// и тот же `uuid`, поэтому параметры ему не нужны: повторный запрос маршрута
/// пересчитал бы его заново и подменил бы цену, на которую человек согласился.
///
/// ## Почему раунд может вернуть только `approve`
///
/// LiFi строит основную транзакцию обмена только после того, как `approve`
/// попадёт в блок (`transaction_manager_route.go`: «we cannot build the swap tx
/// before the approval tx is mined»). Поэтому первый раунд у обмена с
/// ERC-20 на входе отдаёт **одну** транзакцию, и вызывающий обязан дождаться
/// её майнинга и запустить раунд ещё раз.
pub async fn execute_round<S>(
    ws: &mut S,
    backend: Backend,
    params: Option<Value>,
    uuid: &str,
    from: &str,
    password: &str,
) -> AppResult<Vec<SentTx>>
where
    S: futures_util::Stream<
            Item = Result<
                tokio_tungstenite::tungstenite::Message,
                tokio_tungstenite::tungstenite::Error,
            >,
        > + Unpin,
{
    // 1. Маршрут. Только в первом раунде.
    if let Some(params) = params {
        backend
            .call("wallet_getSuggestedRoutes", json!([params]))
            .await?;
    }

    // 2. Собрать транзакции.
    backend
        .call("wallet_buildTransactionsFromRoute", json!([uuid]))
        .await?;

    let built = wait_for_signal(ws, SIGNAL_ROUTER_TXS, uuid).await?;

    let hashes = signing_hashes(&built);
    if hashes.is_empty() {
        return Err(AppError::backend(
            "the backend returned no transactions to sign",
        ));
    }

    // 3. Подписать каждый хэш. Пароль живёт только внутри этого цикла.
    let mut signatures = serde_json::Map::new();
    for hash in &hashes {
        let signature = backend
            .call("wallet_signMessage", json!([hash, from, password]))
            .await?
            .as_str()
            .ok_or_else(|| AppError::backend("backend returned no signature"))?
            .to_string();

        let (r, s, v) = split_signature(&signature)?;
        // Ключ — хэш в том же виде, в каком его отдал Router: по нему
        // бэкенд сопоставляет подпись с транзакцией.
        signatures.insert(hash.clone(), json!({ "r": r, "s": s, "v": v }));
    }

    // 4. Отправить.
    backend
        .call(
            "wallet_sendRouterTransactionsWithSignatures",
            json!([{ "uuid": uuid, "signatures": signatures }]),
        )
        .await?;

    let sent = wait_for_signal(ws, SIGNAL_TXS_SENT, uuid).await?;

    let txs = sent_transactions(&sent);
    if txs.is_empty() {
        return Err(AppError::backend("backend returned no transaction hash"));
    }

    Ok(txs)
}

/// Хэши для подписи из сигнала `wallet.router.sign-transactions`.
fn signing_hashes(event: &Value) -> Vec<String> {
    event
        .get("signingDetails")
        .and_then(|d| d.get("hashes"))
        .and_then(|h| h.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|v| v.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default()
}

/// Отправленные транзакции из сигнала `wallet.router.transactions-sent`.
///
/// Флаг `approvalTx` обязателен: по нему отличают `approve` от основной
/// операции. Без него обмен с несостоявшейся второй транзакцией выглядел бы
/// как успешный.
fn sent_transactions(event: &Value) -> Vec<SentTx> {
    event
        .get("sentTransactions")
        .and_then(|t| t.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|t| {
                    t.get("hash").and_then(|h| h.as_str()).map(|s| SentTx {
                        hash: s.to_string(),
                        is_approval: t
                            .get("approvalTx")
                            .and_then(|a| a.as_bool())
                            .unwrap_or(false),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn splits_signature_into_components() {
        // 64 + 64 + 2 hex-символа — ровно то, что требует SignatureDetails.
        let signature = format!("0x{}{}{}", "11".repeat(32), "22".repeat(32), "01");
        let (r, s, v) = split_signature(&signature).expect("valid signature");
        assert_eq!(r, "11".repeat(32));
        assert_eq!(s, "22".repeat(32));
        assert_eq!(v, "01");
    }

    #[test]
    fn normalizes_ethereum_v_values() {
        let with_27 = format!("0x{}{}1b", "00".repeat(32), "00".repeat(32));
        let (_, _, v) = split_signature(&with_27).expect("valid signature");
        assert_eq!(v, "00", "27 means recovery id 0");

        let with_28 = format!("0x{}{}1c", "00".repeat(32), "00".repeat(32));
        let (_, _, v) = split_signature(&with_28).expect("valid signature");
        assert_eq!(v, "01", "28 means recovery id 1");
    }

    #[test]
    fn rejects_malformed_signatures() {
        assert!(split_signature("0xdeadbeef").is_err(), "too short");
        let bad_v = format!("0x{}{}ff", "00".repeat(32), "00".repeat(32));
        assert!(split_signature(&bad_v).is_err(), "v out of range");
    }

    #[test]
    fn uuid_is_unique_and_prefixed() {
        let a = unique_uuid();
        let b = unique_uuid();
        assert!(a.starts_with("stauri-"));
        assert_ne!(a, b);
    }

    #[test]
    fn recognizes_addresses() {
        assert!(is_address("0xcd8fd2a9f9726729d19f9be57d959942d7eb578c"));
        assert!(!is_address("0x123"));
        assert!(!is_address("cd8fd2a9f9726729d19f9be57d959942d7eb578c"));
    }

    #[test]
    fn reads_hex_numbers_with_and_without_prefix() {
        assert_eq!(hex_u128("0x10").unwrap(), 16);
        assert_eq!(hex_u128("10").unwrap(), 16);
        assert!(hex_u128("0xzz").is_err());
    }

    #[test]
    fn extracts_signing_hashes() {
        let event = json!({
            "signingDetails": { "hashes": ["0xaa", "0xbb"] }
        });
        assert_eq!(signing_hashes(&event), vec!["0xaa", "0xbb"]);
    }

    #[test]
    fn missing_signing_hashes_is_empty_not_error() {
        assert!(signing_hashes(&json!({})).is_empty());
        assert!(signing_hashes(&json!({"signingDetails": {}})).is_empty());
    }

    #[test]
    fn extracts_sent_transactions_with_approval_flag() {
        let event = json!({
            "sentTransactions": [
                { "hash": "0xaa", "approvalTx": false },
                { "hash": "0xbb", "approvalTx": true }
            ]
        });
        // Возвращаются все: у обмена их два (approve + сам обмен), и
        // показать надо последний, но решать это вызывающему.
        assert_eq!(
            sent_transactions(&event),
            vec![
                SentTx {
                    hash: "0xaa".to_string(),
                    is_approval: false
                },
                SentTx {
                    hash: "0xbb".to_string(),
                    is_approval: true
                },
            ]
        );
    }

    #[test]
    fn approval_only_batch_is_recognized() {
        // Ровно то, что приходит первым раундом у обмена через LiFi: одна
        // транзакция approve, потому что основную нельзя собрать до её
        // майнинга. Вызывающий обязан это увидеть и запустить второй раунд.
        let event = json!({
            "sentTransactions": [
                { "hash": "0x394f", "approvalTx": true }
            ]
        });
        let txs = sent_transactions(&event);
        assert_eq!(txs.len(), 1);
        assert!(txs[0].is_approval);
    }

    #[test]
    fn missing_sent_transactions_is_empty_not_error() {
        assert!(sent_transactions(&json!({})).is_empty());
        assert!(sent_transactions(&json!({"sentTransactions": []})).is_empty());
    }
}
