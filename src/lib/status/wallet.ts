/**
 * status-go boundary for the wallet and ENS.
 *
 * Stauri takes only networking and the wallet from status-go and moves
 * everything else out. When status-go goes away, this file and its callers
 * change, not the whole frontend. `api.ts` keeps re-exports for existing callers;
 * new code imports from here.
 *
 * @remarks
 * JSON-RPC `id` values need not be unique across requests: `statusFetch` makes one
 * HTTP call per request and receives the response on that same connection.
 * Numbering stays sequential within the file only to keep logs readable.
 */

import { statusFetch } from './http';

// ===========================================================================
// LIFECYCLE
// ===========================================================================

/**
 * Starts the wallet service.
 *
 * @returns The backend's response.
 * @remarks
 * Call once per session rather than on every balance poll: repeated calls achieve
 * nothing and cost time.
 */
export async function startWallet(): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wallet_startWallet',
    params: [],
  });
}

// ===========================================================================
// ACCOUNTS, BALANCES, TOKENS
// ===========================================================================

/**
 * Accounts of the profile.
 *
 * @returns Account records from status-go.
 * @remarks
 * These records give the addresses the backend actually computes balances for:
 * the controller takes them from `keypairs_accounts` with the filter `chat = 0`
 * (internal/db/multiaccounts/accounts/database.go, `GetWalletAddresses`). The
 * `chat = true` account is the chat address and has no wallet.
 */
export async function getAccounts(): Promise<any[]> {
  const res = await statusFetch<{ result?: any[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 2,
    method: 'accounts_getAccounts',
    params: [],
  });
  return res.result || [];
}

/**
 * Balances from the backend cache.
 *
 * @param addresses - Wallet addresses to read.
 * @param forceRefresh - Ignored by status-go; kept for callers that still pass it.
 * @returns Balance map: `{ "0xAddr": [ { tokenAddress, tokenChainId, rawBalance,
 * hasError } ] }`.
 * @remarks
 * `forceRefresh` is accepted but ignored in `pkg/services/wallet/api.go`
 * (`FetchOrGetCachedWalletBalances`): the method reads the cache filled by the
 * background `MultistandardBalanceController`. A balance therefore does not
 * update right after a transfer, no matter how often it is requested; polling on
 * a timer is required. Use `restartWalletReloadTimer` to trigger a refetch.
 */
export async function getBalances(
  addresses: string[],
  forceRefresh = false
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 3,
    method: 'wallet_fetchOrGetCachedWalletBalances',
    params: [addresses, forceRefresh],
  });
}

/**
 * Token metadata (symbol, decimals, name) for the active networks.
 *
 * @returns Token records.
 * @remarks
 * A `StorageToken` from `getBalances` has no `symbol` or `decimals`, only address,
 * chainId, rawBalance and hasError. Without this call a balance cannot be
 * labelled, converted to human units or shown in a list. The response is large
 * (~4.6 MB, ~17 700 tokens), so `walletStore` fetches it once per session and
 * caches it.
 */
export async function getTokensForActiveNetworksMode(): Promise<any[]> {
  const res = await statusFetch<{ result?: any[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 4,
    method: 'wallet_getTokensForActiveNetworksMode',
    params: [],
  });
  return res.result || [];
}

/**
 * Profile settings.
 *
 * @returns Settings object.
 * @remarks
 * The object contains `mnemonic`, the seed phrase. `statusFetch` does not log
 * response bodies, but this object must never be put into a store or a log.
 */
export async function getSettings(): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 5,
    method: 'settings_getSettings',
    params: [],
  });
}

/**
 * Saves a profile setting.
 *
 * @param key - "React name" of the field, with a question mark for booleans.
 * @param value - New value.
 * @returns The backend's response.
 * @remarks
 * status-go looks the field up by its react name, such as
 * `test-networks-enabled?` (internal/db/multiaccounts/settings/columns.go). The
 * plain field name (`test_networks_enabled`) does not work here.
 */
