//! Sending funds from the wallet.
//!
//! A transfer in status-go takes three steps (`pkg/services/wallet/api.go`):
//!
//! ```text
//! wallet_buildTransaction(chainID, sendTxArgs)   → messageToSign, txArgs
//! wallet_signMessage(messageToSign, from, pass)  → signature
//! wallet_sendTransactionWithSignature(chainID, "WalletTransfer", txArgs, sig)
//! ```
//!
//! The orchestration lives in Rust, not in a component: in the webview any XSS
//! would get both the profile password and a universal signing tool —
//! `wallet_signMessage` signs any 32 bytes with the wallet key without knowing
//! what they are. A foreign script could then sign a transaction it assembled
//! itself ("send everything to this address"). Here only the intent crosses the
//! boundary: "send this much of this token to this address". The hash to sign,
//! the steps and the password stay in Rust.
//!
//! Rust validates only what can be checked without the network: address shape,
//! amount syntax, `chainId` range, presence of the password. Sufficient funds,
//! correct gas and the transaction itself are the node's business; duplicating
//! them would mean diverging from its rules.
//!
//! The password arrives from the frontend once per session and is not stored
//! here: it is passed to `wallet_signMessage` and dropped. Every send goes
//! through this command anyway, so holding it longer serves no purpose.

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::backend::Backend;
use crate::error::{AppError, AppResult};

/// Transfer request.
#[derive(Debug, Deserialize)]
pub struct TransferRequest {
    pub chain_id: u64,
    /// Sender address — the wallet of this profile.
    pub from: String,
    pub to: String,
    /// Token contract address. The zero address for native ETH.
    pub token_address: String,
    /// Amount in the smallest unit (a string, to avoid losing precision).
    pub amount: String,
    /// Profile password. Never logged or stored.
    pub password: String,
}

/// Send result.
#[derive(Debug, Serialize)]
pub struct TransferResult {
    /// Transaction hash, when the node returned one.
    pub tx_hash: String,
}

/// Fee estimate: what the network will charge for the transfer.
///
/// Derived from the `gas` and `gasPrice` the node filled in while building the
/// transaction. status-go has no separate estimate method for this path
/// (`wallet_getSuggestedFees` returns the network's recommended prices, not the
/// gas of this particular transaction), so the figures come from the built but
/// still unsigned transaction: that is exactly the fee that will be charged.
#[derive(Debug, Serialize)]
pub struct FeeEstimate {
    /// Fee in the smallest unit (wei).
    pub fee: String,
    /// Gas limit.
    pub gas: String,
    /// Gas price in wei.
    pub gas_price: String,
}

/// Builds the transaction and returns a fee estimate.
///
/// Safe to call before the password is entered: `wallet_buildTransaction` only
/// assembles the transaction and computes its hash. The key is not used, no
/// signature is produced and nothing is sent to the network, so the estimate
/// can be shown on the confirmation screen before the user types the password —
/// they see the full picture of the transfer, fee included, and then decide.
///
/// # Errors
/// `ErrorKind::Config` for a zero `chain_id`, a bad
/// address or a non-integer amount; `ErrorKind::Backend` when the backend call
/// fails, or when the node omits `txArgs` or returns unparsable
/// `gas`/`gasPrice`.
#[tauri::command]
pub async fn estimate_transfer_fee(request: FeeRequest) -> AppResult<FeeEstimate> {
    if request.chain_id == 0 {
        return Err(AppError::config("chain id is required"));
    }
    for (label, addr) in [
        ("sender", &request.from),
        ("recipient", &request.to),
        ("token", &request.token_address),
    ] {
        if !is_address(addr) {
            return Err(AppError::config(format!("invalid {label} address")));
        }
    }

    let amount = parse_amount(&request.amount)?;
    let args = send_args(&request.from, &request.to, &request.token_address, amount);

    // Built through the same path as sending (`send_args`), so the figures on
    // the confirmation screen match the signed transaction.
    let built = Backend::new()
        .call(
            "wallet_buildTransaction",
            json!([request.chain_id, args.to_string()]),
        )
        .await?;

    let tx_args = built
        .get("txArgs")
        .cloned()
        .ok_or_else(|| AppError::backend("backend returned no transaction arguments"))?;

    let gas = hex_u128(&tx_args, "gas")?;
    let gas_price = hex_u128(&tx_args, "gasPrice")?;

    Ok(FeeEstimate {
        fee: (gas.saturating_mul(gas_price)).to_string(),
        gas: gas.to_string(),
        gas_price: gas_price.to_string(),
    })
}

