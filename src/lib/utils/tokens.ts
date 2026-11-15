/**
 * Groups tokens for the Send screen.
 *
 * `walletStore` deliberately keeps zero balances and tokens with `hasError` (no
 * RPC reply): in the asset list they are useful, since they show that a token
 * exists but its balance was not fetched. On the Send screen that list gets in
 * the way — 17 700 tokens of which two can be sent — so the same set is split
 * into what can be sent and what cannot, with a reason.
 *
 * An unavailable token is never hidden outright: a token that just received
 * funds would otherwise disappear, with no way to tell why.
 */

import { AmountError, parseAmount, type AmountErrorCode } from './amount';
import type { WalletToken } from '$lib/stores/walletStore.svelte';

/** Why a token cannot be sent. An empty string means it can. */
export type TokenBlockReason = 'no-balance' | 'rpc-error';

/**
 * Refusal codes for an amount check.
 *
 * The parse codes (`AmountErrorCode`) plus two cases the parser cannot see:
 * zero and an overdraft, both of which need the token's balance.
 */
export type AmountCheckError = AmountErrorCode | 'amount-zero' | 'amount-insufficient';

export interface SendableToken {
  token: WalletToken;
  /** Key within the group: `chainId:address`, as elsewhere in the code. */
  key: string;
  /** Why the token is unavailable; empty when it can be sent. */
  blocked: TokenBlockReason | '';
}

/**
 * Splits tokens into sendable and unsendable ones.
 *
 * Order within each group matches the asset list (non-zero first, then by
 * symbol): `walletStore` already sorted it, and re-sorting by letter here would
 * interleave the networks.
 *
 * @param tokens - Tokens as held by `walletStore`.
 * @returns Both lists, each keeping the input order.
 */
export function groupTokensForSending(tokens: WalletToken[]): {
  available: SendableToken[];
  unavailable: SendableToken[];
} {
  const available: SendableToken[] = [];
  const unavailable: SendableToken[] = [];

  for (const token of tokens) {
    const item: SendableToken = {
      token,
      key: `${token.chainId}:${token.tokenAddress}`,
      blocked: blockReasonOf(token),
    };
    if (item.blocked) unavailable.push(item);
    else available.push(item);
  }

  return { available, unavailable };
}

/**
 * Gives the reason a token is not usable for sending.
 *
 * @param token - The token to check.
 * @returns The reason, or an empty string when the token can be sent.
 * @remarks `hasError` is checked first: with no RPC reply the balance is
 * unknown, and "no funds" would be a false statement.
 */
export function blockReasonOf(token: WalletToken): TokenBlockReason | '' {
  if (token.hasError) return 'rpc-error';

  let balance: bigint;
  try {
    balance = BigInt(token.balance || '0');
  } catch {
    // A malformed balance is also unavailability, not zero.
    return 'rpc-error';
  }

  return balance <= 0n ? 'no-balance' : '';
}

/**
 * Checks an entered amount against the token's balance.
 *
 * Runs on the client before the network is touched, so "insufficient funds"
 * appears immediately instead of after an RPC round trip.
 *
 * @param raw - The raw string from the amount field.
 * @param token - The token being sent.
 * @returns `{ ok: true, amount }` with the amount in the smallest unit, or
 * `{ ok: false, error }` with a code the UI translates.
 * @remarks This does not replace the backend check; it only saves a round trip.
 */
export function checkAmountAgainstBalance(
  raw: string,
  token: WalletToken
): { ok: true; amount: bigint } | { ok: false; error: AmountCheckError } {
  let amount: bigint;
  try {
    amount = parseAmount(raw, token.decimals);
  } catch (e) {
    // A code goes out — the UI translates it into the user's language. The
    // English text in `message` stays for the logs.
    return {
      ok: false,
      error: e instanceof AmountError ? e.code : 'amount-invalid',
    };
  }

  if (amount <= 0n) {
    return { ok: false, error: 'amount-zero' };
  }

  if (amount > BigInt(token.balance || '0')) {
    return { ok: false, error: 'amount-insufficient' };
  }

  return { ok: true, amount };
}