export async function saveSetting(
  key: string,
  value: unknown
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 22,
    method: 'settings_saveSetting',
    params: [key, value],
  });
}

/**
 * Turns the display of test networks on or off.
 *
 * @param enabled - Whether test networks are active.
 * @returns The backend's response.
 * @remarks
 * This is a separate flag, not a consequence of the network choice. Stauri's
 * `STAURI_NETWORK` is a Rust setting: which network is primary, which waku fleet
 * and which data directory. status-go knows nothing about it and has its own
 * `test-networks-enabled?` flag, which `networks.GetActiveNetworks()` uses to
 * filter networks: `false` activates mainnet networks, `true` the test ones.
 * While the flag is unset, a profile started as "sepolia" computes balances on
 * mainnet networks (1, 10, 56, 8453, 42161) and shows zeros.
 *
 * Enabling the flag emits `EventActiveNetworksChanged`, after which the balance
 * controller refetches networks. RPC clients are cached per chainId, so providers
 * for the new networks must be registered again — the caller does that after
 * switching.
 *
 * The call cannot be made before login: `settings_*` is registered in
 * `initServices`, which runs after the node starts, and the node starts inside
 * `LoginAccount`. Before that the call answers "method not found", as does
 * `networks_*`.
 */
export async function setTestNetworksEnabled(
  enabled: boolean
): Promise<any> {
  return saveSetting('test-networks-enabled?', enabled);
}

/**
 * Current value of the test networks flag.
 *
 * @returns Whether test networks are enabled.
 * @remarks
 * Reads the whole settings object and takes one field, because status-go has no
 * dedicated getter for this flag. The object carries the seed phrase, so it must
 * not be logged or stored.
 */
export async function getTestNetworksEnabled(): Promise<boolean> {
  const settings = await getSettings();
  return settings?.result?.['test-networks-enabled?'] === true;
}

/**
 * Brings the network mode to the requested value.
 *
 * @param enabled - Whether test networks should be active.
 * @returns `true` when the flag had to be rewritten.
 * @remarks
 * A `true` result means the set of active networks changed while the backend's
 * RPC clients were built for the previous one: the node must be restarted, or
 * balances will come from the wrong networks.
 */
export async function ensureTestNetworkMode(
  enabled: boolean
): Promise<boolean> {
  const current = await getTestNetworksEnabled();
  if (current === enabled) return false;
  await setTestNetworksEnabled(enabled);
  return true;
}

/**
 * Resolves an address into its ENS name and details.
 *
 * @param chainId - Chain to resolve on.
 * @param address - Address to look up.
 * @returns Address details, including the ENS name when there is one.
 * @remarks
 * Used on the send confirmation step so the user sees `0x…` together with a name
 * if one exists — the last chance to notice a substituted address.
 */
export async function getAddressDetails(
  chainId: number,
  address: string
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 6,
    method: 'wallet_getAddressDetails',
    params: [chainId, address],
  });
}

/**
 * Triggers a full refetch of balances.
 *
 * @returns The backend's response.
 * @remarks
 * This is the only working way to refresh balances, since `getBalances` ignores
 * `forceRefresh`. `pkg/services/wallet/api.go` documents it above
 * `FetchOrGetCachedWalletBalances`: the only outlier that needs a forced refresh
 * is the user-triggered one, handled by `RestartWalletReloadTimer`. This method
 * calls `multistandardBalanceController.TriggerFullFetch()`.
 *
 * The fetch is asynchronous: the response comes back immediately and the numbers
 * appear in the cache a few seconds later, so callers must re-read balances after
 * a delay rather than once.
 */
export async function restartWalletReloadTimer(): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 21,
    method: 'wallet_restartWalletReloadTimer',
    params: [],
  });
}

