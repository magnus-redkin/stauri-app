import { statusState } from './statusStore.svelte';
import { debug } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';
import { MAINNET_CHAINS, priceKey } from '$lib/utils/totalBalance';
import {
  startWallet,
  getAccounts,
  getBalances,
  getTokensForActiveNetworksMode,
  getTokenPrices,
  restartWalletReloadTimer,
} from '$lib/status/wallet';

export type WalletToken = {
  symbol: string;
  decimals: number;
  balance: string;   // smallest units (wei), which is what formatBalance expects
  chainId: number;
  tokenAddress: string;
  hasError: boolean;
};

export const walletState = $state({
  isLoading: false,
  /**
   * A user-triggered refresh is running. Kept apart from `isLoading` because
   * the regular poll runs constantly, and spinning the header for it would be
   * noise.
   */
  isRefreshing: false,
  error: '',
  loaded: false,
  address: '',
  /**
   * Every account address of this profile, in backend order.
   *
   * @remarks
   * `address` is the first of them and is what a transfer signs from. Anything that
   * asks "does this profile own X?" — an ENS name, for instance — must look at the whole
   * list: a name is registered against one of the profile's accounts, and which one is
   * first is up to status-go.
   */
  addresses: [] as string[],
  balances: [] as WalletToken[],
  /**
   * Token prices: key `chainId-address` → price in the reporting currency.
   *
   * An empty map when CoinGecko is unreachable is normal, not an error:
   * balances matter more, and the screen shows them without a total rather than
   * showing nothing.
   */
  prices: {} as Record<string, number>,
  accounts: [] as any[],
  /** Set when not a single token could be fetched over RPC. */
  rpcError: '',
});

/**
 * Token metadata cache (symbol, decimals) for the length of the session.
 *
 * `wallet_getTokensForActiveNetworksMode` returns ~4.6 MB (17,682 tokens) and
 * the poll runs every 3 seconds, so fetching it each time is pointless. Symbols
 * and decimals do not change within a session. Cleared in `resetWallet`.
 */
let cachedMetadata: Map<string, { symbol: string; decimals: number }> | null = null;

function tokenKey(chainId: number, address: string): string {
  return `${chainId}:${address.toLowerCase()}`;
}

/** Metadata map: `"chainId:address"` → `{ symbol, decimals }`. */
function buildMetadataMap(tokens: any[]): Map<string, { symbol: string; decimals: number }> {
  // A local map for the duration of the call; not part of reactivity.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity
  const map = new Map<string, { symbol: string; decimals: number }>();
  for (const t of tokens) {
    const chainId = Number(t.chainId);
    const address = String(t.address || '');
    if (!Number.isFinite(chainId) || !address) continue;
    map.set(tokenKey(chainId, address), {
      symbol: String(t.symbol || ''),
      decimals: Number.isInteger(t.decimals) ? Number(t.decimals) : 18,
    });
  }
  return map;
}

/**
 * Loads the wallet address and balances.
 *
 * @param force - Reload even when the wallet is already loaded.
 * @remarks
 * The response shape of `wallet_fetchOrGetCachedWalletBalances` in this
 * status-go version is `{ "0xAddr": [ { tokenAddress, tokenChainId, rawBalance,
 * hasError } ] }`.
 *
 * `StorageToken` carries no symbol or decimals; they come from a separate
 * `wallet_getTokensForActiveNetworksMode` call, matched by the
 * (chainId, tokenAddress) pair. `hasError` means "RPC did not answer", not
 * "balance is zero", so such tokens are kept: dropping them would make a
 * network outage look like an empty wallet.
 *
 * A balance is kept in the token's smallest units — wei for native assets,
 * 10^-decimals for ERC-20 — and converted with `decimals` only for display.
 */
