/**
 * Send state.
 *
 * The profile password is needed for every transfer: status-go unlocks the key
 * with it (`wallet_signMessage` → `gethManager.LoadAccount`). It is entered once
 * per session, as in the Status mobile app, and kept in frontend memory until
 * logout. That is an accepted trade-off: under XSS the password is reachable by
 * the script.
 *
 * @remarks
 * The transfer itself goes through the Rust command `send_transfer`, which runs
 * the three status-go calls (build → sign → send) itself: the password is passed
 * for the duration of the call, and signing and transaction assembly are not
 * exposed. A foreign script therefore gets neither a general signing primitive
 * nor a password stored on disk. status-go returns the signature with a `0x`
 * prefix that `wallet_sendTransactionWithSignature` must not receive, so the
 * prefix is stripped inside Rust. The password is never written to disk;
 * `resetSend` runs on logout.
 *
 * The flow is split into steps rather than one form so that a confirmation
 * screen can show network, asset, amount, recipient and fee — the last chance to
 * notice a wrong address. The "Send" button there records the intent, and only
 * after it does any work with the key begin.
 */

import { invoke } from '@tauri-apps/api/core';
import { statusState } from './statusStore.svelte';
import { loadWallet, walletState, type WalletToken } from './walletStore.svelte';
import { restartWalletReloadTimer } from '$lib/status/wallet';
import { debug, info, warn } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';

export type SendStep = 'form' | 'confirm' | 'sending' | 'sent' | 'failed';

/**
 * Reason a send failed.
 *
 * Each case gets its own code because each needs a different action: re-enter
 * the password, lower the amount, or wait for RPC. A single "Failed" text says
 * nothing.
 */
export type SendErrorCode =
  | 'send-wallet-not-ready'
  | 'send-wrong-password'
  | 'send-insufficient-funds'
  | 'send-rpc-unavailable'
  | 'send-invalid-address'
  | 'send-unknown';

export const sendState = $state({
  step: 'form' as SendStep,
  /** Session password. In memory, not on disk. */
  password: '',
  /** The user is being asked for the password — the input field is shown. */
  needsPassword: false,
  isSending: false,
  error: '',
  /** Hash of the sent transaction, for the explorer link. */
  txHash: '',
  /**
   * Fee estimate in smallest units (`null` when not computed yet).
   *
   * Computed on the confirmation step before the password is entered:
   * `estimate_transfer_fee` only assembles the transaction, does not touch the
   * key and sends nothing.
   */
  fee: null as bigint | null,
  /** A fee estimate is running. */
  isEstimating: false,
  /** The fee could not be obtained — the reason is shown, sending is not blocked. */
  feeError: '',
  /**
   * The error resolved to a known cause, for display.
   *
   * A code rather than text: turning a status-go error into a readable phrase is
   * the UI's job, and the phrase must be translatable.
   */
  errorCode: '' as SendErrorCode | '',
});

/** Forgets the password. Called on logout and profile switch. */
export function resetSend(): void {
  sendState.step = 'form';
  sendState.password = '';
  sendState.needsPassword = false;
  sendState.isSending = false;
  sendState.error = '';
  sendState.txHash = '';
  sendState.fee = null;
  sendState.isEstimating = false;
  sendState.feeError = '';
  sendState.errorCode = '';
}

/**
 * Stores the password in session memory after a successful entry.
 *
 * @param password - Profile password to keep for the session.
 */
export function rememberPassword(password: string): void {
  sendState.password = password;
  sendState.needsPassword = false;
}

export interface TransferInput {
  token: WalletToken;
  /** Recipient address, already validated on the form. */
  to: string;
  /** Amount in smallest units. */
  amount: bigint;
}

/**
 * Estimates the fee for a transfer.
 *
 * @param input - Token, recipient and amount.
 * @remarks
 * Called when entering the confirmation screen, before the password: the command
 * only assembles the transaction and reads `gas` and `gasPrice` from it, without
 * touching the key. A failure does not block sending — the user can still send,
 * just without the fee line.
 */
export async function estimateFee(input: TransferInput): Promise<void> {
  if (!statusState.backendRunning || !walletState.address) return;

  sendState.isEstimating = true;
  sendState.feeError = '';
  try {
    const result = await invoke<{ fee: string; gas: string; gas_price: string }>(
      'estimate_transfer_fee',
      {
        request: {
          chain_id: input.token.chainId,
          from: walletState.address,
          to: input.to,
          token_address: input.token.tokenAddress,
          amount: input.amount.toString(),
        },
      }
    );
    sendState.fee = BigInt(result.fee);
    debug(`[send] fee estimate: ${result.fee} wei (gas ${result.gas} × ${result.gas_price})`);
  } catch (e) {
    // Show the reason next to the fee but do not block sending: the node
    // recomputes the fee when it assembles the transaction anyway.
    sendState.fee = null;
    sendState.feeError = formatError(e, 'Failed to estimate the fee');
    debug('[send] fee estimate failed:', e);
  } finally {
    sendState.isEstimating = false;
  }
}

