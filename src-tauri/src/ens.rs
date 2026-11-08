//! Регистрация имени ENS вида `<имя>.stateofus.eth`.
//!
//! ## Почему это не похоже на перевод
//!
//! Обычный перевод — три синхронных вызова (`transfer.rs`). Регистрация идёт
//! через Router, и там статус-го устроен иначе:
//!
//! ```text
//! wallet_getSuggestedRoutes(input)            → маршрут + uuid   (синхронно)
//! wallet_buildTransactionsFromRoute(uuid)     → НИЧЕГО не возвращает
//!    ⟶ сигнал wallet.router.sign-transactions   {signingDetails.hashes}
//! wallet_signMessage(hash, from, password)    × N
//! wallet_sendRouterTransactionsWithSignatures({uuid, signatures})
//!    ⟶ сигнал wallet.router.transactions-sent   {sentTransactions[].hash}
//! ```
//!
//! Сам механизм сигналов и подписей живёт в `router.rs` — он общий с обменом
//! токенов. Здесь только то, что специфично для регистрации имени.
//!
//! ## Почему оркестрация в Rust, а не в компоненте
//!
//! Здесь подписывается не одна заранее известная транзакция, а столько,
//! сколько вернул Router. Если бы хэши приходили в webview, тот мог бы
//! попросить подписать любой из них — `wallet_signMessage` не знает, что
//! именно подписывает. Поэтому хэши остаются здесь: наружу уходит только
//! «зарегистрируй такое-то имя», а пароль и последовательность подписей
//! не покидают Rust. Тот же принцип, что в `send_transfer`.
//!
//! ## Почему через Router, а не `ens_register`
//!
//! В собранном бэкенде (status-go v10.35.0-167) метода `ens_register` нет:
//! служба `ens` отдаёт только чтение (`ens_price`, `ens_ownerOf`,
//! `ens_expireAt`, `ens_addressOf`). Регистрация идёт маршрутом с
//! `SendType: ENSRegister`, где оплата — в SNT на mainnet и в STT на Sepolia.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::backend_rpc::call;
use crate::error::{AppError, AppResult};
use crate::router::{
    GAS_FEE_MEDIUM, execute_route, hex_u128, is_address, strip_hex_prefix, unique_uuid,
};

/// `SendType` из `pkg/services/wallet/router/sendtype/send_type.go`:
/// Transfer=0, ENSRegister=1, ENSRelease=2, ENSSetPubKey=3, StickersBuy=4,
/// Bridge=5, ERC721Transfer=6, ERC1155Transfer=7, Swap=8, …
const SEND_TYPE_ENS_REGISTER: u64 = 1;

/// Адрес контракта SNT/STT по сети.
///
/// Нужен как `tokenKey` в параметрах маршрута: Router сверяет его с адресом
/// из `internal/contracts/snt/address.go` и отвергает любой другой
/// (`ErrENSRegisterTestnetSTTOnly` / `ErrENSRegisterMainnetSNTOnly`).
///
/// Регистрация поддерживается только на mainnet и Sepolia — там же, где
/// развёрнут контракт (`ENSRegisterProcessor.AvailableFor`).
fn snt_address(chain_id: u64) -> AppResult<&'static str> {
    match chain_id {
        1 => Ok("0x744d70fdbe2ba4cf95131626614a1763df805b9e"),
        11155111 => Ok("0xE452027cdEF746c7Cd3DB31CB700428b16cD8E51"),
        _ => Err(AppError::config(
            "ENS registration is only available on Ethereum mainnet and Sepolia",
        )),
    }
}

/// `tokenKey` в том виде, в каком его ждёт Router: `<chainId>-<адрес строчными>`.
fn token_key(chain_id: u64) -> AppResult<String> {
    Ok(format!(
        "{chain_id}-{}",
        snt_address(chain_id)?.to_lowercase()
    ))
}

/// Тело запроса на регистрацию.
#[derive(Debug, Deserialize)]
pub struct EnsRegisterRequest {
    /// Порт аутентифицирующего прокси.
    pub port: u16,
    pub chain_id: u64,
    /// Адрес кошелька, с которого платим SNT и которому достанется имя.
    pub from: String,
    /// Имя без домена: `myname` → `myname.stateofus.eth`.
    pub username: String,
    /// Пароль профиля. Используется только внутри этого вызова.
    pub password: String,
}

/// Результат регистрации.
#[derive(Debug, Serialize)]
pub struct EnsRegisterResult {
    /// Хэш транзакции регистрации.
    pub tx_hash: String,
    /// Полное имя, которое уйдёт в базу профиля.
    pub full_name: String,
}