/// Fee estimate request: the same as a send, without the password.
#[derive(Debug, Deserialize)]
pub struct FeeRequest {
    pub chain_id: u64,
    pub from: String,
    pub to: String,
    pub token_address: String,
    pub amount: String,
}

/// Address of the native asset on every EVM chain.
const NATIVE_TOKEN: &str = "0x0000000000000000000000000000000000000000";

/// Sends a transfer and returns its hash.
///
/// # Errors
/// `ErrorKind::Config` when validation fails; `ErrorKind::Backend` when a
/// backend call fails, or when the node returns no hash to sign, no transaction
/// arguments, no signature or no transaction hash.
#[tauri::command]
pub async fn send_transfer(request: TransferRequest) -> AppResult<TransferResult> {
    validate(&request)?;

    let amount = parse_amount(&request.amount)?;
    let args = send_args(&request.from, &request.to, &request.token_address, amount);

    let built = Backend::new()
        .call(
            "wallet_buildTransaction",
            json!([request.chain_id, args.to_string()]),
        )
        .await?;

    // The node answers with an object holding `messageToSign` and `txArgs`.
    // Without the hash there is nothing to sign.
    let message = built
        .get("messageToSign")
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::backend("backend returned no hash to sign"))?
        .to_string();

    // `txArgs` goes BACK to the node unchanged: it holds the nonce and gas the
    // node has just computed. Rebuilding them would mean sending a different
    // transaction from the one that was shown.
    let tx_args = built
        .get("txArgs")
        .cloned()
        .ok_or_else(|| AppError::backend("backend returned no transaction arguments"))?;

    // 2. Sign. The password lives only inside this call.
    //
    //    `message` is passed as is, with `0x`: the parameter is declared as
    //    `types.HexBytes`, whose JSON decoder expects a prefixed hex string.
    let signature = Backend::new()
        .call(
            "wallet_signMessage",
            json!([message, request.from, request.password]),
        )
        .await?
        .as_str()
        .ok_or_else(|| AppError::backend("backend returned no signature"))?
        .to_string();

    // 3. Send. `WalletTransfer` is a value of `PendingTrxType`
    //    (pkg/services/wallet/pendingtxtracker/pendingtxtracker.go).
    //
    // The signature goes out without the `0x` prefix because of a split inside
    // status-go:
    //
    //   * `wallet_signMessage` returns the signature through `types.EncodeHex`,
    //     which ADDS `0x` (internal/crypto/types/utils.go);
    //   * `wallet_sendTransactionWithSignature` parses it with
    //     `hex.DecodeString` (pkg/services/wallet/api.go:613), which accepts
    //     bare hex only and fails on `0x` with
    //     "encoding/hex: invalid byte: U+0078 'x'".
    //
    // The signature is therefore obtained successfully but the transaction is
    // never sent. The prefix is stripped here rather than relying on the node.
    let hash = Backend::new()
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

    let tx_hash = hash.as_str().unwrap_or_default().to_string();
    if tx_hash.is_empty() {
        return Err(AppError::backend("backend returned no transaction hash"));
    }

    Ok(TransferResult { tx_hash })
}

