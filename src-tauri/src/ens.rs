//! Registration of an ENS name of the form `<name>.stateofus.eth`.
//!
//! This does not look like a transfer. A plain transfer is three synchronous
//! calls (`transfer.rs`), while registration goes through the Router, where
//! status-go works differently:
//!
//! ```text
//! wallet_getSuggestedRoutes(input)            → route + uuid   (synchronous)
//! wallet_buildTransactionsFromRoute(uuid)     → returns NOTHING
//!    ⟶ signal wallet.router.sign-transactions   {signingDetails.hashes}
//! wallet_signMessage(hash, from, password)    × N
//! wallet_sendRouterTransactionsWithSignatures({uuid, signatures})
//!    ⟶ signal wallet.router.transactions-sent   {sentTransactions[].hash}
//! ```
//!
//! The signal and signature machinery itself lives in `router.rs` — it is
//! shared with token swaps. Only what is specific to name registration is here.
//!
//! The orchestration is in Rust, not in a component, because the number of
//! transactions to sign is not known in advance: it is whatever the Router
//! returned. If the hashes reached the webview, it could ask to sign any of
//! them — `wallet_signMessage` does not know what it is signing. The hashes
//! therefore stay here: only "register this name" crosses the boundary, while
//! the password and the sequence of signatures do not leave Rust. Same
//! principle as in `send_transfer`.
//!
//! The Router is used because the built backend (status-go v10.35.0-167) has no
//! `ens_register` method: the `ens` service is read-only (`ens_price`,
//! `ens_ownerOf`, `ens_expireAt`, `ens_addressOf`). Registration goes through a
//! route with `SendType: ENSRegister`, paid in SNT on mainnet and STT on
//! Sepolia.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha3::{Digest, Keccak256};

use crate::core::backend::Backend;
use crate::core::error::{AppError, AppResult};
use crate::router::{
    GAS_FEE_MEDIUM, execute_route, hex_u128, is_address, strip_hex_prefix, unique_uuid,
};

/// `SendType` from `pkg/services/wallet/router/sendtype/send_type.go`:
/// Transfer=0, ENSRegister=1, ENSRelease=2, ENSSetPubKey=3, StickersBuy=4,
/// Bridge=5, ERC721Transfer=6, ERC1155Transfer=7, Swap=8, …
///
/// Only registration goes through the Router. The chat-key rewrite does not:
/// the Router asks status-go for the resolver address, status-go asks the ENS
/// Universal Resolver, and for `.stateofus.eth` that answers with a read-only
/// resolver (`0x394d…` on mainnet) instead of the contract holding the records
/// (`0x5FfC…`). The result is `execution reverted` on gas estimation. See
/// [`update_ens_public_key`].
const SEND_TYPE_ENS_REGISTER: u64 = 1;

/// SNT/STT contract address per network.
///
/// Needed as `tokenKey` in the route parameters: the Router compares it with
/// the address from `internal/contracts/snt/address.go` and rejects any other
/// (`ErrENSRegisterTestnetSTTOnly` / `ErrENSRegisterMainnetSNTOnly`).
///
/// Registration is supported only on mainnet and Sepolia, where the contract is
/// deployed (`ENSRegisterProcessor.AvailableFor`).
///
/// # Errors
/// `ErrorKind::Config` for any other chain.
fn snt_address(chain_id: u64) -> AppResult<&'static str> {
    match chain_id {
        1 => Ok("0x744d70fdbe2ba4cf95131626614a1763df805b9e"),
        11155111 => Ok("0xE452027cdEF746c7Cd3DB31CB700428b16cD8E51"),
        _ => Err(AppError::config(
            "ENS registration is only available on Ethereum mainnet and Sepolia",
        )),
    }
}

/// `tokenKey` in the form the Router expects: `<chainId>-<lowercase address>`.
///
/// # Errors
/// Whatever [`snt_address`] returns for an unsupported chain.
fn token_key(chain_id: u64) -> AppResult<String> {
    Ok(format!(
        "{chain_id}-{}",
        snt_address(chain_id)?.to_lowercase()
    ))
}