/// Сколько стоит имя и свободно ли оно.
#[derive(Debug, Serialize)]
pub struct EnsQuote {
    /// Цена в минимальных единицах SNT/STT (строкой: 18 знаков не влезают в f64).
    pub price: String,
    /// Комиссия сети в wei. `null` — маршрут не собрался или цену газа не дали.
    ///
    /// Именно `null`, а не `"0"`: ноль в этом поле читается как «перевод
    /// бесплатный», хотя на деле комиссия неизвестна и уйдёт из кошелька.
    pub fee: Option<String>,
    /// Срок действия, hex. `0` — имени нет.
    pub expires_at: String,
    /// Владелец. Пустая строка — имя свободно.
    pub owner: String,
    pub available: bool,
}

/// Проверяет имя до обращения к сети.
///
/// Правила взяты из контракта: имя — это один label, то есть буквы, цифры и
/// дефис; точка недопустима (иначе `a.b` превратилось бы в `a.b.stateofus.eth`,
/// где `a.b` — уже не label). Длину ограничиваем разумной: короткие имена
/// контракт позволяет «слэшить» (отобрать), а слишком длинные незачем.
fn validate_username(username: &str) -> AppResult<()> {
    let name = username.trim();
    if name.is_empty() {
        return Err(AppError::config("name is required"));
    }
    if name.len() < 3 || name.len() > 31 {
        return Err(AppError::config("name must be 3 to 31 characters long"));
    }
    if name.starts_with('-') || name.ends_with('-') {
        return Err(AppError::config("name must not start or end with a hyphen"));
    }
    if !name
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
    {
        return Err(AppError::config(
            "name may contain only lowercase letters, digits and hyphens",
        ));
    }
    Ok(())
}

/// Полное имя, под которым оно хранится у профиля.
fn full_name(username: &str) -> String {
    format!("{}.stateofus.eth", username.trim())
}

/// Имя в том виде, в каком его ждёт `ens_ownerOf`.
///
/// ## Почему не всё равно
///
/// В status-go два чтения одного имени хешируют его по-разному, и это не
/// наша ошибка — так написано в исходниках:
///
///   * `ens_ownerOf` → `EnsResolver.OwnerOf` (pkg/services/ens/ensresolver/
///     resolver.go:141) сначала вызывает `ValidateENSUsername`, а тот
///     требует суффикс `.eth` и отвечает «user name must be a valid ENS name
///     ending with .eth» на голое имя. Пройдя проверку, резолвер срезает
///     `.stateofus.eth` и хеширует остаток (:168) — то есть label;
///   * `ens_expireAt` → `EnsResolver.ExpireAt` (там же, :242) проверки не
///     делает вовсе и хеширует строку как есть.
///
/// Поэтому владельца спрашиваем полным именем (иначе отказ), а срок — голым
/// (иначе получили бы срок совсем другого label).
fn owner_lookup_name(username: &str) -> String {
    full_name(username)
}

/// Имя в том виде, в каком его ждёт `ens_expireAt`. См. `owner_lookup_name`.
fn expire_lookup_name(username: &str) -> &str {
    username.trim()
}

/// Параметры маршрута для регистрации.
///
/// Вынесены отдельно, чтобы экран подтверждения и сама отправка считали
/// одинаково: расхождение здесь означало бы «показали одну цену, заплатили
/// другую».
fn route_params(
    uuid: &str,
    chain_id: u64,
    from: &str,
    username: &str,
    public_key: &str,
    amount: u128,
) -> AppResult<Value> {
    let key = token_key(chain_id)?;
    Ok(json!({
        "uuid": uuid,
        "sendType": SEND_TYPE_ENS_REGISTER,
        "addrFrom": from,
        "addrTo": from,
        "amountIn": format!("0x{amount:x}"),
        "amountOut": "0x0",
        "tokenKey": key,
        "toTokenKey": key,
        "tokenIDIsOwnerToken": false,
        "fromChainID": chain_id,
        "toChainID": chain_id,
        "gasFeeMode": GAS_FEE_MEDIUM,
        "slippagePercentage": 0,
        "username": username,
        "publicKey": public_key,
    }))
}

/// Публичный ключ кошелька — из аккаунтов профиля, а не от фронтенда.
///
/// `ExtractCoordinates` в status-go режет строку как `0x04` + X + Y, поэтому
/// принимаем только такую форму: с другим ключом регистрация соберёт
/// calldata с нулями, и имя будет записано на мусорный публичный ключ.
async fn public_key_of(port: u16, from: &str) -> AppResult<String> {
    let accounts = call(port, "accounts_getAccounts", json!([])).await?;
    let list = accounts
        .as_array()
        .ok_or_else(|| AppError::backend("backend returned no accounts"))?;

    for account in list {
        let address = account
            .get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if !address.eq_ignore_ascii_case(from) {
            continue;
        }
        let key = account
            .get("public-key")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        // Без `0x04…` Router не сможет разобрать координаты.
        let key = strip_hex_prefix(key);
        if key.len() != 130 || !key.starts_with("04") {
            return Err(AppError::backend(
                "wallet account has no usable public key for ENS",
            ));
        }
        return Ok(format!("0x{key}"));
    }

    Err(AppError::config("account not found in this profile"))
}

