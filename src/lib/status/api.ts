import { invoke } from "@tauri-apps/api/core";
import { debug } from '$lib/utils/log';
import { INFURA_KEY, STATUS_LOG_LEVEL, STATUS_LOG_FILE } from '$lib/config/keys';
import { statusFetch } from "./http";
import type { StartBackendResponse } from "./types";

debug('[api] INFURA_KEY loaded:', !!INFURA_KEY);

/**
 * Token of the authenticating proxy.
 *
 * Cached for the lifetime of the page: Rust hands out the same token for as long
 * as the application runs. It is requested lazily, only when the first call
 * actually needs it.
 */
let authToken: string | null = null;

export async function getAuthToken(): Promise<string> {
  if (authToken) return authToken;
  authToken = await invoke<string>('auth_proxy_token');
  return authToken;
}

/**
 * Secrets passed to LoginAccount and CreateAccountAndLogin.
 *
 * @returns The secret fields the backend understands.
 * @remarks
 * `alchemyApiKey` is deliberately absent: its only consumer in status-go is the
 * collectibles client (pkg/services/wallet/service.go, `alchemy.NewClient`), and
 * Stauri has no NFT support. The key itself stays in the bundle because
 * `connectionStore` uses it to build RPC URLs, so it cannot be dropped from .env.
 *
 * `infuraToken` is passed and is needed: status-go takes `VerifyENSURL` from it
 * (pkg/backend/defaults.go, `getMainnetRPCURL`) to verify ENS names and installs
 * it as the direct provider's `AuthToken` for mainnet.infura.io. Without the token
 * `getMainnetRPCURL` returns an empty string and ENS verification in
 * internal/protocol/ens/verifier.go is silently skipped.
 */
function walletSecrets(): Record<string, string> {
  const secrets: Record<string, string> = {};

  if (INFURA_KEY) secrets.infuraToken = INFURA_KEY;

  return secrets;
}

/**
 * Wallet settings needed for swapping.
 *
 * @returns Wallet config fields for the login payload.
 * @remarks
 * The Router builds its swap handlers in `pkg/services/wallet/service.go`
 * (`buildSwapPathProcessors`) from `EnableRelayProvider`, `EnableLiFiProvider` and
 * `EnableParaswapProvider`. All three default to `false`
 * (pkg/backend/defaults.go, `buildWalletConfig`), and with none enabled there are
 * no swap handlers at all, so `wallet_getSuggestedRoutes` answers `WR-005` / "no
 * best route found" — not because no route exists, but because there is nobody to
 * ask. The symptom is misleading: the screen shows "Calculated when sending" as if
 * the network were still working.
 *
 * LiFi is enabled rather than Paraswap: `api.paraswap.io` answers `403` with an
 * empty body from this network regardless of User-Agent, while LiFi returns a
 * quote without an API key. Without `lifiApiKey` the rate limit is lower, which is
 * enough for a single swap; if a key appears, add it in `walletSecrets`.
 *
 * Relay stays off on purpose: it has higher priority and would make LiFi
 * `ignored`, and Relay itself does not work without a key.
 */
function walletConfig(): Record<string, boolean> {
  return { enableLiFiProvider: true };
}

/**
 * Logs into an existing account.
 *
 * @param port - Auth proxy port.
 * @param password - Profile password.
 * @param keyUid - Key uid of the profile to log into.
 * @returns The backend's response.
 * @remarks
 * `statusProxyStageName: "prod"` is a valid stage name for status-go. "mainnet" is
 * not a stage but a network name; with it the proxy URLs come out broken
 * (`https://mainnet.api.status.im/...`) and RPC clients are never created.
 */
export async function loginAccount(
  port: number,
  password: string,
  keyUid: string
): Promise<any> {
  const payload: Record<string, any> = {
    password,
    keyUid,
    statusProxyStageName: 'prod',
    ...walletConfig(),
    ...walletSecrets(),
  };
  debug('[Login] payload keys:', Object.keys(payload));
  return await statusFetch(port, "LoginAccount", payload);
}