/// Registration request body.
#[derive(Debug, Deserialize)]
pub struct EnsRegisterRequest {
    pub chain_id: u64,
    /// Wallet address paying in SNT and receiving the name.
    pub from: String,
    /// Name without the domain: `myname` → `myname.stateofus.eth`.
    pub username: String,
    /// Profile password. Used only inside this call.
    pub password: String,
}

/// Registration result.
#[derive(Debug, Serialize)]
pub struct EnsRegisterResult {
    /// Hash of the registration transaction.
    pub tx_hash: String,
    /// Full name to be stored in the profile database.
    pub full_name: String,
}

/// What the name costs and whether it is free.
#[derive(Debug, Serialize)]
pub struct EnsQuote {
    /// Price in the smallest unit of SNT/STT (a string: 18 digits do not fit
    /// in f64).
    pub price: String,
    /// Network fee in wei. `null` when the route could not be built or no gas
    /// price was given.
    ///
    /// `null` rather than `"0"`: a zero in this field reads as "the transfer is
    /// free", when in fact the fee is unknown and will be taken from the
    /// wallet.
    pub fee: Option<String>,
    /// Expiry, hex. `0` means the name does not exist.
    pub expires_at: String,
    /// Owner. An empty string means the name is free.
    pub owner: String,
    pub available: bool,
}

/// Validates the name before any network access.
///
/// The rules come from the contract: a name is a single label, i.e. letters,
/// digits and hyphens; a dot is not allowed (otherwise `a.b` would become
/// `a.b.stateofus.eth`, where `a.b` is no longer a label). The length is capped
/// at a sensible range: short names can be slashed by the contract, and
/// excessively long ones serve no purpose.
///
/// # Errors
/// `ErrorKind::Config` for an empty name, a length outside 3..=31, a leading or
/// trailing hyphen, or a character outside lowercase letters, digits and
/// hyphens.
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

/// Full name under which the profile stores it.
fn full_name(username: &str) -> String {
    format!("{}.stateofus.eth", username.trim())
}

/// ENS `namehash`, as the registry computes it.
///
/// @param name - Full name, e.g. `stauri.stateofus.eth`.
/// @returns The 32-byte node.
/// @remarks
/// Right to left, each label is hashed with keccak256 and folded into the
/// running node: `node = keccak256(node ‖ keccak256(label))`. Needed because the
/// chat-key rewrite builds its own `setPubkey(node, x, y)` calldata instead of
/// going through the Router, which would compute the node internally.
///
/// Lowercased first: ENS names are case-insensitive, while a case-sensitive
/// hash would produce a node nobody else looks at.
fn namehash(name: &str) -> [u8; 32] {
    let mut node = [0u8; 32];
    let lower = name.trim().to_lowercase();
    if lower.is_empty() {
        return node;
    }
    for label in lower.split('.').rev() {
        let label_hash = Keccak256::digest(label.as_bytes());
        let mut hasher = Keccak256::new();
        hasher.update(node);
        hasher.update(label_hash);
        node.copy_from_slice(&hasher.finalize());
    }
    node
}

/// `setPubkey(bytes32,bytes32,bytes32)` selector.
const SET_PUBKEY_SELECTOR: &str = "29cd62ea";

/// Resolver that holds the `.stateofus.eth` records.
///
/// @param chain_id - Network the name lives on.
/// @returns The resolver address.
/// @remarks
/// Deliberately not asked from status-go: its lookup goes through the ENS
/// Universal Resolver, which for these names answers with a resolver that can
/// only read. The contract below is the one that holds the records — its
/// `pubkey(node)` returns the stored key and its `setPubkey` accepts a call from
/// the name owner.
///
/// Mainnet only: the same address has no code on Sepolia, and the Sepolia
/// deployment has not been verified the same way.
fn stateofus_resolver(chain_id: u64) -> AppResult<&'static str> {
    match chain_id {
        1 => Ok("0x5FfC014343cd971B7eb70732021E26C35B744cc4"),
        _ => Err(AppError::config(
            "rewriting the chat key is supported only on Ethereum mainnet",
        )),
    }
}