export async function loadWallet(force = false) {
  debug('[walletStore] loadWallet called', {
    backendRunning: statusState.backendRunning,
    loaded: walletState.loaded,
    isLoading: walletState.isLoading,
    force,
  });

  if (!statusState.backendRunning) {
    console.warn('[walletStore] backend not running, abort');
    return;
  }
  if (walletState.isLoading) {
    console.warn('[walletStore] already loading, skip');
    return;
  }
  if (walletState.loaded && !force) {
    debug('[walletStore] already loaded, skip (use force=true to reload)');
    return;
  }

  walletState.isLoading = true;
  walletState.error = '';
  // `rpcError` is NOT cleared here: otherwise every poll would briefly drop the
  // banner and the UI would flicker between the error and a list of zeros. It is
  // overwritten below once the response arrives.

  try {

    // 1. Start the wallet once; repeating it every 3 s is pointless.
    if (!walletState.loaded) {
      const startRes = await startWallet();
      if (startRes && (startRes as any).error) {
        const err = (startRes as any).error;
        throw new Error(
          `wallet_startWallet: ${err.message || JSON.stringify(err)}`
        );
      }
    }

    // 2. Addresses the balance controller tracks.
    //
    // `wallet-root-address` from settings_getSettings is NOT the address the
    // backend computes balances for. The controller takes them from
    // keypairs_accounts (GetWalletAddresses: chat = 0 AND removed = 0,
    // internal/db/multiaccounts/accounts/database.go), i.e. the profile's
    // regular account addresses. A request for wallet-root-address returns an
    // empty cache — that key is simply absent — which looked like "all balances
    // failed".
    const accounts = await getAccounts();
    const addresses: string[] = accounts
      .filter((a: any) => a && a.address && !a.chat)
      .map((a: any) => String(a.address));

    // Shown on the "Manage accounts" screen.
    walletState.accounts = accounts
      .filter((a: any) => a && a.address && !a.chat)
      .map((a: any) => ({
        address: String(a.address),
        name: a.name || '',
        path: a.path || '',
        color: a.color || '',
        // Chat addresses (`chat = true`) are filtered out above: they have no
        // wallet and would look like an account without a balance.
        publicKey: a.publicKey || '',
      }));

    walletState.addresses = addresses;
    walletState.address = addresses[0] || '';
    if (addresses.length === 0) throw new Error('Wallet address not found');

    // 3. Token metadata (symbol, decimals)
    //
    // The response weighs ~4.6 MB (17,682 tokens) and the poll runs every 3 s.
    // Symbols and decimals do not change within a session, so fetch them once.
    if (!cachedMetadata) {
      try {
        cachedMetadata = buildMetadataMap(await getTokensForActiveNetworksMode());
      } catch (e) {
        console.warn('[walletStore] failed to load token metadata:', e);
      }
    }
    const metadata =
      // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local cache for the call
      cachedMetadata ?? new Map<string, { symbol: string; decimals: number }>();

    // 4. Balances for all wallet account addresses at once.
    // The balance controller computes them for exactly this set, so the list
    // must match or the response comes back empty.
    const balanceData = await getBalances(addresses, true);
    const byAddr = (balanceData.result ?? {}) as Record<string, any[]>;

    // Collect tokens across all addresses: usually one per account, but the
    // response carries an entry for every requested address.
    const tokens: any[] = [];
    for (const addr of addresses) {
      const key = Object.keys(byAddr).find(
        (k) => k.toLowerCase() === addr.toLowerCase()
      );
      if (key && Array.isArray(byAddr[key])) tokens.push(...byAddr[key]);
    }

    let errored = 0;

    const parsed: WalletToken[] = tokens.map((t: any) => {
      const chainId = Number(t.tokenChainId);
      const tokenAddress = String(t.tokenAddress || '');
      const hasError = t.hasError === true || t.hasError === 'true';
      if (hasError) errored++;

      const meta = metadata.get(tokenKey(chainId, tokenAddress));
      const symbol =
        meta?.symbol ||
        (tokenAddress.startsWith('0x') ? tokenAddress.slice(0, 6) : 'Unknown');

      return {
        symbol,
        decimals: meta?.decimals ?? 18,
        balance: String(t.rawBalance ?? '0'),
        chainId,
        tokenAddress,
        hasError,
      };
    });

    // Sort: tokens with a non-zero balance first, then by symbol.
    parsed.sort((a, b) => {
      const aZero = a.balance === '0' ? 1 : 0;
      const bZero = b.balance === '0' ? 1 : 0;
      if (aZero !== bZero) return aZero - bZero;
      return a.symbol.localeCompare(b.symbol);
    });

    walletState.balances = parsed;
    walletState.loaded = true;

    // 5. Prices — mainnet chains only.
    //
    // CoinGecko does not know test tokens (`mapTokensToIds` drops everything
    // that is not `IsMainnet()`), so a request for a test network would return
    // nothing. Ask only for what can have a price and do not treat an empty
    // answer as an error: balances are already shown, the total is an extra.
    const pricedKeys = parsed
      .filter((t) => MAINNET_CHAINS.has(t.chainId) && !t.hasError && t.balance !== '0')
      .map((t) => priceKey(t.chainId, t.tokenAddress));

    if (pricedKeys.length > 0) {
      try {
        const prices = await getTokenPrices(pricedKeys);
        walletState.prices = prices;
        debug(`[walletStore] prices loaded: ${Object.keys(prices).length}`);
      } catch (e) {
        // Not a screen error: balances show without a total.
        walletState.prices = {};
        debug('[walletStore] price fetch failed:', e);
      }
    } else {
      walletState.prices = {};
    }

    if (tokens.length === 0) {
      // An empty response is NOT an RPC error. The backend returned zero tokens,
      // meaning the token catalog is not filled in: there was nothing to ask
      // balances for, and no network request was made. Saying "RPC unreachable"
      // here would send the user to fix providers that are not at fault.
      walletState.rpcError =
        'Каталог токенов пуст: бэкенд не вернул ни одного токена ' +
        'для активных сетей, поэтому балансы запрашивать не о чем. ' +
        'Проверьте список токенов и активные сети.';
      console.warn(
        '[Wallet] wallet_fetchOrGetCachedWalletBalances вернул 0 токенов — ' +
        'каталог токенов пуст (это не ошибка RPC)'
      );
    } else if (errored === tokens.length) {
      walletState.rpcError =
        'RPC недоступен: ни одна сеть не вернула баланс. ' +
        'Проверьте RPC-провайдеров в настройках сети.';
      console.warn(`[Wallet] Все ${tokens.length} токенов с hasError=true (RPC недоступен)`);
    } else if (errored > 0) {
      console.warn(`[Wallet] ${errored} из ${tokens.length} токенов с hasError=true`);
    } else {
      // All good — drop the banner if it was left from the previous poll.
      walletState.rpcError = '';
    }

    debug('[walletStore] ✓ loaded', {
      tokens: parsed.length,
      errored,
    });
  } catch (e: any) {
    walletState.error = formatError(e, 'Failed to load wallet');
    console.error('[walletStore] ✗ Wallet error:', e);
  } finally {
    walletState.isLoading = false;
  }
}