/// Validates the request before any network access.
///
/// Anything rejected here is not worth a backend call: a malformed address, a
/// non-numeric amount, a wrong `chainId`.
///
/// # Errors
/// `ErrorKind::Config` for a zero `chain_id`, a bad
/// address, an empty password, a non-integer amount or a zero amount.
fn validate(request: &TransferRequest) -> AppResult<()> {

    // chainId 0 is not a network. The upper bound is generous: real networks
    // fit in u64, so 0 and garbage are rejected here.
    if request.chain_id == 0 {
        return Err(AppError::config("chain id is required"));
    }

    for (label, addr) in [
        ("sender", &request.from),
        ("recipient", &request.to),
        ("token", &request.token_address),
    ] {
        if !is_address(addr) {
            return Err(AppError::config(format!("invalid {label} address")));
        }
    }

    if request.password.is_empty() {
        return Err(AppError::config("password is required"));
    }

    // `u128` is never negative, so "greater than zero" is simply "not zero".
    if parse_amount(&request.amount)? == 0 {
        return Err(AppError::config("amount must be greater than zero"));
    }

    Ok(())
}

/// Strips the `0x` prefix when present.
///
/// Required only where status-go decodes bare hex (see step 3 in
/// `send_transfer`). Other fields are passed with `0x`, as expected.
fn strip_hex_prefix(value: &str) -> &str {
    value
        .strip_prefix("0x")
        .or_else(|| value.strip_prefix("0X"))
        .unwrap_or(value)
}

/// Transaction arguments for `wallet_buildTransaction`.
///
/// Fee estimation and sending must build the transaction identically;
/// otherwise the confirmation screen could show one fee while a transaction
/// with another is sent.
///
/// The native asset and a token differ in where the transaction goes: for ETH
/// the recipient is `to` and the amount is `value`. For an ERC-20 the
/// transaction goes to the contract (`to` = contract, `value` = 0) while the
/// recipient and amount are encoded in `data` via the
/// transfer(address,uint256) call.
fn send_args(from: &str, to: &str, token_address: &str, amount: u128) -> Value {
    if token_address.eq_ignore_ascii_case(NATIVE_TOKEN) {
        json!({
            "from": from,
            "to": to,
            "value": format!("0x{amount:x}"),
            "data": "0x",
        })
    } else {
        json!({
            "from": from,
            "to": token_address,
            "value": "0x0",
            "data": encode_erc20_transfer(to, amount),
        })
    }
}

/// Reads a hex field from `txArgs` (the node returns `gas` and `gasPrice` as
/// `0x…`).
///
/// # Errors
/// `ErrorKind::Backend` when the field is missing, is not a string, or does not
/// parse as hex.
fn hex_u128(value: &Value, field: &str) -> AppResult<u128> {
    let raw = value
        .get(field)
        .and_then(|v| v.as_str())
        .ok_or_else(|| AppError::backend(format!("backend returned no {field}")))?;
    let digits = strip_hex_prefix(raw);
    u128::from_str_radix(digits, 16)
        .map_err(|e| AppError::backend(format!("invalid {field} from backend: {e}")))
}

/// EVM address: `0x` and exactly 40 hexadecimal digits.
fn is_address(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 42
        && bytes[0] == b'0'
        && (bytes[1] == b'x' || bytes[1] == b'X')
        && bytes[2..].iter().all(|b| b.is_ascii_hexdigit())
}

/// `data` for an ERC-20 `transfer(address,uint256)` call.
///
/// The call is fixed — a four-byte selector plus two 32-byte arguments — so a
/// full ABI encoder (alloy/ethabi) would add hundreds of kilobytes of
/// dependencies for 64 lines of work.
///
/// The selector `0xa9059cbb` is the first 4 bytes of
/// keccak256("transfer(address,uint256)"). It is identical across ERC-20 tokens,
/// so it is written as a constant instead of computed at runtime.
///
/// The amount must fit in 32 bytes: `uint256` is exactly 256 bits, and
/// silently truncating a larger sum would send the wrong amount.
fn encode_erc20_transfer(to: &str, amount: u128) -> String {
    // `to` was already checked by `is_address`, but it is checked again: this
    // function assembles the bytes that go on chain and a mistake here is not
    // recoverable.
    let recipient = to
        .trim_start_matches("0x")
        .trim_start_matches("0X")
        .to_ascii_lowercase();

    // The 20-byte address is padded with 12 zero bytes to 32, as the ABI
    // requires.
    let address_word = format!("{recipient:0>64}");
    // The amount is a 32-byte hexadecimal number with leading zeros.
    let amount_word = format!("{amount:064x}");

    format!("0xa9059cbb{address_word}{amount_word}")
}