/**
 * Maps a status-go error to one of the known causes.
 *
 * @param message - Error text from the backend.
 * @returns The matching code, or `send-unknown`.
 * @remarks
 * status-go provides no error codes, only text, so causes are matched by
 * substring. A mismatch is harmless: the code only selects the hint text, it does
 * not change the send, and the original error stays in `error` and is shown in
 * full.
 */
export function classifySendError(message: string): SendErrorCode {
  const m = message.toLowerCase();

  if (m.includes('incorrect password') || m.includes('decrypt') || m.includes('authentication')) {
    return 'send-wrong-password';
  }
  if (m.includes('insufficient funds') || m.includes('exceeds balance') || m.includes('not enough')) {
    return 'send-insufficient-funds';
  }
  // RPC: the network did not answer. Seen when a system proxy tore the
  // connection down and every provider failed at once.
  if (
    m.includes('error sending request') ||
    m.includes('bad gateway') ||
    m.includes('connection reset') ||
    m.includes('timeout') ||
    m.includes('502')
  ) {
    return 'send-rpc-unavailable';
  }
  if (m.includes('invalid') && m.includes('address')) {
    return 'send-invalid-address';
  }
  return 'send-unknown';
}

/**
 * Sends a transfer.
 *
 * @param input - Token, recipient and amount in smallest units.
 * @returns `true` when the transfer went through, `false` when it failed or the
 * password is still needed.
 * @remarks
 * The whole sequence runs in Rust. `send_transfer` makes three status-go calls —
 * build → sign → send — so the webview never calls `wallet_signMessage` itself,
 * which would be a general signing primitive for arbitrary bytes with the wallet
 * key. See the header of `src-tauri/src/transfer.rs`.
 *
 * The balance is refreshed after sending because the backend cache is filled by
 * the background controller, not by this request (`forceRefresh` in
 * `wallet_fetchOrGetCachedWalletBalances` is ignored), so a full refetch is
 * started and the cache is read again.
 */
export async function sendTransfer(input: TransferInput): Promise<boolean> {
  if (!statusState.backendRunning || !walletState.address) {
    sendState.error = 'Wallet is not ready';
    sendState.errorCode = 'send-wallet-not-ready';
    sendState.step = 'failed';
    return false;
  }

  if (!sendState.password) {
    sendState.needsPassword = true;
    sendState.error = '';
    return false;
  }

  sendState.isSending = true;
  sendState.step = 'sending';
  sendState.error = '';

  try {
    const result = await invoke<{ tx_hash: string }>('send_transfer', {
      request: {
        chain_id: input.token.chainId,
        from: walletState.address,
        to: input.to,
        token_address: input.token.tokenAddress,
        amount: input.amount.toString(),
        password: sendState.password,
      },
    });

    sendState.txHash = result?.tx_hash ?? '';
    sendState.step = 'sent';
    info(`[send] sent ${input.amount} of ${input.token.symbol} on ${input.token.chainId}`);

    // Balance after the transfer: refetch in the background, then read.
    void refreshAfterSend();
    return true;
  } catch (e) {
    // A wrong password is the most common failure. Drop the stored one so the
    // next attempt asks again instead of silently repeating the failure.
    const message = formatError(e, 'Failed to send');
    sendState.errorCode = classifySendError(message);

    if (sendState.errorCode === 'send-wrong-password') {
      // Silently retrying a known-bad attempt is the worst option here: the user
      // must see that the password was wrong.
      sendState.password = '';
      sendState.needsPassword = true;
    }

    sendState.error = message;
    sendState.step = 'failed';
    warn('[send] failed:', e);
    return false;
  } finally {
    sendState.isSending = false;
  }
}

/** Balance refresh after a send. Errors are not shown: they are secondary. */
async function refreshAfterSend(): Promise<void> {
  try {
    // Let the network accept the transaction, then ask the backend to refetch.
    await new Promise((r) => setTimeout(r, 3000));
    if (statusState.backendRunning) {
      await restartWalletReloadTimer();
      await new Promise((r) => setTimeout(r, 2000));
      await loadWallet(true);
    }
  } catch (e) {
    debug('[send] balance refresh after send failed:', e);
  }
}

/** Returns to the input step — used by the "Edit" button. */
export function backToForm(): void {
  sendState.step = 'form';
  sendState.error = '';
  sendState.txHash = '';
}
