/**
 * Total account balance across the mainnet networks.
 *
 * ## Mainnet only
 *
 * The same ETH exists in five test networks as five separate entries. Adding
 * them to mainnet would show a sum that exists nowhere, since Sepolia ETH does
 * not convert to ETH. Test networks are therefore excluded from the total
 * entirely rather than counted at a zero price. The total is derived from
 * prices, and a price is approximate: it moves every minute, and some tokens
 * have none at all (a new token, a test network, a listing missing from
 * CoinGecko). The figure is always roughly right, and `unpriced` reports how
 * many tokens it left out.
 *
 * ## Arithmetic
 *
 * Balances arrive in the smallest unit, and `1e18` as a `number` loses
 * precision beyond 16 significant digits. Each balance is divided as a `bigint`
 * by 10^decimals and only then turned into a number, which is enough for a
 * display figure.
 */

import type { WalletToken } from '$lib/stores/walletStore.svelte';

/**
 * Networks included in the total.
 *
 * Mainnet only: Ethereum, Optimism, BNB Chain, Base, Arbitrum.
 *
 * @remarks This matches `EVM_CHAINS` plus `BSC_CHAINS` in `assetGroups.ts` but
 * is kept separate on purpose — that set answers "what counts as one asset",
 * this one answers "what counts as money".
 */
export const MAINNET_CHAINS: ReadonlySet<number> = new Set([1, 10, 56, 8453, 42161]);

/** Converts a smallest-unit balance to a main-unit number, for display. */
function toNumber(balance: bigint, decimals: number): number {
  if (decimals <= 0) return Number(balance);
  const divisor = 10n ** BigInt(decimals);
  const whole = balance / divisor;
  const fraction = balance % divisor;
  // Convert the remainder separately: bigint division would drop it.
  return Number(whole) + Number(fraction) / Number(divisor);
}

/**
 * Builds the token key `wallet_fetchPrices` expects.
 *
 * @param chainId - The chain id.
 * @param tokenAddress - The token contract address.
 * @returns The key in the `chainId-address` form, with the address lower-cased.
 */
export function priceKey(chainId: number, tokenAddress: string): string {
  return `${chainId}-${tokenAddress.toLowerCase()}`;
}

/** A row for a token with a balance but no price. */
export interface UnpricedToken {
  symbol: string;
  chainId: number;
  /** Balance in the smallest unit. */
  balance: bigint;
  decimals: number;
}

export interface TotalBalance {
  /** Sum in the currency of the prices. `0` when there are no prices at all. */
  total: number;
  /** Number of tokens included in the total. */
  priced: number;
  /** Tokens with a non-zero balance but no price. */
  unpriced: UnpricedToken[];
  /** Some assets were left out; the total is incomplete. */
  isPartial: boolean;
}

/**
 * Computes the account total.
 *
 * @param tokens - Tokens as held by `walletStore`.
 * @param prices - Flat `chainId-address` to price map, as `getTokenPrices`
 * returns it.
 * @returns The total, the number of priced tokens and the list of unpriced
 * ones.
 * @remarks A token without a price is not dropped silently: it goes into
 * `unpriced`, because a "total 0" on a full wallet would read as a bug.
 */
export function totalBalance(
  tokens: WalletToken[],
  prices: Record<string, number>
): TotalBalance {
  let total = 0;
  let priced = 0;
  const unpriced: UnpricedToken[] = [];

  for (const token of tokens) {
    if (!MAINNET_CHAINS.has(token.chainId)) continue;
    // A token with no RPC reply is unknown, not zero.
    if (token.hasError) continue;

    let balance: bigint;
    try {
      balance = BigInt(token.balance || '0');
    } catch {
      continue;
    }
    if (balance === 0n) continue;

    const price = prices[priceKey(token.chainId, token.tokenAddress)];
    if (typeof price !== 'number' || !Number.isFinite(price)) {
      unpriced.push({
        symbol: token.symbol,
        chainId: token.chainId,
        balance,
        decimals: token.decimals,
      });
      continue;
    }

    total += toNumber(balance, token.decimals) * price;
    priced++;
  }

  return {
    total,
    priced,
    unpriced,
    isPartial: unpriced.length > 0,
  };
}

/**
 * Formats the total for display, marked as approximate.
 *
 * @param total - The total in the price currency.
 * @param currency - Currency symbol, `$` by default.
 * @returns The string with a leading `≈`; `≈ $0` for a non-finite input.
 * @remarks Large sums lose the cents: showing a cent's precision on an
 * approximate figure would suggest an accuracy it does not have.
 */
export function formatTotal(total: number, currency = '$'): string {
  if (!Number.isFinite(total)) return `≈ ${currency}0`;
  const rounded = total >= 100 ? Math.round(total) : Math.round(total * 100) / 100;
  const text = rounded.toLocaleString('en-US', {
    minimumFractionDigits: 0,
    maximumFractionDigits: total >= 100 ? 0 : 2,
  });
  return `≈ ${currency}${text}`;
}