/// Сколько стоит имя и свободно ли оно.
///
/// Всё только чтение: ни подписи, ни пароля не нужно. Комиссию сети берём из
/// того же маршрута, по которому потом пойдёт регистрация, поэтому цифра на
/// экране подтверждения — не отдельная догадка, а та же оценка.
#[tauri::command]
pub async fn get_ens_quote(
    port: u16,
    chain_id: u64,
    from: String,
    username: String,
) -> AppResult<EnsQuote> {
    if port == 0 {
        return Err(AppError::config("backend is not running"));
    }
    validate_username(&username)?;
    if !is_address(&from) {
        return Err(AppError::config("invalid wallet address"));
    }
    // Проверяем сеть до запросов: на прочих сетях регистрации нет.
    snt_address(chain_id)?;

    let name = username.trim();

    let price_raw = call(port, "ens_price", json!([chain_id]))
        .await?
        .as_str()
        .unwrap_or("0")
        .to_string();
    let price = hex_u128(&price_raw).unwrap_or(0);

    // Владелец: нулевой адрес означает «свободно».
    //
    // Ошибку НЕ проглатываем. Раньше здесь стоял `.ok()`, и отказ валидации
    // превращался в пустой владелец, то есть занятое имя выглядело свободным —
    // а дальше человек платил бы за регистрацию, которую контракт отклонит.
    let owner_raw = call(
        port,
        "ens_ownerOf",
        json!([chain_id, owner_lookup_name(name)]),
    )
    .await?;
    let owner = owner_raw.as_str().unwrap_or_default().to_string();
    let zero = "0x0000000000000000000000000000000000000000";
    let available = owner.is_empty() || owner == zero || owner.eq_ignore_ascii_case("0x0");

    // Срок действия — справочно: если его не удалось прочитать, это не повод
    // отказывать в цене и занятости.
    let expires_at = call(
        port,
        "ens_expireAt",
        json!([chain_id, expire_lookup_name(name)]),
    )
    .await
    .ok()
    .and_then(|v| v.as_str().map(|s| s.to_string()))
    .unwrap_or_else(|| "0".to_string());

    // Комиссия сети. Маршрут может не собраться (нет SNT на балансе, газ
    // недоступен) — это не повод отказывать в цене и занятости имени, но и
    // показывать ноль вместо «неизвестно» нельзя.
    let mut fee: Option<String> = None;
    if let Ok(public_key) = public_key_of(port, &from).await {
        let uuid = unique_uuid();
        if let Ok(params) = route_params(&uuid, chain_id, &from, name, &public_key, price)
            && let Ok(route) = call(port, "wallet_getSuggestedRoutes", json!([params])).await
        {
            fee = route_fee(&route);
        }
    }

    Ok(EnsQuote {
        price: price.to_string(),
        fee,
        expires_at,
        owner: if available { String::new() } else { owner },
        available,
    })
}

/// Комиссия сети из маршрута (`Route[0].TxTotalFee`, hex wei).
fn route_fee(route: &Value) -> Option<String> {
    let first = route.get("Route")?.as_array()?.first()?;
    let raw = first.get("TxTotalFee")?.as_str()?;
    let value = hex_u128(raw).ok()?;
    Some(value.to_string())
}