let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Periodic balance refresh.
 *
 * @param intervalMs - Poll interval, 3 seconds by default.
 * @remarks
 * `wallet_fetchOrGetCachedWalletBalances` READS THE CACHE: the `forceRefresh`
 * parameter is ignored by status-go (`pkg/services/wallet/api.go`). The balance
 * therefore does not update by itself — the cache is filled by the backend's
 * background refresher, and this poll only re-reads it.
 */
export function startWalletPolling(intervalMs = 3000) {
  stopWalletPolling();
  pollTimer = setInterval(() => {
    if (statusState.isLoggedIn && !walletState.isLoading) {
      loadWallet(true);
    }
  }, intervalMs);
}

export function stopWalletPolling() {
  if (pollTimer !== null) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

/**
 * A user-triggered "refresh now".
 *
 * @remarks
 * `loadWallet(true)` re-reads the backend cache but does not fill it:
 * `forceRefresh` in `wallet_fetchOrGetCachedWalletBalances` is ignored (see the
 * note in `status/wallet.ts`), so the button would show the same numbers.
 *
 * The working path is `wallet_restartWalletReloadTimer`, which triggers a full
 * background refetch. The call returns immediately while the numbers appear in
 * the cache a few seconds later, so the cache is re-read twice, with a delay.
 * The delay is short and fixed because there is no signal confirming that
 * balances were updated.
 */
export async function refreshWallet(): Promise<void> {
  if (!statusState.backendRunning || walletState.isLoading) return;

  walletState.isRefreshing = true;
  try {
    await restartWalletReloadTimer();
    // Give the controller time to reach the networks, then re-read the cache.
    await new Promise((r) => setTimeout(r, REFRESH_SETTLE_MS));
    await loadWallet(true);
    // Second read: the controller fills the cache network by network, and one
    // pass is not always enough — on a slow network some tokens are still stale.
    await new Promise((r) => setTimeout(r, REFRESH_SETTLE_MS));
    await loadWallet(true);
  } catch (e) {
    debug('[walletStore] refresh failed:', e);
    walletState.error = formatError(e, 'Failed to refresh balances');
  } finally {
    walletState.isRefreshing = false;
  }
}

/**
 * How long to wait after starting a refetch before reading the cache.
 *
 * Chosen from the controller's behaviour: it queries networks in parallel, and
 * public RPCs answer within 1–3 s. Waiting longer only keeps the user at the
 * spinner.
 */
const REFRESH_SETTLE_MS = 1500;

export function resetWallet() {
  stopWalletPolling();
  cachedMetadata = null;
  walletState.isLoading = false;
  walletState.error = '';
  walletState.rpcError = '';
  walletState.loaded = false;
  walletState.isRefreshing = false;
  walletState.address = '';
  walletState.addresses = [];
  walletState.balances = [];
  // Prices belong to the profile session: foreign rates in the total of a new
  // session would look real.
  walletState.prices = {};
}