/**
 * Builds logging fields for the backend payload.
 *
 * @param dataDir - Data directory, used as the default log location.
 * @returns Logging fields, or `logEnabled: false` when no level is configured.
 * @remarks
 * status-go logging is off by default. When on, `status.log` is written at DEBUG
 * level on every start and collects full RPC provider URLs including API keys
 * (Alchemy puts the key in the request path). That is a secret leaked to the
 * user's disk in a file that survives restarts and gets attached to bug reports.
 *
 * Set `VITE_STATUS_LOG=debug` (and optionally `VITE_STATUS_LOG_FILE=/abs/path`) in
 * .env to enable it. The values are read in `$lib/config/keys`.
 */
function loggingConfig(dataDir: string): Record<string, unknown> {
  if (!STATUS_LOG_LEVEL) {
    return { logEnabled: false };
  }
  return {
    logEnabled: true,
    logLevel: STATUS_LOG_LEVEL,
    logFilePath: STATUS_LOG_FILE ?? `${dataDir}/status.log`,
  };
}

/**
 * Creates an account and logs into it.
 *
 * @param port - Auth proxy port.
 * @param dataDir - Root data directory for the profile.
 * @param password - Profile password.
 * @returns The backend's response.
 * @remarks
 * `thirdpartyServicesEnabled: true` enables the RPC providers in
 * `BuildDefaultNetworks`. `statusProxyStageName: "prod"` is a valid stage name;
 * "mainnet" is not one. `alchemyApiKey` and `infuraToken` come from
 * `WalletSecretsConfig` as flat fields at the top level of the payload.
 */
export async function createAccountAndLogin(
  port: number,
  dataDir: string,
  password: string
): Promise<any> {
  const payload: Record<string, any> = {
    rootDataDir: dataDir,
    displayName: "Stauri User",
    password,
    customizationColor: "primary",
    thirdpartyServicesEnabled: true,
    statusProxyStageName: 'prod',
    ...loggingConfig(dataDir),
    ...walletConfig(),
    ...walletSecrets(),
  };
  debug('[CreateAccount] payload keys:', Object.keys(payload));
  return await statusFetch(port, "CreateAccountAndLogin", payload);
}


export async function startBackend(network?: string): Promise<StartBackendResponse> {
  return await invoke<StartBackendResponse>('start_backend', { network });
}

export async function stopBackend(): Promise<void> {
  await invoke('stop_backend');
}

// ==========================================
// LOCAL RPC FORWARDER
// ==========================================

/**
 * Starts the local HTTP forwarder and returns its port.
 *
 * @param upstreams - Map of chainId to provider URL, passed in advance.
 * @returns The forwarder port.
 * @remarks
 * The forwarder exists because status-go's connection pool gets stuck: a socket
 * stays ESTAB with no reply and the request hangs until the circuit breaker times
 * out. The forwarder opens a fresh connection for every request, like curl.
 *
 * `upstreams` is passed immediately because a provider from the previous run is
 * already in the status-go database pointing at our port, so the first request can
 * arrive before any second command. A forwarder without a table answers 503.
 */
export async function startRpcProxy(upstreams: Record<number, string> = {}): Promise<number> {
  return await invoke<number>('start_rpc_proxy', { upstreams });
}

/**
 * Path secret of the forwarder.
 *
 * @returns The secret, or `null` when the forwarder is not running yet.
 * @remarks
 * status-go calls the forwarder, not our frontend, and the node cannot send a
 * header, so protection lives in the URL itself:
 * `http://127.0.0.1:<port>/<secret>/<chainId>`.
 */
export async function getRpcProxySecret(): Promise<string | null> {
  return await invoke<string | null>('rpc_proxy_secret');
}

/** Sets the upstream URL for each network: map of chainId to provider URL. */
export async function setRpcUpstreams(upstreams: Record<number, string>): Promise<void> {
  await invoke('set_rpc_upstreams', { upstreams });
}

