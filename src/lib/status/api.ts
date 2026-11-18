import { invoke } from "@tauri-apps/api/core";
import { debug } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';
import { INFURA_KEY, STATUS_LOG_LEVEL, STATUS_LOG_FILE } from '$lib/config/keys';
import { statusFetch, statusCall } from "./http";
import type { StartBackendResponse } from "./types";

debug('[api] INFURA_KEY loaded:', !!INFURA_KEY);

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
 * @param password - Profile password.
 * @param keyUid - Key uid of the profile to log into.
 * @returns The backend's response.
 * @remarks
 * `statusProxyStageName: "prod"` is a valid stage name for status-go. "mainnet" is
 * not a stage but a network name; with it the proxy URLs come out broken
 * (`https://mainnet.api.status.im/...`) and RPC clients are never created.
 */
export async function loginAccount(
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
  return await statusFetch("LoginAccount", payload);
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
  return await statusFetch("CreateAccountAndLogin", payload);
}


/**
 * Derives the profile key uid from a seed phrase.
 *
 * @param mnemonic - The twelve words, in order.
 * @returns The key uid, or `null` when the phrase is not a valid mnemonic.
 * @remarks
 * The same phrase always yields the same key uid, and it matches the one a profile on
 * this device has. That is what tells "first time here" from "already here", which
 * decides between restoring and logging in.
 */
export async function keyUidFromMnemonic(mnemonic: string): Promise<string | null> {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
  try {
    const reply = await statusCall<{ keyUID?: string; error?: string }>(
      'ValidateMnemonicV2',
      { mnemonic: normalized }
    );
    if (reply?.error) return null;
    return reply?.keyUID || null;
  } catch (e) {
    // An invalid phrase is an ordinary outcome of typing, not a failure to report.
    debug('[Restore] phrase rejected:', formatError(e));
    return null;
  }
}

/**
 * Removes a profile from this device.
 *
 * @param keyUid - Profile to delete.
 * @param keyStoreDir - Its keystore directory.
 * @remarks
 * This is a reset of the local copy, not of the account: the seed phrase still
 * restores the same keys and wallet, but the local message database and settings are
 * gone. Only called with explicit confirmation.
 */
export async function deleteProfile(keyUid: string, keyStoreDir: string): Promise<void> {
  const reply = await statusCall<{ error?: string }>('DeleteMultiaccount', {
    keyUID: keyUid,
    keyStoreDir,
  });
  if (reply?.error) throw new Error(reply.error);
}

/**
 * Restores a profile from its seed phrase and logs in.
 *
 * @param dataDir - Profile directory of this network (same as at creation).
 * @param password - New local password; it encrypts the restored database and
 *   need not match the one the profile had before.
 * @param mnemonic - The twelve words, in order.
 * @returns The reply of `RestoreAccountAndLogin`.
 * @remarks
 * The account keeps its key pair: the seed phrase derives the same keys, so the
 * profile, its contacts and its wallet address come back. Only the local
 * database is new, which is why a new password is accepted.
 */
export async function restoreAccountAndLogin(
  dataDir: string,
  password: string,
  mnemonic: string
): Promise<any> {
  const payload: Record<string, any> = {
    rootDataDir: dataDir,
    displayName: "Stauri User",
    password,
    mnemonic: mnemonic.trim().toLowerCase().replace(/\s+/g, ' '),
    customizationColor: "primary",
    thirdpartyServicesEnabled: true,
    statusProxyStageName: 'prod',
    ...loggingConfig(dataDir),
    ...walletConfig(),
    ...walletSecrets(),
  };
  // Length only; the words themselves must never reach a log.
  debug('[RestoreAccount] words:', payload.mnemonic.split(' ').length);
  return await statusFetch("RestoreAccountAndLogin", payload);
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

export async function initializeApplication(dataDir: string, networkId: number): Promise<any> {
  return await statusFetch("InitializeApplication", {
    dataDir: dataDir,
    NetworkID: networkId,
  });
}

export async function startMessenger(): Promise<any> {
  return await statusFetch("CallRPC", {
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
 * @returns The backend's response.
 * @remarks
 * This is the `/statusgo/Logout` endpoint, not `wakuext_logout`: that method does
 * not exist in this status-go branch and answers "the method wakuext_logout does
 * not exist/is not available". `Logout` is registered in `EndpointsWithoutRequest`
 * (cmd/status-backend/server/endpoints.go), so its handler does not read a body
 * and none needs to be sent.
 */
export async function logout(): Promise<any> {
  return await statusFetch('Logout', {});
}

export async function getAccountsList(dataDir: string, networkId: number): Promise<any[]> {
  const data = await initializeApplication(dataDir, networkId);
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