/// Calldata for `setPubkey(node, x, y)`.
///
/// @param full_name - Name including the domain.
/// @param public_key - Uncompressed chat key, `0x04` + X + Y.
/// @returns `0x` + selector + node + X + Y.
/// @remarks
/// Coordinates are copied as the hex text they already are; nothing is decoded
/// and re-encoded, so the bytes on chain are exactly the bytes of the key.
///
/// # Errors
/// `ErrorKind::Backend` when the key is not an uncompressed public key — the
/// resolver would store zero coordinates, and the name would keep resolving to
/// a key no client holds.
fn set_pubkey_calldata(full_name: &str, public_key: &str) -> AppResult<String> {
    let key = strip_hex_prefix(public_key);
    if key.len() != 130 || !key.starts_with("04") {
        return Err(AppError::backend(
            "profile chat key is not an uncompressed public key",
        ));
    }

    let node = namehash(full_name);
    let mut data = String::with_capacity(2 + SET_PUBKEY_SELECTOR.len() + 64 * 3);
    data.push_str("0x");
    data.push_str(SET_PUBKEY_SELECTOR);
    for byte in node {
        data.push_str(&format!("{byte:02x}"));
    }
    data.push_str(&key[2..66]);
    data.push_str(&key[66..130]);
    Ok(data)
}

/// The name in the form `ens_ownerOf` expects.
///
/// Two reads of the same name hash it differently in status-go, as written in
/// its sources:
///
///   * `ens_ownerOf` → `EnsResolver.OwnerOf` (pkg/services/ens/ensresolver/
///     resolver.go:141) first calls `ValidateENSUsername`, which requires an
///     `.eth` suffix and answers "user name must be a valid ENS name ending
///     with .eth" for a bare name. Having passed, the resolver strips
///     `.stateofus.eth` and hashes the rest (:168), i.e. the label;
///   * `ens_expireAt` → `EnsResolver.ExpireAt` (same file, :242) does no
///     validation and hashes the string as is.
///
/// The owner is therefore queried with the full name (otherwise refusal) and
/// the expiry with the bare one (otherwise the expiry of a different label).
fn owner_lookup_name(username: &str) -> String {
    full_name(username)
}

/// The name in the form `ens_expireAt` expects. See [`owner_lookup_name`].
fn expire_lookup_name(username: &str) -> &str {
    username.trim()
}

/// Route parameters for registration.
///
/// Kept separate so the confirmation screen and the send compute identically: a
/// divergence here would mean showing one price and paying another.
///
/// # Errors
/// Whatever [`token_key`] returns for an unsupported chain.
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

/// The chat public key of the profile — the key messages are encrypted to.
///
/// @remarks
/// This is the value Status clients read from the name when they send a contact
/// request or a message: `PublicKeyOf` in status-go returns the resolver's
/// `pubkey(bytes32)` record, and the official client compares it with its own
/// `settings.public-key`. Writing any other key leaves the name resolvable but
/// silent — the request is sent, and nobody is listening on it.
///
/// Deliberately not taken from `accounts_getAccounts`: that list answers with
/// the public key of each **wallet** account, and a wallet key is not the chat
/// identity. The two are different keys derived from the same seed phrase, so
/// the wallet key derives to the wallet's address and decrypts nothing addressed
/// to the profile.
///
/// `ExtractCoordinates` in status-go splits the string as `0x04` + X + Y, so
/// only that form is accepted: another key would make registration assemble
/// calldata full of zeros, recording the name against a garbage public key.
///
/// # Errors
/// `ErrorKind::Backend` when the settings cannot be read or carry no usable key.
async fn chat_key(backend: Backend) -> AppResult<String> {
    let settings = backend.call("settings_getSettings", json!([])).await?;
    let key = settings
        .get("public-key")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let key = strip_hex_prefix(key);
    if key.len() != 130 || !key.starts_with("04") {
        return Err(AppError::backend(
            "profile has no usable chat public key for ENS",
        ));
    }
    Ok(format!("0x{key}"))
}

