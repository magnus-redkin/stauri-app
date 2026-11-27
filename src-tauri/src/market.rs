use crate::core::error::{AppError, AppResult};
use once_cell::sync::Lazy;
use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarketCoin {
    pub id: String,
    pub symbol: String,
    pub name: String,
    pub image: String,
    pub current_price: f64,
    pub market_cap: f64,
    pub total_volume: f64,
    #[serde(default)]
    pub price_change_percentage_24h: Option<f64>,
}

struct CacheEntry {
    data: Vec<MarketCoin>,
    fetched_at: Instant,
}

static CACHE: Lazy<Mutex<Option<CacheEntry>>> = Lazy::new(|| Mutex::new(None));
const CACHE_TTL: Duration = Duration::from_secs(60);

#[tauri::command]
pub async fn fetch_market_data() -> AppResult<Vec<MarketCoin>> {
    // 1. Check the cache
    if let Ok(guard) = CACHE.lock()
        && let Some(entry) = &*guard
        && entry.fetched_at.elapsed() < CACHE_TTL
    {
        return Ok(entry.data.clone());
    }

    // 2. CoinGecko key is optional.
    //
    //    The public endpoint serves data without a key; `x-cg-demo-api-key`
    //    only raises the rate limit. With a 60 s cache and one request for 50
    //    coins the anonymous limit is enough, so a missing key is not an error.
    //    The key is read from ~/.config/com.magnus.stauri-app/.env (see
    //    `env::load_env`).
    let api_key = std::env::var("COINGECKO_KEY").unwrap_or_default();

    let url = "https://api.coingecko.com/api/v3/coins/markets\
        ?vs_currency=usd\
        &order=market_cap_desc\
        &per_page=50\
        &page=1\
        &price_change_percentage=24h";

    // 3. Request
    //
    //    The User-Agent is not decoration: CoinGecko answers 403 with "Please
    //    add a descriptive User-Agent to your request" when it is missing, and
    //    reqwest sends none by default. The address and the version make the
    //    requests identifiable, which is what the service asks for.
    let mut builder = reqwest::Client::builder()
        .user_agent(concat!(
            "Stauri/",
            env!("CARGO_PKG_VERSION"),
            " (+https://github.com/magnus-redkin/stauri-app)"
        ))
        .timeout(Duration::from_secs(10));

    // `.no_proxy()` used to be unconditional: on a machine whose only route is the
    // desktop proxy the market then failed with "request failed". The system proxy is
    // read from the desktop settings when the environment carries none; see sysproxy.
    if let Some(proxy) = crate::sysproxy::proxy_url() {
        match reqwest::Proxy::all(&proxy) {
            Ok(proxy) => builder = builder.proxy(proxy),
            Err(e) => tracing::warn!(error = %e, "system proxy ignored"),
        }
    }
    let client = builder
        .build()
        .map_err(|e| AppError::internal(format!("client build error: {e}")))?;

    let mut request = client.get(url).header("Accept", "application/json");
    if !api_key.is_empty() {
        request = request.header("x-cg-demo-api-key", &api_key);
    }

    let resp = request
        .send()
        .await
        .map_err(|e| AppError::network(format!("request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        // The response body is left out: it can carry service-side details.
        return Err(AppError::network(format!(
            "CoinGecko HTTP {status} ({} bytes)",
            body.len()
        )));
    }

    // 4. Read the body (kept for diagnostics if parsing fails)
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::network(format!("body read error: {e}")))?;

    let data: Vec<MarketCoin> = serde_json::from_str(&body)
        .map_err(|e| AppError::network(format!("JSON parse error: {e}")))?;

    // 5. Store in the cache
    if let Ok(mut guard) = CACHE.lock() {
        *guard = Some(CacheEntry {
            data: data.clone(),
            fetched_at: Instant::now(),
        });
    }

    Ok(data)
}
