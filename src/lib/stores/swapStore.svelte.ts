/**
 * Token swap state.
 *
 * @remarks
 * Mainnet only: providers (Paraswap, LI.FI) have no liquidity on test networks,
 * so a swap there is impossible. This is checked both in Rust (`swap.rs`) and on
 * the form, so the user does not pick tokens only to be refused on submit.
 *
 * The quote runs before the password is entered: `get_swap_quote` only builds a
 * route at the provider and reads the amounts from it — no key, no signature,
 * nothing sent to the network — so the expected output is visible early.
 *
 * Slippage is fixed at 1% and shown on screen. It is not adjustable in the UI: a
 * careless 10% is a direct way to lose money.
 */

import { invoke } from '@tauri-apps/api/core';
import { statusState } from './statusStore.svelte';
import { walletState, type WalletToken } from './walletStore.svelte';
import { sendState } from './sendStore.svelte';
import { checkAmountAgainstBalance } from '$lib/utils/tokens';
import { debug, info, warn } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';

export type SwapStep = 'form' | 'confirm' | 'sending' | 'done' | 'failed';

/** Networks where swaps work. Matches `SWAP_CHAINS` in `swap.rs`. */
export const SWAP_CHAINS: ReadonlySet<number> = new Set([1, 10, 56, 8453, 42161]);

/** Native asset: identified by the zero address. */
export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';

/** Slippage tolerance, fixed in `swap.rs` and shown to the user. */
export const SLIPPAGE_PERCENT = 1;

export const swapState = $state({
  step: 'form' as SwapStep,
  /** Source token key: `chainId:address`. */
  fromKey: '',
  /** Target token key. */
  toKey: '',
  /** Amount to swap, as entered. */
  amount: '',
  /** Expected output, in the target token's smallest units. */
  amountOut: null as bigint | null,
  /** Minimum output at the current slippage. */
  minAmountOut: null as bigint | null,
  /** Network fee in wei. `null` when not computed. */
  fee: null as bigint | null,
  /** Whether a separate approve is needed. */
  needsApproval: false,
  /** Provider the route goes through. */
  provider: '',
  isQuoting: false,
  quoteError: '',
  isSending: false,
  error: '',
  txHash: '',
  approvalTxHash: '',
  /** A swap is impossible on the test network. */
  unsupportedChain: false,
});

export function resetSwap(): void {
  swapState.step = 'form';
  swapState.fromKey = '';
  swapState.toKey = '';
  swapState.amount = '';
  swapState.amountOut = null;
  swapState.minAmountOut = null;
  swapState.fee = null;
  swapState.needsApproval = false;
  swapState.provider = '';
  swapState.isQuoting = false;
  swapState.quoteError = '';
  swapState.isSending = false;
  swapState.error = '';
  swapState.txHash = '';
  swapState.approvalTxHash = '';
  swapState.unsupportedChain = false;
}

/** Token key in the same form the wallet store uses. */
export function tokenKeyOf(token: WalletToken): string {
  return `${token.chainId}:${token.tokenAddress.toLowerCase()}`;
}

/** Tokens that can be given: non-zero balance on a supported network. */
export function swapSources(tokens: WalletToken[]): WalletToken[] {
  return tokens.filter(
    (t) => SWAP_CHAINS.has(t.chainId) && !t.hasError && t.balance !== '0'
  );
}

/**
 * Tokens that can be received: the same network as the source.
 *
 * @param tokens - Wallet tokens to choose from.
 * @param chainId - Source chain, or `null` when nothing is selected.
 * @returns Tokens of that chain, zero balances included.
 * @remarks
 * The list is limited to tokens the wallet already knows on that network —
 * showing 17,700 tokens in the UI is pointless. Other addresses can be entered
 * manually in the field next to it.
 */
export function swapTargets(tokens: WalletToken[], chainId: number | null): WalletToken[] {
  if (chainId === null) return [];
  return tokens.filter((t) => t.chainId === chainId);
}

/** Finds a token by key. */
export function findToken(tokens: WalletToken[], key: string): WalletToken | undefined {
  return tokens.find((t) => tokenKeyOf(t) === key);
}

/**
 * Requests a swap quote.
 *
 * @param fromToken - Token to swap from.
 * @param toToken - Token to swap to.
 * @param amountRaw - Amount as entered by the user.
 * @remarks
 * Called when entering confirmation and when the amount changes. A failure does
 * not block the screen but disables the send button: without an output amount
 * the user does not know what they are agreeing to.
 */