/// Whether `from` is one of the profile's wallet accounts.
///
/// The name is owned by a wallet address and the transaction is signed with its
/// key, so an address from another profile would fail later with an opaque
/// signing error. Refused early, with a sentence that names the problem.
///
/// # Errors
/// `ErrorKind::Backend` when the accounts cannot be listed; `ErrorKind::Config`
/// when the address is not part of this profile.
async fn ensure_account_member(backend: Backend, from: &str) -> AppResult<()> {
    let accounts = backend.call("accounts_getAccounts", json!([])).await?;
    let list = accounts
        .as_array()
        .ok_or_else(|| AppError::backend("backend returned no accounts"))?;

    for account in list {
        let address = account
            .get("address")
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if address.eq_ignore_ascii_case(from) {
            return Ok(());
        }
    }

    Err(AppError::config("account not found in this profile"))
}

/// What the name costs and whether it is free.
///
/// Entirely read-only: no signature and no password are needed. The network fee
/// comes from the same route the registration will later take, so the figure on
/// the confirmation screen is not a separate guess but the same estimate.
///
/// # Errors
/// `ErrorKind::Config` when the name is invalid, the wallet address is malformed
/// or the chain has no registrar; `ErrorKind::Backend` when the price or the
/// owner cannot be read.
#[tauri::command]
pub async fn get_ens_quote(chain_id: u64, from: String, username: String) -> AppResult<EnsQuote> {
    let backend = Backend::new();
    validate_username(&username)?;
    if !is_address(&from) {
        return Err(AppError::config("invalid wallet address"));
    }
    // The network is checked before any request: other chains have no registrar.
    snt_address(chain_id)?;

    let name = username.trim();

    let price_raw = backend
        .call("ens_price", json!([chain_id]))
        .await?
        .as_str()
        .unwrap_or("0")
        .to_string();
    let price = hex_u128(&price_raw).unwrap_or(0);

    // Owner: the zero address means "free".
    //
    // The error is NOT swallowed: an empty owner would make a taken name look
    // free, and the user would then pay for a registration the contract
    // rejects.
    let owner_raw = backend
        .call("ens_ownerOf", json!([chain_id, owner_lookup_name(name)]))
        .await?;
    let owner = owner_raw.as_str().unwrap_or_default().to_string();
    let zero = "0x0000000000000000000000000000000000000000";
    let available = owner.is_empty() || owner == zero || owner.eq_ignore_ascii_case("0x0");

    // Expiry is informational: failing to read it is not a reason to refuse the
    // price and availability.
    let expires_at = backend
        .call("ens_expireAt", json!([chain_id, expire_lookup_name(name)]))
        .await
        .ok()
        .and_then(|v| v.as_str().map(|s| s.to_string()))
        .unwrap_or_else(|| "0".to_string());

    // Network fee. The route may fail to build (no SNT on the balance, gas
    // unavailable) — that is not a reason to refuse the price and availability,
    // but showing zero instead of "unknown" is not acceptable either.
    let mut fee: Option<String> = None;
    if let Ok(public_key) = chat_key(backend).await {
        let uuid = unique_uuid();
        if let Ok(params) = route_params(&uuid, chain_id, &from, name, &public_key, price)
            && let Ok(route) = backend
                .call("wallet_getSuggestedRoutes", json!([params]))
                .await
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

/// Network fee from the route (`Route[0].TxTotalFee`, hex wei).
fn route_fee(route: &Value) -> Option<String> {
    let first = route.get("Route")?.as_array()?.first()?;
    let raw = first.get("TxTotalFee")?.as_str()?;
    let value = hex_u128(raw).ok()?;
    Some(value.to_string())
}

/// Registers the name and returns the transaction hash.
///
/// # Errors
/// `ErrorKind::Config` for a stopped backend, an invalid name, a bad wallet
/// address, an empty password or an unsupported chain; `ErrorKind::Backend`
/// when a backend call fails, the public key is unusable, or no transaction hash
/// comes back.
#[tauri::command]
pub async fn register_ens_name(request: EnsRegisterRequest) -> AppResult<EnsRegisterResult> {
    let backend = Backend::new();
    validate_username(&request.username)?;
    if !is_address(&request.from) {
        return Err(AppError::config("invalid wallet address"));
    }
    if request.password.is_empty() {
        return Err(AppError::config("password is required"));
    }
    snt_address(request.chain_id)?;

    let name = request.username.trim();
    ensure_account_member(backend, &request.from).await?;
    let public_key = chat_key(backend).await?;

    // The price comes from the contract, not the frontend: the registrar
    // decides the approve amount, and any other figure would be rejected.
    let price_hex = backend
        .call("ens_price", json!([request.chain_id]))
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

    let hashes = execute_route(backend, params, &request.from, &request.password).await?;

    // Registration is a single transaction (`approveAndCall` approves inside).
    // The last hash is taken: if the Router does add a separate approve, the
    // registration hash is the interesting one, not the preparatory one.
    let tx_hash = hashes
        .last()
        .cloned()
        .ok_or_else(|| AppError::backend("backend returned no transaction hash"))?;

    Ok(EnsRegisterResult {
        tx_hash,
        full_name: full_name(name),
    })
}

/// Request to rewrite the chat key recorded on a name.
///
/// @remarks
/// Same fields as registration, different transaction: `setPubkey` on the
/// resolver instead of a registration. The name must already belong to `from` —
/// the contract rejects anyone else.
#[derive(Debug, Deserialize)]
pub struct EnsUpdateKeyRequest {
    pub chain_id: u64,
    /// Wallet address that owns the name and signs the transaction.
    pub from: String,
    /// Name without the domain: `myname` → `myname.stateofus.eth`.
    pub username: String,
    /// Profile password. Used only inside this call.
    pub password: String,
}

/// Rewrites the chat key recorded on an existing name.
///
/// # Errors
/// `ErrorKind::Config` for a stopped backend, an invalid name, a bad wallet
/// address, an empty password or an unsupported chain; `ErrorKind::Backend`
/// when a backend call fails, the chat key is unusable, or no transaction hash
/// comes back.
///
/// @remarks
/// Separate from registration because the two are different on-chain writes:
/// this one touches only the resolver record, costs gas and no deposit, and does
/// not extend the name. Needed for names registered by builds that wrote a
/// wallet key instead of the profile's chat key — such a name resolves, but
/// everything addressed to it goes to a key no client holds.
#[tauri::command]
pub async fn update_ens_public_key(request: EnsUpdateKeyRequest) -> AppResult<EnsRegisterResult> {
    let backend = Backend::new();
    validate_username(&request.username)?;
    if !is_address(&request.from) {
        return Err(AppError::config("invalid wallet address"));
    }
    if request.password.is_empty() {
        return Err(AppError::config("password is required"));
    }
    let resolver = stateofus_resolver(request.chain_id)?;

    let name = request.username.trim();
    ensure_account_member(backend, &request.from).await?;
    let public_key = chat_key(backend).await?;

    let full = full_name(name);
    let data = set_pubkey_calldata(&full, &public_key)?;
    // Diagnostic: not secrets — the address, the name, the contracts. A
    // reverting `setPubkey` is either a sender that does not own the name or a
    // call to the wrong contract, and these values tell the two apart.
    tracing::info!(
        "[ens] setPubkey: from={} name={} resolver={} calldata_bytes={}",
        request.from,
        full,
        resolver,
        (data.len() - 2) / 2
    );

    // 1. Build. The Router is not used here on purpose: see
    //    SEND_TYPE_ENS_REGISTER. `wallet_buildTransaction` takes arbitrary
    //    calldata and computes nonce and gas, exactly as for a transfer.
    let args = json!({
        "from": request.from,
        "to": resolver,
        "value": "0x0",
        "data": data,
    });
    let built = backend
        .call(
            "wallet_buildTransaction",
            json!([request.chain_id, args.to_string()]),
        )
        .await?;

    let message = built
        .get("messageToSign")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::backend("backend returned no hash to sign"))?
        .to_string();
    let tx_args = built
        .get("txArgs")
        .cloned()
        .ok_or_else(|| AppError::backend("backend returned no transaction arguments"))?;

    // 2. Sign. The password lives only inside this call.
    let signature = backend
        .call(
            "wallet_signMessage",
            json!([message, request.from, request.password]),
        )
        .await?
        .as_str()
        .ok_or_else(|| AppError::backend("backend returned no signature"))?
        .to_string();

    // 3. Send. The signature goes without `0x`: status-go parses it with
    //    `hex.DecodeString`, which rejects the prefix.
    let sent = backend
        .call(
            "wallet_sendTransactionWithSignature",
            json!([
                request.chain_id,
                "WalletTransfer",
                tx_args.to_string(),
                strip_hex_prefix(&signature)
            ]),
        )
        .await?;

    let tx_hash = sent.as_str().unwrap_or_default().to_string();
    if tx_hash.is_empty() {
        return Err(AppError::backend("backend returned no transaction hash"));
    }

    Ok(EnsRegisterResult {
        tx_hash,
        full_name: full,
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
        // With a dot it would become "a.b.stateofus.eth" — a different label.
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
        // Surrounding whitespace must not end up in the name.
        assert_eq!(full_name("  myname  "), "myname.stateofus.eth");
    }

    /// status-go divergence: the owner is queried with the full name, the
    /// expiry with the bare one.
    ///
    /// Both assertions are conditions for the code to work, not style:
    /// `ens_ownerOf` rejects a bare name (and an empty owner would make a taken
    /// name look free), while `ens_expireAt` with the full name hashes a
    /// different label.
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
        // `<chainId>-<lowercase address>`: the same form status-go builds in TokenKey.
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
        // The recipient equals the sender: the name belongs to the payer.
        assert_eq!(params["addrFrom"], params["addrTo"]);
        assert_eq!(params["tokenKey"], params["toTokenKey"]);
        assert_eq!(params["username"], "myname");
        assert_eq!(params["fromChainID"], 11155111);
        assert_eq!(params["toChainID"], 11155111);
    }

    /// The node the transaction writes to must be the one the registry uses.
    /// Reference value from `cast namehash stauri.stateofus.eth`.
    #[test]
    fn namehash_matches_the_registry() {
        let node = namehash("stauri.stateofus.eth");
        let hex: String = node.iter().map(|b| format!("{b:02x}")).collect();
        assert_eq!(
            hex,
            "eba8de136a68d214256b2d7192944eeb9e26df3e81f1a616da59cb17cb79b0cd"
        );

        // The ENS root hashes to zero.
        assert_eq!(namehash(""), [0u8; 32]);
        // Case does not change the node: names are case-insensitive.
        assert_eq!(namehash("Stauri.StateOfUs.ETH"), node);
    }

    /// Selector, node and two coordinates — 4 + 32 + 32 + 32 bytes. A shorter
    /// calldata would write garbage coordinates into the resolver.
    #[test]
    fn calldata_carries_selector_node_and_coordinates() {
        let key = format!("0x04{}{}", "aa".repeat(32), "bb".repeat(32));
        let data = set_pubkey_calldata("stauri.stateofus.eth", &key).expect("calldata");

        assert!(data.starts_with("0x29cd62ea"), "setPubkey selector");
        assert_eq!((data.len() - 2) / 2, 4 + 32 + 32 + 32);
        // Coordinates are copied verbatim, not re-derived.
        assert!(data.ends_with(&format!("{}{}", "aa".repeat(32), "bb".repeat(32))));
    }

    #[test]
    fn calldata_refuses_a_compressed_or_short_key() {
        assert!(set_pubkey_calldata("stauri.stateofus.eth", "0x04aa").is_err());
        // Compressed keys start with 02/03: the resolver expects 0x04 + X + Y.
        assert!(
            set_pubkey_calldata("stauri.stateofus.eth", &format!("0x02{}", "aa".repeat(32)))
                .is_err()
        );
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
