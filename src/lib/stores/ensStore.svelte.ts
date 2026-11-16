/**
 * ENS name registration state (`<name>.stateofus.eth`).
 *
 * @remarks
 * The password comes from the shared session (`sendState.password`) rather than
 * being asked for here: registration is a transaction too, and a second password
 * prompt would be redundant input.
 *
 * The whole sequence runs in Rust. Registration signs as many transactions as the
 * Router returned, and `wallet_signMessage` signs any 32 bytes; if the hashes
 * reached the webview, a foreign script could ask for any of them to be signed.
 * `register_ens_name` keeps the hashes, the password and signature parsing
 * inside, so only "register this name" crosses the boundary. See
 * `src-tauri/src/ens.rs`.
 *
 * The name is entered without the domain: `.stateofus.eth` is the only domain the
 * Status registrar handles (`UsernameToLabel` hashes exactly this label), and
 * showing it in the input would let a user type `.eth` and get
 * `.eth.stateofus.eth`. The domain is appended and shown next to the field.
 */

import { invoke } from '@tauri-apps/api/core';
import { statusState } from './statusStore.svelte';
import { walletState, loadWallet } from './walletStore.svelte';
import { sendState } from './sendStore.svelte';
import { addEnsUsername, getEnsUsernames } from '$lib/status/wallet';
import { debug, info, warn } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';

export type EnsStep = 'form' | 'confirm' | 'sending' | 'done' | 'failed';

/** Domain under which the Status registrar issues names. */
export const ENS_DOMAIN = 'stateofus.eth';

export const ensState = $state({
  step: 'form' as EnsStep,
  /** Name without the domain, as entered. */
  username: '',
  /** Price in the smallest units of SNT/STT (18 decimals). */
  price: null as bigint | null,
  /** Network fee in wei. */
  fee: null as bigint | null,
  /** The name is taken by someone else. */
  taken: false,
  /** Owner, when the name is taken. */
  owner: '',
  isChecking: false,
  /** Why the price or availability check failed. */
  checkError: '',
  isSending: false,
  error: '',
  txHash: '',
  /** Full name after a successful registration. */
  fullName: '',
  /** Networks where registration is impossible (neither mainnet nor Sepolia). */
  unsupportedChain: false,
  /**
   * Names of this profile recorded in its database (`ens_getEnsUsernames`).
   *
   * Kept apart from `fullName`: `fullName` is the result of the last registration
   * in this session, while this is what the profile permanently knows about
   * itself, and it is what the profile shows under the name.
   */
  profileNames: [] as string[],
});

export function resetEns(): void {
  ensState.step = 'form';
  ensState.username = '';
  ensState.price = null;
  ensState.fee = null;
  ensState.taken = false;
  ensState.owner = '';
  ensState.isChecking = false;
  ensState.checkError = '';
  ensState.isSending = false;
  ensState.error = '';
  ensState.txHash = '';
  ensState.fullName = '';
  ensState.unsupportedChain = false;
  ensState.profileNames = [];
}

/** Networks with a Status registrar (matches `snt_address` in Rust). */
export function ensSupported(chainId: number): boolean {
  return chainId === 1 || chainId === 11155111;
}

/**
 * Name rules — the same as in Rust (`validate_username`).
 *
 * @param name - Raw name from the form.
 * @returns An i18n error key, or an empty string when the name is valid.
 * @remarks
 * The duplication is deliberate: this check avoids sending a request that is
 * bound to fail and gives an immediate hint. Rust still makes the decision; this
 * is only for the form hint.
 */
export function usernameError(name: string): string {
  const value = name.trim();
  if (!value) return 'ens-name-empty';
  if (value.length < 3 || value.length > 31) return 'ens-name-length';
  if (value.startsWith('-') || value.endsWith('-')) return 'ens-name-hyphen';
  if (!/^[a-z0-9-]+$/.test(value)) return 'ens-name-chars';
  return '';
}

