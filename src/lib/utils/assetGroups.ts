/**
 * Groups tokens for the asset list.
 *
 * Grouping decides what a person sees as one row and what appears as separate
 * rows. It is not layout: summing `ETH` from Sepolia with `ETH` from Base
 * Sepolia would show a number that exists in no network at all, which is why
 * the logic lives outside the component.
 *
 * One row means "the same asset, countable together":
 *
 * - mainnet (Ethereum, Optimism, Arbitrum, Base) forms one `EVM` group — ETH on
 *   each of them really is the same ETH at different layers, and Status shows a
 *   combined total;
 * - BNB Chain gets its own `BSC` group;
 * - every test network is its own group. A catch-all "everything else goes to
 *   OTHER" would collapse five distinct test ETH into a single row.
 *
 * The key includes `decimals` because amounts can only be summed in the same
 * unit. Two tokens sharing a symbol but not their precision (common with
 * different USDC issues) have `rawBalance` in different units, so they stay on
 * separate rows.
 */

import type { WalletToken } from '$lib/stores/walletStore.svelte';

/** Networks whose balances count as one asset. */
const EVM_CHAINS = new Set([1, 10, 42161, 8453]);

/** BNB Chain. BSC Testnet (97) is deliberately absent — see `chainGroup`. */
const BSC_CHAINS = new Set([56]);

/** Human-readable network names, used for row labels. */
export const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum',
  10: 'Optimism',
  56: 'BNB Chain',
  97: 'BNB Testnet',
  8453: 'Base',
  42161: 'Arbitrum',
  84532: 'Base Sepolia',
  560048: 'Hoodi',
  11155111: 'Sepolia',
  11155420: 'Optimism Sepolia',
  421614: 'Arbitrum Sepolia',
};

/**
 * Group a network belongs to.
 *
 * An unknown or test network gets its own group keyed by its chain id: it must
 * not be summed with anything until it is known to be the same asset.
 *
 * @param chainId - The EIP-155 chain id.
 * @returns `'EVM'`, `'BSC'`, or the chain id as a string.
 */
export function chainGroup(chainId: number): string {
  if (EVM_CHAINS.has(chainId)) return 'EVM';
  if (BSC_CHAINS.has(chainId)) return 'BSC';
  return String(chainId);
}

/**
 * Strips invisible characters from a symbol and upper-cases it.
 *
 * @param symbol - The raw symbol from the backend.
 * @returns The normalized symbol; an empty string for a missing value.
 */
export function normalizeSymbol(symbol: string): string {
  return String(symbol || '')
    .replace(/[​-‍﻿]/g, '')
    .trim()
    .toUpperCase();
}

export interface AssetGroup {
  /** Unique key of the list row. */
  key: string;
  /** Network group: `EVM`, `BSC`, or a chain id as a string. */
  group: string;
  symbol: string;
  /** Decimal places; always the same value within a group. */
  decimals: number;
  /** Total in the smallest unit. */
  totalBalance: bigint;
  /** Networks the total is summed from. */
  chains: number[];
  hasError: boolean;
}

/** Reads a balance defensively: a broken value must not crash the list. */
function rawOf(token: WalletToken): { value: bigint; broken: boolean } {
  try {
    return { value: BigInt(token.balance || '0'), broken: false };
  } catch {
    return { value: 0n, broken: true };
  }
}

/**
 * Builds the rows of the asset list.
 *
 * Non-zero balances come first, then rows are ordered by symbol. Inside a row,
 * networks are listed in display priority (`CHAIN_PRIORITY` in the component),
 * so the order here does not matter.
 *
 * @param tokens - Tokens as held by `walletStore`.
 * @returns One group per asset, already sorted for display.
 */
export function groupAssets(tokens: WalletToken[]): AssetGroup[] {
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local map for the call
  const map = new Map<string, AssetGroup>();

  for (const token of tokens) {
    const symbol = normalizeSymbol(token.symbol);
    const group = chainGroup(token.chainId);
    const baseKey = `${symbol}:${group}`;

    // Same symbol and group but different precision means a different asset.
    const existingBase = map.get(baseKey);
    const key =
      existingBase && existingBase.decimals !== token.decimals
        ? `${baseKey}:${token.decimals}`
        : baseKey;

    const { value, broken } = rawOf(token);
    const existing = map.get(key);

    if (existing) {
      existing.totalBalance += value;
      if (!existing.chains.includes(token.chainId)) {
        existing.chains.push(token.chainId);
      }
      existing.hasError = existing.hasError || token.hasError || broken;
    } else {
      map.set(key, {
        key,
        group,
        symbol,
        decimals: token.decimals,
        totalBalance: value,
        chains: [token.chainId],
        hasError: token.hasError || broken,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const aZero = a.totalBalance === 0n ? 1 : 0;
    const bZero = b.totalBalance === 0n ? 1 : 0;
    if (aZero !== bZero) return aZero - bZero;
    return a.symbol.localeCompare(b.symbol);
  });
}

/**
 * Builds the label of an asset row.
 *
 * `EVM` and `BSC` read like Status, `ETH (EVM)`; a single network uses its
 * human name, `ETH (Sepolia)`, and falls back to the bare symbol when the name
 * is unknown.
 *
 * @param group - The group to label.
 * @returns The row label.
 * @remarks Without the network name, five different test ETH would be
 * indistinguishable from each other.
 */
export function groupLabel(group: AssetGroup): string {
  if (group.group === 'EVM' || group.group === 'BSC') {
    return `${group.symbol} (${group.group})`;
  }
  const name = CHAIN_NAMES[Number(group.group)];
  return name ? `${group.symbol} (${name})` : group.symbol;
}