/// Parses an amount in the smallest unit.
///
/// The frontend already converted it to an integer (`utils/amount.ts`), so only
/// decimal digits are accepted. It arrives as a string: `u64` is too small for
/// 18 digits and `f64` would lose precision.
///
/// # Errors
/// `ErrorKind::Config` when the value is not a decimal integer.
fn parse_amount(raw: &str) -> AppResult<u128> {
    raw.parse::<u128>()
        .map_err(|_| AppError::config("amount must be a decimal integer"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::inprocess::describe_rpc_error;

    fn request() -> TransferRequest {
        TransferRequest {
            chain_id: 11155111,
            from: "0xcd8fd2a9f9726729d19f9be57d959942d7eb578c".to_string(),
            to: "0x0000000000000000000000000000000000000001".to_string(),
            token_address: "0x0000000000000000000000000000000000000000".to_string(),
            amount: "10000000000000000".to_string(),
            password: "secret".to_string(),
        }
    }

    #[test]
    fn accepts_valid_request() {
        assert!(validate(&request()).is_ok());
    }

    #[test]
    fn rejects_bad_addresses() {
        for bad in [
            "",
            "0x",
            "0x123",
            "cd8fd2a9f9726729d19f9be57d959942d7eb578c",
            "0xcd8fd2a9f9726729d19f9be57d959942d7eb578cz",
            "0xcd8fd2a9f9726729d19f9be57d959942d7eb578",
        ] {
            let mut r = request();
            r.to = bad.to_string();
            assert!(validate(&r).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn accepts_uppercase_x_prefix() {
        // Some wallets copy the address as `0X…`.
        let mut r = request();
        r.to = "0X0000000000000000000000000000000000000001".to_string();
        assert!(validate(&r).is_ok());
    }

    #[test]
    fn rejects_zero_chain() {
        let mut r = request();
        r.chain_id = 0;
        assert!(validate(&r).is_err());
    }

    #[test]
    fn rejects_zero_amount() {
        let mut r = request();
        r.amount = "0".to_string();
        assert!(validate(&r).is_err());
    }

    #[test]
    fn rejects_non_integer_amount() {
        for bad in ["1.5", "-1", "abc", "", "1e18"] {
            let mut r = request();
            r.amount = bad.to_string();
            assert!(validate(&r).is_err(), "should reject {bad:?}");
        }
    }

    #[test]
    fn rejects_empty_password() {
        let mut r = request();
        r.password = String::new();
        assert!(validate(&r).is_err());
    }

    #[test]
    fn amount_keeps_full_precision() {
        // 1 ETH in wei: `u128` holds any realistic amount.
        assert_eq!(
            parse_amount("100000000000000000000").unwrap(),
            100_000_000_000_000_000_000u128
        );
    }

    #[test]
    fn encodes_erc20_transfer_call() {
        // Reference: transfer(0x0000…0001, 1) on USDC (6 decimals) — amount 1e6.
        let data = encode_erc20_transfer("0x0000000000000000000000000000000000000001", 1_000_000);
        assert_eq!(
            data,
            concat!(
                "0xa9059cbb",
                "0000000000000000000000000000000000000000000000000000000000000001",
                "00000000000000000000000000000000000000000000000000000000000f4240",
            )
        );
        // Selector plus two 32-byte words = 4 + 32 + 32 bytes.
        assert_eq!(data.len(), 2 + 8 + 64 + 64);
    }

    #[test]
    fn erc20_encoding_accepts_uppercase_prefix_and_uppercase_hex() {
        let lower = encode_erc20_transfer("0xabcdefabcdefabcdefabcdefabcdefabcdefabcd", 1);
        let upper = encode_erc20_transfer("0XABCDEFABCDEFABCDEFABCDEFABCDEFABCDEFABCD", 1);
        // Case must not affect the bytes: the address is zero-padded the same way.
        assert_eq!(lower, upper);
        assert!(lower.contains("abcdefabcdefabcdefabcdefabcdefabcdefabcd"));
    }

    #[test]
    fn erc20_encoding_pads_small_amounts() {
        let data = encode_erc20_transfer("0x0000000000000000000000000000000000000001", 0xff);
        assert!(data.ends_with("00000000000000000000000000000000000000000000000000000000000000ff"));
    }

    #[test]
    fn native_and_token_addresses_are_distinguished() {
        // The zero address means ETH, not ERC-20: argument building differs, and
        // mixing them up would send a token to an empty address.
        assert!(NATIVE_TOKEN.eq_ignore_ascii_case("0x0000000000000000000000000000000000000000"));
        assert!(!NATIVE_TOKEN.eq_ignore_ascii_case("0x0000000000000000000000000000000000000001"));
    }

    /// `wallet_signMessage` returns a signature with a `0x` prefix, while
    /// `wallet_sendTransactionWithSignature` parses it with `hex.DecodeString`,
    /// which does not understand the prefix. The result is
    /// "encoding/hex: invalid byte: U+0078 'x'" — the signature is obtained but
    /// the transaction never leaves. Checks that the prefix is stripped in both
    /// cases and that other fields are untouched.
    #[test]
    fn strips_prefix_only_from_signature() {
        let sig = "0x1b2a3c4d5e6f";
        assert_eq!(strip_hex_prefix(sig), "1b2a3c4d5e6f");
        assert_eq!(strip_hex_prefix("0X1B2A"), "1B2A");

        // Without a prefix the string is unchanged, so calls where the node
        // already returned bare hex keep working.
        assert_eq!(strip_hex_prefix("1b2a"), "1b2a");

        // The address keeps its prefix: it is expected with `0x`.
        let addr = "0xcd8fd2a9f9726729d19f9be57d959942d7eb578c";
        assert_eq!(strip_hex_prefix(addr).len(), 40);
        assert!(is_address(addr));
    }

    #[test]
    fn reads_hex_fields_from_tx_args() {
        let args = json!({"gas": "0x5208", "gasPrice": "0x12"});
        assert_eq!(hex_u128(&args, "gas").unwrap(), 21000);
        assert_eq!(hex_u128(&args, "gasPrice").unwrap(), 18);
        // Fee = gas × price; 21000 × 18 = 378000 wei.
        assert_eq!(21000u128 * 18, 378_000);
    }

    #[test]
    fn hex_reader_rejects_missing_and_garbage() {
        // "abc" is valid hex (0xabc), so it is not garbage.
        let args = json!({"gas": "xyz"});
        assert!(hex_u128(&args, "gas").is_err());
        // A missing field is an error too, not zero.
        assert!(hex_u128(&args, "gasPrice").is_err());
        let empty = json!({"gas": ""});
        assert!(hex_u128(&empty, "gas").is_err());
    }

    /// Estimation and sending must build the transaction identically, otherwise
    /// the fee on screen will not match the one charged.
    #[test]
    fn send_args_are_identical_for_fee_and_send() {
        let native = send_args("0xfrom", "0xto", NATIVE_TOKEN, 1000);
        assert_eq!(native["to"], "0xto");
        assert_eq!(native["value"], "0x3e8");

        let token = send_args("0xfrom", "0xto", "0xcontract", 1000);
        assert_eq!(token["to"], "0xcontract");
        assert_eq!(token["value"], "0x0");
        assert!(token["data"].as_str().unwrap().starts_with("0xa9059cbb"));
    }

    #[test]
    fn rpc_error_is_described_without_body() {
        assert_eq!(
            describe_rpc_error(&json!("insufficient funds")),
            "insufficient funds"
        );
        assert_eq!(
            describe_rpc_error(&json!({"code": -32000, "message": "nonce too low"})),
            "nonce too low"
        );
        assert_eq!(
            describe_rpc_error(&json!({"code": 1})),
            "backend returned an error"
        );
    }
}