// ===========================================================================
// SENDING
// ===========================================================================
//
// A transfer is a three-step path in status-go and needs the password:
//
//   buildTransaction(chainID, sendTxArgs) → { messageToSign, txArgs }
//   signMessage(messageToSign, from, password) → signature
//   sendTransactionWithSignature(chainID, "WalletTransfer", txArgs, sig) → hash
//
// These three calls must not be made from components. `wallet_signMessage` signs
// arbitrary 32 bytes with the wallet key and does not know what they mean, so if
// the password and the sequence lived in the webview, any XSS would get a
// universal signing machine. All sending therefore goes through one Rust command
// (`send_transfer`), and these wrappers exist for tests and console debugging, not
// for the interface.

/**
 * Builds a transaction and returns the hash that must be signed.
 *
 * @param chainId - Chain the transaction targets.
 * @param sendTxArgsJson - Transaction arguments as a JSON string.
 * @returns The backend's build result, including `messageToSign` and `txArgs`.
 */
export async function buildTransaction(
  chainId: number,
  sendTxArgsJson: string
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 7,
    method: 'wallet_buildTransaction',
    params: [chainId, sendTxArgsJson],
  });
}

/**
 * Signs 32 bytes with the account key.
 *
 * @param message - Hash to sign.
 * @param address - Wallet address whose key signs.
 * @param password - Profile password.
 * @returns The signature.
 * @remarks
 * Requires the password; see the module comment for why this is not exposed to the
 * interface.
 */
export async function signMessage(
  message: string,
  address: string,
  password: string
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 8,
    method: 'wallet_signMessage',
    params: [message, address, password],
  });
}

/**
 * Sends a signed transaction to the network.
 *
 * @param chainId - Chain to send on.
 * @param txType - Transaction type.
 * @param sendTxArgsJson - Transaction arguments as a JSON string.
 * @param signature - Signature produced by `signMessage`.
 * @returns The backend's response.
 * @remarks
 * `wallet_signMessage` returns the signature with a `0x` prefix, and
 * `sendTransactionWithSignature` accepts only bare hex, so the prefix must be
 * stripped before calling. The Rust transfer command does this.
 */
export async function sendTransactionWithSignature(
  chainId: number,
  txType: 'WalletTransfer' | 'RegisterENS' | 'ReleaseENS' | 'SetPubKey',
  sendTxArgsJson: string,
  signature: string
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 9,
    method: 'wallet_sendTransactionWithSignature',
    params: [chainId, txType, sendTxArgsJson, signature],
  });
}

/** Transactions waiting for confirmation, for the status indicator on screen. */
export async function getPendingTransactions(): Promise<any[]> {
  const res = await statusFetch<{ result?: any[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 10,
    method: 'wallet_getPendingTransactions',
    params: [],
  });
  return res.result || [];
}

/** Network-suggested fees, in gwei. */
export async function getSuggestedFees(chainId: number): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 11,
    method: 'wallet_getSuggestedFees',
    params: [chainId],
  });
}

// ===========================================================================
// ON-RAMP (BUYING)
// ===========================================================================
//
// The payment happens on the provider's side; Stauri only passes the address and
// opens the link in an external handler.

/** Available purchase providers, usually empty on testnet. */
export async function getCryptoOnRamps(): Promise<any[]> {
  const res = await statusFetch<{ result?: any[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 12,
    method: 'wallet_getCryptoOnRamps',
    params: [],
  });
  return res.result || [];
}

/** Provider link with the receiving address filled in. */
export async function getCryptoOnRampUrl(
  providerId: string,
  parameters: { destAddress?: string; chainID?: number; symbol?: string }
): Promise<string> {
  const res = await statusFetch<{ result?: string }>('CallRPC', {
    jsonrpc: '2.0',
    id: 13,
    method: 'wallet_getCryptoOnRampURL',
    params: [providerId, parameters],
  });
  return res.result || '';
}

// ===========================================================================
// NETWORKS AND RPC PROVIDERS
// ===========================================================================
//
// Not wallet code strictly speaking, but it lives next to it: networks are set up
// by `rpcConfig.ts` on connect, and without these calls no balances arrive.