export async function stopRpcProxy(): Promise<void> {
  await invoke('stop_rpc_proxy');
}

export async function initializeApplication(port: number, dataDir: string, networkId: number): Promise<any> {
  return await statusFetch(port, "InitializeApplication", {
    dataDir: dataDir,
    NetworkID: networkId,
  });
}

export async function startMessenger(port: number): Promise<any> {
  return await statusFetch(port, "CallRPC", {
    jsonrpc: "2.0",
    id: 1,
    method: "wakuext_startMessenger",
    params: []
  });
}

// Networks and providers are configured only through
// configureWalletRpc() -> setChainUserRpcProvider() -> http://127.0.0.1:<port>/<chainId>,
// which routes traffic through the local forwarder. Any direct Infura or Alchemy
// endpoint would bypass the workaround for stuck connections that
// src-tauri/src/rpc_proxy.rs exists for.


// ==========================================
// WALLET AND ENS
// ==========================================
//
// The `wallet_*`, `ens_*` and RPC provider settings live in `wallet.ts`: the
// wallet is a separate status-go boundary and is kept in one place. What follows
// is only a re-export for existing callers; new code imports from
// `$lib/status/wallet` directly.
export {
  startWallet,
  getBalances,
  getAccounts,
  getSettings,
  getTokensForActiveNetworksMode,
  getAddressDetails,
  buildTransaction,
  signMessage,
  sendTransactionWithSignature,
  getPendingTransactions,
  getSuggestedFees,
  getCryptoOnRamps,
  getCryptoOnRampUrl,
  getFlatEthereumChains,
  setChainUserRpcProvider,
  getEnsUsernames,
  ensGetName,
  ensAddressOf,
  ensPrice,
  ensExpireAt,
} from './wallet';

/**
 * Logs out of the account.
 *
 * @param port - Auth proxy port.
 * @returns The backend's response.
 * @remarks
 * This is the `/statusgo/Logout` endpoint, not `wakuext_logout`: that method does
 * not exist in this status-go branch and answers "the method wakuext_logout does
 * not exist/is not available". `Logout` is registered in `EndpointsWithoutRequest`
 * (cmd/status-backend/server/endpoints.go), so its handler does not read a body
 * and none needs to be sent.
 */
export async function logout(port: number): Promise<any> {
  return await statusFetch(port, 'Logout', {});
}

export async function getAccountsList(port: number, dataDir: string, networkId: number): Promise<any[]> {
  const data = await initializeApplication(port, dataDir, networkId);
  return data.accounts || [];
}

// ==========================================
// CHATS AND COMMUNITIES
// ==========================================
//
// Messaging logic lives in `messaging.ts`: every `wakuext_*` method is there, and
// what follows is only a re-export for existing callers. New code imports from
// `$lib/status/messaging` directly.

export {
  getChatPreviews,
  getChat,
  getChatMessages,
  getJoinedCommunities,
  getCommunities,
  getSpectatedCommunities,
  getCuratedCommunities,
  fetchCommunity,
  joinCommunity,
  leaveCommunity,
  joinPublicChat,
  normalizeHex,
  normalizeChatId,
  communityIdFromInvite,
  communityChannels,
  communityChatId,
  channelIdFromInvite,
  communityAccess,
  checkPermissionsToJoinCommunity,
  generateJoiningRequestsForSigning,
  signJoinRequestData,
  requestToJoinCommunity,
  spectateCommunity,
  sendChatMessage,
  isReply,
  getContacts,
  acceptContactRequest,
  sendContactRequest,
  ChatType,
  CommunityAccessValue,
  TokenPermissionType,
  isChannel,
  isCommunityChat,
  isDirectMessage,
} from './messaging';

export interface MarketCoin {
  id: string;
  symbol: string;
  name: string;
  image: string;
  current_price: number;
  market_cap: number;
  total_volume: number;
  price_change_percentage_24h: number | null;
}

export async function fetchMarketData(): Promise<MarketCoin[]> {
  return await invoke<MarketCoin[]>('fetch_market_data');
}