export async function quoteSwap(
  fromToken: WalletToken,
  toToken: WalletToken,
  amountRaw: string
): Promise<void> {
  const port = statusState.backendPort;
  if (!port || !walletState.address) return;

  // `checkAmountAgainstBalance` returns an error code instead of throwing:
  // parsing the amount and comparing it with the balance are both needed, and
  // both yield a translatable code.
  const parsed = checkAmountAgainstBalance(amountRaw, fromToken);
  if (!parsed.ok) {
    swapState.quoteError = parsed.error;
    swapState.amountOut = null;
    return;
  }

  swapState.isQuoting = true;
  swapState.quoteError = '';
  swapState.amountOut = null;
  swapState.minAmountOut = null;

  try {
    const quote = await invoke<{
      amount_out: string;
      min_amount_out: string;
      fee: string | null;
      needs_approval: boolean;
      provider: string;
    }>('get_swap_quote', {
      // Names are camelCase: Tauri converts command arguments to this form.
      port,
      chainId: fromToken.chainId,
      from: walletState.address,
      fromToken: fromToken.tokenAddress,
      toToken: toToken.tokenAddress,
      amount: parsed.amount.toString(),
    });

    swapState.amountOut = BigInt(quote.amount_out);
    swapState.minAmountOut = BigInt(quote.min_amount_out);
    swapState.fee = quote.fee === null ? null : BigInt(quote.fee);
    swapState.needsApproval = quote.needs_approval;
    swapState.provider = quote.provider;
    debug(
      `[swap] quote: ${quote.amount_out} out, min ${quote.min_amount_out}, via ${quote.provider}`
    );
  } catch (e) {
    swapState.quoteError = formatError(e, 'Failed to get a swap quote');
    debug('[swap] quote failed:', e);
  } finally {
    swapState.isQuoting = false;
  }
}

/**
 * Executes the swap.
 *
 * @param fromToken - Token to swap from.
 * @param toToken - Token to swap to.
 * @param amountRaw - Amount as entered by the user.
 * @returns `true` when the swap went through.
 * @remarks
 * The password comes from the shared session, as in transfers and name
 * registration: it is already needed for any signature, and asking for it again
 * in a third place would be redundant input.
 */
export async function performSwap(
  fromToken: WalletToken,
  toToken: WalletToken,
  amountRaw: string
): Promise<boolean> {
  const port = statusState.backendPort;
  if (!port || !walletState.address) {
    swapState.error = 'Wallet is not ready';
    swapState.step = 'failed';
    return false;
  }

  const parsed = checkAmountAgainstBalance(amountRaw, fromToken);
  if (!parsed.ok) {
    swapState.error = parsed.error;
    swapState.step = 'failed';
    return false;
  }

  if (!sendState.password) {
    sendState.needsPassword = true;
    return false;
  }

  swapState.isSending = true;
  swapState.step = 'sending';
  swapState.error = '';

  try {
    const result = await invoke<{ tx_hash: string; approval_tx_hash: string }>('swap_tokens', {
      request: {
        // Inside `request` names stay snake_case: it is the serde `SwapRequest`.
        port,
        chain_id: fromToken.chainId,
        from: walletState.address,
        from_token: fromToken.tokenAddress,
        to_token: toToken.tokenAddress,
        amount: parsed.amount.toString(),
        password: sendState.password,
      },
    });

    swapState.txHash = result?.tx_hash ?? '';
    swapState.approvalTxHash = result?.approval_tx_hash ?? '';
    swapState.step = 'done';
    info(`[swap] executed ${result?.tx_hash}`);
    return true;
  } catch (e) {
    const message = formatError(e, 'Failed to swap');
    if (/incorrect password|decrypt|authentication/i.test(message)) {
      sendState.password = '';
      sendState.needsPassword = true;
    }
    swapState.error = message;
    swapState.step = 'failed';
    warn('[swap] failed:', e);
    return false;
  } finally {
    swapState.isSending = false;
  }
}

/** Returns to the form. */
export function backToSwapForm(): void {
  swapState.step = 'form';
  swapState.error = '';
  swapState.txHash = '';
}

/** Swaps the source and target tokens. */
export function flipTokens(): void {
  const from = swapState.fromKey;
  swapState.fromKey = swapState.toKey;
  swapState.toKey = from;
  swapState.amountOut = null;
  swapState.minAmountOut = null;
}