/** Networks known to the backend, with their RPC providers. */
export async function getFlatEthereumChains(): Promise<any[]> {
  const res = await statusFetch<{ result?: any[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 14,
    method: 'networks_getFlatEthereumChains',
    params: [],
  });
  return res.result || [];
}

/**
 * Adds a user RPC provider to a network.
 *
 * @param chainId - Chain to configure.
 * @param name - Provider name, shown in status-go settings.
 * @param url - Endpoint URL.
 * @returns The backend's response.
 * @remarks
 * Without this, balances arrive with `hasError = true`: status-go's built-in
 * providers no longer resolve (direct-grove) or time out (direct-infura). A
 * verified endpoint of our own, routed through the local forwarder, fixes that.
 * The backend appends user providers next to the built-in ones and prefers them,
 * so calling this is safe.
 */
export async function setChainUserRpcProvider(
  chainId: number,
  name: string,
  url: string
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 15,
    method: 'networks_setChainUserRpcProviders',
    params: [
      chainId,
      [
        {
          id: 0,
          chainId,
          name,
          url,
          enableRpsLimiter: false,
          type: 'user',
          enabled: true,
          authType: 'no-auth',
          authLogin: '',
          authPassword: '',
          authToken: '',
        },
      ],
    ],
  });
}

// ===========================================================================
// ENS
// ===========================================================================
//
// The ENS service is registered on the RPC server under the `ens` namespace
// (pkg/services/ens/service.go). Registering a name is NOT done here: it goes only
// through the Router path (`SendType: ENSRegister`), because payment on mainnet is
// in SNT and on testnet in STT. See `src-tauri/src/ens.rs`.

/** ENS names of this profile. */
export async function getEnsUsernames(): Promise<any[]> {
  const res = await statusFetch<{ result?: any[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 16,
    method: 'ens_getEnsUsernames',
    params: [],
  });
  return res.result || [];
}

/**
 * Records an ENS name on the profile and syncs it to linked devices.
 *
 * @param chainId - Chain the name belongs to.
 * @param username - Full name, including the `.eth` suffix.
 * @returns Nothing.
 * @remarks
 * Registration is a blockchain transaction, and the profile knows nothing about
 * it. `ens_getEnsUsernames` reads status-go's own `ens_usernames` table rather than
 * the contract, so without `ens_add` a freshly registered name is absent from that
 * table and appears nowhere.
 *
 * `ens_add` runs `ValidateUsername` (full form, `.eth` suffix required) and
 * dispatches the record with `SyncEnsNamesWithDispatchMessage`: the message goes
 * to the sync chat, and whether anyone receives it depends on linked devices.
 * Harmless for a single profile.
 */
export async function addEnsUsername(chainId: number, username: string): Promise<void> {
  await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 16,
    method: 'ens_add',
    params: [chainId, username],
  });
}

/**
 * ENS name of an address.
 *
 * @param chainId - Chain to resolve on.
 * @param address - Address to look up.
 * @returns The name, or an empty string when the address has none.
 * @remarks
 * An empty result is not an error: most addresses have no name.
 */
export async function ensGetName(
  chainId: number,
  address: string
): Promise<string> {
  const res = await statusFetch<{ result?: string }>('CallRPC', {
    jsonrpc: '2.0',
    id: 17,
    method: 'ens_getName',
    params: [chainId, address],
  });
  return res.result || '';
}

/**
 * Address an ENS name points to.
 *
 * @param chainId - Chain to resolve on.
 * @param username - Name such as `vitalik.eth`.
 * @returns The address, or an empty string when the name does not exist.
 * @remarks
 * Used in the recipient field: the user types a name and the transfer goes to the
 * address behind it.
 */
export async function ensAddressOf(
  chainId: number,
  username: string
): Promise<string> {
  const res = await statusFetch<{ result?: string }>('CallRPC', {
    jsonrpc: '2.0',
    id: 18,
    method: 'ens_addressOf',
    params: [chainId, username],
  });
  return res.result || '';
}