/// Регистрирует имя и возвращает хэш транзакции.
#[tauri::command]
pub async fn register_ens_name(request: EnsRegisterRequest) -> AppResult<EnsRegisterResult> {
    if request.port == 0 {
        return Err(AppError::config("backend is not running"));
    }
    validate_username(&request.username)?;
    if !is_address(&request.from) {
        return Err(AppError::config("invalid wallet address"));
    }
    if request.password.is_empty() {
        return Err(AppError::config("password is required"));
    }
    snt_address(request.chain_id)?;

    let name = request.username.trim();
    let public_key = public_key_of(request.port, &request.from).await?;

    // Цену берём у контракта, а не у фронтенда: сумму approve определяет
    // регистратор, и любая другая цифра означала бы отказ контракта.
    let price_hex = call(request.port, "ens_price", json!([request.chain_id]))
        .await?
        .as_str()
        .unwrap_or("0")
        .to_string();
    let price = hex_u128(&price_hex)?;

    let uuid = unique_uuid();
    let params = route_params(
        &uuid,
        request.chain_id,
        &request.from,
        name,
        &public_key,
        price,
    )?;

    let hashes = execute_route(request.port, params, &request.from, &request.password).await?;

    // У регистрации одна транзакция (approveAndCall делает approve внутри).
    // Берём последний хэш: если Router всё же добавит отдельный approve,
    // интересен именно он, а не подготовительный.
    let tx_hash = hashes
        .last()
        .cloned()
        .ok_or_else(|| AppError::backend("backend returned no transaction hash"))?;

    Ok(EnsRegisterResult {
        tx_hash,
        full_name: full_name(name),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_plain_names() {
        for name in ["myname", "my-name", "abc", "name123"] {
            assert!(validate_username(name).is_ok(), "{name} should be accepted");
        }
    }

    #[test]
    fn rejects_names_that_are_not_a_single_label() {
        // С точкой ушло бы «a.b.stateofus.eth» — это уже другой label.
        assert!(validate_username("a.b").is_err());
        assert!(validate_username("Name").is_err(), "uppercase");
        assert!(validate_username("na me").is_err(), "space");
        assert!(validate_username("").is_err());
        assert!(validate_username("ab").is_err(), "too short");
        assert!(validate_username("-abc").is_err(), "leading hyphen");
        assert!(validate_username("abc-").is_err(), "trailing hyphen");
        let long = "a".repeat(32);
        assert!(validate_username(&long).is_err(), "too long");
    }

    #[test]
    fn builds_full_name() {
        assert_eq!(full_name("myname"), "myname.stateofus.eth");
        // Пробелы по краям не должны попадать в имя.
        assert_eq!(full_name("  myname  "), "myname.stateofus.eth");
    }

    /// Расхождение status-go: владельца спрашивают полным именем, срок — голым.
    ///
    /// Оба утверждения — не стилистика, а условие работоспособности:
    /// `ens_ownerOf` отвергает голое имя (а раньше ошибка глушилась через
    /// `.ok()`, и занятое имя выглядело свободным), а `ens_expireAt` с полным
    /// именем хеширует не тот label.
    #[test]
    fn owner_and_expiry_are_looked_up_differently() {
        assert_eq!(owner_lookup_name("myname"), "myname.stateofus.eth");
        assert_eq!(expire_lookup_name("myname"), "myname");
        assert_eq!(owner_lookup_name("  myname "), "myname.stateofus.eth");
        assert_eq!(expire_lookup_name("  myname "), "myname");
        assert_ne!(expire_lookup_name("myname"), "myname.stateofus.eth");
    }

    #[test]
    fn token_key_matches_status_go_format() {
        // `<chainId>-<адрес строчными>`: так же строит TokenKey в status-go.
        assert_eq!(
            token_key(11155111).unwrap(),
            "11155111-0xe452027cdef746c7cd3db31cb700428b16cd8e51"
        );
        assert_eq!(
            token_key(1).unwrap(),
            "1-0x744d70fdbe2ba4cf95131626614a1763df805b9e"
        );
    }

    #[test]
    fn rejects_chains_without_a_registrar() {
        for chain in [10u64, 8453, 42161, 56] {
            assert!(snt_address(chain).is_err(), "chain {chain}");
        }
    }

    #[test]
    fn route_params_carry_everything_the_router_requires() {
        let params = route_params(
            "uuid-1",
            11155111,
            "0xcd8fd2a9f9726729d19f9be57d959942d7eb578c",
            "myname",
            "0x04aa",
            1_000,
        )
        .expect("params");

        assert_eq!(params["sendType"], 1, "ENSRegister");
        assert_eq!(params["gasFeeMode"], 1, "medium");
        assert_eq!(params["amountIn"], "0x3e8");
        // Получатель совпадает с отправителем: имя принадлежит плательщику.
        assert_eq!(params["addrFrom"], params["addrTo"]);
        assert_eq!(params["tokenKey"], params["toTokenKey"]);
        assert_eq!(params["username"], "myname");
        assert_eq!(params["fromChainID"], 11155111);
        assert_eq!(params["toChainID"], 11155111);
    }

    #[test]
    fn reads_fee_from_route() {
        let route = json!({
            "Route": [ { "TxTotalFee": "0x1bc16d674ec80000" } ]
        });
        assert_eq!(route_fee(&route).as_deref(), Some("2000000000000000000"));
    }

    #[test]
    fn missing_fee_is_not_an_error() {
        assert!(route_fee(&json!({ "Route": [] })).is_none());
        assert!(route_fee(&json!({})).is_none());
    }
}