/**
 * Stake token address per network.
 *
 * @remarks
 * Must match `snt_address` in `src-tauri/src/ens.rs`, or the balance is not found
 * and the user sees "no funds" with a full wallet. The same contract is SNT on
 * mainnet and STT on Sepolia, so it is looked up by address, not by symbol.
 */
const STAKE_ADDRESS: Record<number, string> = {
  1: '0x744d70fdbe2ba4cf95131626614a1763df805b9e',
  11155111: '0xe452027cdef746c7cd3db31cb700428b16cd8e51',
};

/** Native asset in the backend response — the zero address. */
const NATIVE_ADDRESS = '0x0000000000000000000000000000000000000000';

export interface ChainBalances {
  /** Stake token (SNT/STT). `null` when not loaded or RPC did not answer. */
  stake: bigint | null;
  /** Native ETH of this network, which pays the fee. */
  native: bigint | null;
}

/**
 * Balances that decide whether registration can go through.
 *
 * @param chainId - Chain to read the balances for.
 * @returns Stake and native balances in smallest units.
 * @remarks
 * `null` instead of zero where the balance is unknown: the token may be missing
 * from the response or come back with `hasError`. Showing "0" there would assert
 * there is no money when it was simply never asked for.
 */
export function chainBalances(chainId: number): ChainBalances {
  const find = (address: string): bigint | null => {
    const token = walletState.balances.find(
      (t) =>
        t.chainId === chainId &&
        t.tokenAddress.toLowerCase() === address.toLowerCase()
    );
    if (!token || token.hasError) return null;
    try {
      return BigInt(token.balance || '0');
    } catch {
      return null;
    }
  };

  const stakeAddress = STAKE_ADDRESS[chainId];
  return {
    stake: stakeAddress ? find(stakeAddress) : null,
    native: find(NATIVE_ADDRESS),
  };
}

/**
 * Wallet address used for signing and as the recipient.
 *
 * @returns The loaded wallet address, possibly empty when it cannot be loaded.
 * @remarks
 * The ENS block sits in the profile, which the user can open first without ever
 * opening the wallet, so `walletState.address` may still be empty. Without a
 * loaded address `checkName` would silently return and the field would look
 * broken.
 *
 * `loadWallet` is idempotent: with data already present it returns immediately
 * and only re-reads on `force`.
 */
async function ensureWalletAddress(): Promise<string> {
  if (walletState.address) return walletState.address;
  try {
    await loadWallet();
  } catch (e) {
    debug('[ens] wallet address load failed:', e);
  }
  return walletState.address;
}

/** Price and availability of the name. Read-only: no password needed. */
export async function checkName(): Promise<void> {
  if (!statusState.backendRunning) return;

  const chainId = statusState.chainId;
  ensState.unsupportedChain = !ensSupported(chainId);
  if (ensState.unsupportedChain) return;

  const name = ensState.username.trim();
  if (usernameError(name)) return;

  const address = await ensureWalletAddress();
  if (!address) {
    ensState.checkError = 'Wallet is not ready';
    return;
  }

  ensState.isChecking = true;
  ensState.checkError = '';
  ensState.taken = false;
  ensState.owner = '';

  try {
    const quote = await invoke<{
      price: string;
      /** `null` when the fee could not be obtained (not zero!). */
      fee: string | null;
      expires_at: string;
      owner: string;
      available: boolean;
    }>('get_ens_quote', {
      // The argument name is `chainId`, not `chain_id`: Tauri converts command
      // parameters to camelCase and answers "missing required key chainId"
      // otherwise. In Rust the parameter stays `chain_id`.
      chainId,
      from: walletState.address,
      username: name,
    });

    ensState.price = BigInt(quote.price);
    // `null` stays `null`: otherwise the UI would show "0", i.e. "free", when
    // the fee is merely unknown.
    ensState.fee = quote.fee === null ? null : BigInt(quote.fee);
    ensState.taken = !quote.available;
    ensState.owner = quote.owner;
    debug(
      `[ens] quote for ${name}: price ${quote.price}, fee ${quote.fee}, available ${quote.available}`
    );
  } catch (e) {
    // Not blocking: the price can be rechecked on confirmation, and the contract
    // makes the decision anyway.
    ensState.price = null;
    ensState.fee = null;
    ensState.checkError = formatError(e, 'Failed to check the name');
    debug('[ens] quote failed:', e);
  } finally {
    ensState.isChecking = false;
  }
}