/** Registration price of a name. */
export async function ensPrice(chainId: number): Promise<string> {
  const res = await statusFetch<{ result?: string }>('CallRPC', {
    jsonrpc: '2.0',
    id: 19,
    method: 'ens_price',
    params: [chainId],
  });
  return res.result || '';
}

/** When the name expires (RFC3339). Empty when the name is not registered. */
export async function ensExpireAt(
  chainId: number,
  username: string
): Promise<string> {
  const res = await statusFetch<{ result?: string }>('CallRPC', {
    jsonrpc: '2.0',
    id: 20,
    method: 'ens_expireAt',
    params: [chainId, username],
  });
  return res.result || '';
}

/**
 * Owner of a name according to the ENS registry.
 *
 * @param chainId - Chain to read on.
 * @param username - Full name, e.g. `stauri.eth`.
 * @returns The owner address, or the zero address when the name is free.
 * @remarks
 * Works for any `.eth` name, unlike the Status registrar calls, which only know
 * `.stateofus.eth`. A wrapped name reports the NameWrapper as its owner — the
 * registry owner is what the contract says, not the person.
 */
export async function ensOwnerOf(
  chainId: number,
  username: string
): Promise<string> {
  const res = await statusFetch<{ result?: string }>('CallRPC', {
    jsonrpc: '2.0',
    id: 22,
    method: 'ens_ownerOf',
    params: [chainId, username],
  });
  return res.result || '';
}

/**
 * Chat key recorded on a name.
 *
 * @param chainId - Chain to resolve on.
 * @param username - Full name, e.g. `stauri.stateofus.eth`.
 * @returns Uncompressed key, `0x04` + X + Y; empty when the record is absent.
 * @remarks
 * This is the record Status clients read when someone writes to a name: the
 * name itself is only a pointer, and messages go to the key stored here.
 *
 * `ens_publicKeyOf` → `EnsResolver.PublicKeyOf` (status-go
 * pkg/services/ens/api.go), which reads `pubkey(bytes32)` and answers with
 * `0x04…`; the empty string means the name exists but no key was written.
 */
export async function ensPublicKeyOf(
  chainId: number,
  username: string
): Promise<string> {
  const res = await statusFetch<{ result?: string }>('CallRPC', {
    jsonrpc: '2.0',
    id: 21,
    method: 'ens_publicKeyOf',
    params: [chainId, username],
  });
  return res.result || '';
}

// ===========================================================================
// PRICES
// ===========================================================================

/**
 * Token prices in one currency.
 *
 * @param tokenKeys - Keys in status-go form, `chainId-address`.
 * @param currency - Currency code.
 * @returns Flat map of token key to price; tokens without a price are omitted.
 * @remarks
 * The key format matters. `walletStore` uses `chainId:address`, while status-go
 * expects `chainId-address` (`TokenKey` in
 * `pkg/services/wallet/token/tokenlist/model.go`). A key with a colon is not
 * recognised and the price silently comes back empty.
 *
 * Test networks yield no prices: CoinGecko does not list their tokens, and
 * `mapTokensToIds` drops everything that is not `IsMainnet()`. An empty response
 * for Sepolia is normal.
 *
 * A zero price is kept (a token without a market), while an absent key means "no
 * price"; the two are not conflated.
 */
export async function getTokenPrices(
  tokenKeys: string[],
  currency = 'usd'
): Promise<Record<string, number>> {
  if (tokenKeys.length === 0) return {};

  const res = await statusFetch<{ result?: Record<string, Record<string, number>> }>(
    'CallRPC',
    {
      jsonrpc: '2.0',
      id: 21,
      method: 'wallet_fetchPrices',
      params: [tokenKeys, [currency]],
    }
  );

  const raw = res.result || {};
  const flat: Record<string, number> = {};
  for (const [key, byCurrency] of Object.entries(raw)) {
    const value = byCurrency?.[currency];
    // Zero is a value too (a token with no market), but an absent key means "no
    // price", and the two should not be conflated.
    if (typeof value === 'number' && Number.isFinite(value)) flat[key] = value;
  }
  return flat;
}