/** Moves to the confirmation screen after refreshing the price. */
export async function goToConfirm(): Promise<void> {
  await checkName();
  ensState.error = '';
  ensState.step = 'confirm';
}

/**
 * Reads the names recorded in the profile.
 *
 * @remarks
 * Name ownership lives on chain, but "which of my names to show next to the nick"
 * is a profile property kept in its database, so this reads `ens_getEnsUsernames`
 * rather than `ens_getName`: reverse resolution (address → name) only works with
 * a reverse record, and the Status registrar does not create one — after
 * registering `magnus-redkin` the live backend returned nothing.
 *
 * An error is not propagated: a profile name is decoration, not a condition for
 * the app to work.
 */
export async function loadProfileNames(): Promise<void> {
  if (!statusState.backendRunning) return;

  try {
    const names = await getEnsUsernames();
    ensState.profileNames = names
      .filter((n: any) => n && n.username && n.removed !== true)
      .map((n: any) => String(n.username));
  } catch (e) {
    debug('[ens] failed to read profile names:', e);
  }
}

/**
 * Registers the name.
 *
 * @returns `true` on success; `false` when the wallet is not ready, the password
 * is missing or registration failed.
 * @remarks
 * The password comes from the session (`sendState.password`). When it is absent,
 * the flag is raised so the screen shows the input field — the same behaviour as
 * `sendTransfer`.
 */
export async function registerName(): Promise<boolean> {
  if (!statusState.backendRunning) {
    ensState.error = 'Wallet is not ready';
    ensState.step = 'failed';
    return false;
  }

  // The address may be unloaded when the user came to the profile without
  // opening the wallet. Load it the same way as in `checkName`.
  const address = await ensureWalletAddress();
  if (!address) {
    ensState.error = 'Wallet is not ready';
    ensState.step = 'failed';
    return false;
  }

  if (!sendState.password) {
    sendState.needsPassword = true;
    return false;
  }

  ensState.isSending = true;
  ensState.step = 'sending';
  ensState.error = '';

  try {
    const result = await invoke<{ tx_hash: string; full_name: string }>('register_ens_name', {
      request: {
        // Inside `request` names stay snake_case: it is the serde
        // `EnsRegisterRequest`, and Tauri's camelCase conversion covers only the
        // top-level command arguments (like `chainId` above).
        chain_id: statusState.chainId,
        from: walletState.address,
        username: ensState.username.trim(),
        password: sendState.password,
      },
    });

    ensState.txHash = result?.tx_hash ?? '';
    ensState.fullName = result?.full_name ?? '';
    ensState.step = 'done';
    info(`[ens] registered ${ensState.fullName} in ${ensState.txHash}`);

    // Record the name in the profile. A transaction on chain does not notify the
    // profile: `ens_getEnsUsernames` reads its own table, and without this write
    // the name would only be visible on chain.
    if (ensState.fullName) {
      try {
        await addEnsUsername(statusState.chainId, ensState.fullName);
        await loadProfileNames();
      } catch (e) {
        // Do not fail the registration: the name is already on chain, and
        // repeating the transaction over an unsaved profile row would be
        // expensive.
        warn('[ens] registered on chain but failed to record it in the profile:', e);
      }
    }

    return true;
  } catch (e) {
    const message = formatError(e, 'Failed to register the name');
    // Drop a wrong password so the failure is not silently repeated.
    if (/incorrect password|decrypt|authentication/i.test(message)) {
      sendState.password = '';
      sendState.needsPassword = true;
    }
    ensState.error = message;
    ensState.step = 'failed';
    warn('[ens] registration failed:', e);
    return false;
  } finally {
    ensState.isSending = false;
  }
}

/** Returns to the form. */
export function backToEnsForm(): void {
  ensState.step = 'form';
  ensState.error = '';
}
