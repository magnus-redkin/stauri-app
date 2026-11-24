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
import {
  addEnsUsername,
  ensAddressOf,
  ensOwnerOf,
  getEnsUsernames,
} from '$lib/status/wallet';
import { debug, info, warn } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';

export type EnsStep = 'form' | 'confirm' | 'sending' | 'done' | 'failed';

/**
 * Domain a name is entered under.
 *
 * @remarks
 * `stateofus.eth` is the Status registrar, paid in SNT/STT and registerable in
 * Stauri. `eth` is the regular ENS domain: Stauri can only attach a name that is
 * already registered, because registration needs the commit/register flow of
 * `ETHRegistrarController` (see `docs/en/ens_eth.md`).
 */
export type EnsDomain = 'stateofus.eth' | 'eth';

/** Domains offered in the form, in display order; `.stateofus.eth` stays the default. */
export const ENS_DOMAINS: EnsDomain[] = ['stateofus.eth', 'eth'];

/** Domain under which the Status registrar issues names. */
export const ENS_DOMAIN = 'stateofus.eth';

/** The zero address: what the registry reports for a name nobody owns. */
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export const ensState = $state({
  step: 'form' as EnsStep,
  /** Domain the name is entered under; `.stateofus.eth` by default. */
  domain: 'stateofus.eth' as EnsDomain,
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
  /**
   * Full `.eth` name the last check finished for; empty when none did.
   *
   * @remarks
   * A plain `.eth` name has no price to serve as the "checked" marker, so
   * "Available" would otherwise appear the moment a letter is typed, before the
   * registry was asked anything.
   */
  checkedName: '',
  isSending: false,
  error: '',
  txHash: '',
  /** Full name after a successful registration. */
  fullName: '',
  /**
   * The name on screen came from {@link attachExistingName}, not from a registration.
   *
   * @remarks
   * The success screen says "Name registered" and shows a transaction hash; neither is
   * true for a name that was already on chain and only recorded in this profile.
   */
  linked: false,
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

/**
 * Clears everything the form produced: the search result, the price, the error,
 * the transaction and the success screen.
 *
 * @remarks
 * Called when the profile editor opens. A name searched or registered in a
 * previous visit has no business on screen after the user leaves the section and
 * comes back: the price is stale, `taken` may belong to another domain, and a
 * "Name registered" banner reads as if it had just happened.
 *
 * `profileNames` is left alone on purpose: it is what the profile permanently
 * knows about itself, not a result of the form, and the editor reloads it on
 * open anyway.
 */
export function resetEnsForm(): void {
  ensState.step = 'form';
  ensState.domain = ENS_DOMAIN;
  ensState.username = '';
  ensState.price = null;
  ensState.fee = null;
  ensState.taken = false;
  ensState.owner = '';
  ensState.isChecking = false;
  ensState.checkError = '';
  ensState.checkedName = '';
  ensState.isSending = false;
  ensState.error = '';
  ensState.txHash = '';
  ensState.fullName = '';
  ensState.linked = false;
  ensState.unsupportedChain = false;
}

export function resetEns(): void {
  resetEnsForm();
  ensState.profileNames = [];
}

/**
 * Full name for the label typed in the form.
 *
 * @param label - Name without a domain.
 * @param domain - Domain to append; the current one by default.
 * @returns The full name, or an empty string for an empty label.
 */
export function fullEnsName(label: string, domain: EnsDomain = ensState.domain): string {
  const value = label.trim().toLowerCase();
  return value ? `${value}.${domain}` : '';
}

/**
 * Switches the domain and drops the result of the previous check.
 *
 * @param domain - Domain chosen in the form.
 * @remarks
 * The check runs again for the name already typed: "stauri" is free under
 * `.stateofus.eth` and taken under `.eth`, and leaving the old answer on screen
 * would state the opposite of the truth for the selected domain.
 */
export function setEnsDomain(domain: EnsDomain): void {
  if (ensState.domain === domain) return;
  ensState.domain = domain;
  ensState.price = null;
  ensState.fee = null;
  ensState.taken = false;
  ensState.owner = '';
  ensState.checkError = '';
  ensState.checkedName = '';
  ensState.error = '';
  if (ensState.username.trim() && !usernameError(ensState.username)) {
    void checkName();
  }
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

  // A regular `.eth` name is read from the registry, not from the Status
  // registrar: `get_ens_quote` hashes its argument as a `.stateofus.eth` label
  // and would report a different name.
  if (ensState.domain === 'eth') {
    await checkEthName(name);
    return;
  }

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
    // Owner and the profile's address list are logged together: "taken" plus no attach
    // button means the check found the name but could not match its owner to this
    // profile, and only these two values say which side is wrong.
    debug(
      `[ens] quote for ${name}: price ${quote.price}, fee ${quote.fee}, available ${quote.available}` +
        ` owner=${quote.owner || '-'} wallet=${walletState.address || '-'}` +
        ` accounts=${walletState.addresses.length}`
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

/**
 * Availability and owner of a plain `.eth` name.
 *
 * @param label - Name without the domain.
 * @remarks
 * The Status registrar knows `.stateofus.eth` only, so the price comes from
 * nowhere here: registration of `.eth` names is not in Stauri yet
 * (`docs/en/ens_eth.md`). What this answers is whether the name exists and
 * whether it points at this wallet, which is everything the "attach" path needs.
 *
 * Two values are read. The registry owner says whether the name is taken at all,
 * but a wrapped name reports the NameWrapper as its owner; the address record
 * says which address the name points at, and that is what matches a wallet.
 * Either one matching the profile counts.
 */
async function checkEthName(label: string): Promise<void> {
  const chainId = statusState.chainId;
  const name = fullEnsName(label, 'eth');

  ensState.isChecking = true;
  ensState.checkError = '';
  ensState.checkedName = '';
  ensState.taken = false;
  ensState.owner = '';
  ensState.price = null;
  ensState.fee = null;

  try {
    const [owner, record] = await Promise.all([
      ensOwnerOf(chainId, name),
      // No resolver or no address record is not an error for the question
      // asked; an empty answer just means "the record does not say".
      ensAddressOf(chainId, name).catch(() => ''),
    ]);

    const registered = !!owner && owner.toLowerCase() !== ZERO_ADDRESS;
    const points = record && record.toLowerCase() !== ZERO_ADDRESS ? record : '';
    ensState.taken = registered;
    // The record is the address people actually pay to; the registry owner is
    // the fallback and may be the NameWrapper for a wrapped name.
    ensState.owner = registered ? points || owner : '';
    ensState.checkedName = name;

    debug(
      `[ens] ${name}: registry owner ${owner || '-'}, address record ${record || '-'}`
    );
  } catch (e) {
    // The registry call failed: unknown, not free. Saying "available" here would
    // offer a name that may well be somebody else's.
    ensState.checkError = formatError(e, 'Failed to check the name');
    debug('[ens] .eth check failed:', e);
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

  // Registration exists only for the Status registrar. A plain `.eth` name is
  // bought through the ENS controller elsewhere and can only be attached here;
  // sending it through the Status route would register something under
  // `.stateofus.eth` instead.
  if (ensState.domain !== 'stateofus.eth') {
    ensState.error = 'Stauri cannot register .eth names yet. Register it in a dApp browser, then attach it here.';
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

/**
 * Rewrites the chat key recorded on the name.
 *
 * @param password - Profile password; taken from the session when omitted.
 * @returns `true` when the transaction was sent.
 * @remarks
 * Names registered before 0.5.3 carry the key of the wallet account that paid
 * instead of the profile's chat key. Such a name resolves, but a contact request
 * sent to it goes to a key no client holds — the sender sees no error. This
 * writes the correct key into the resolver record: gas only, no deposit, and the
 * name is not re-registered.
 *
 * Not offered in the interface: the bug is ours, and the fix belongs in
 * registration, not in a repair button every user has to find.
 */
export async function updatePublicKey(password?: string): Promise<boolean> {
  if (!statusState.backendRunning) {
    ensState.error = 'Wallet is not ready';
    return false;
  }
  const address = await ensureWalletAddress();
  if (!address) {
    ensState.error = 'Wallet is not ready';
    return false;
  }

  const secret = password ?? sendState.password;
  if (!secret) {
    sendState.needsPassword = true;
    return false;
  }

  ensState.isSending = true;
  ensState.error = '';
  info(`[ens] rewriting the chat key for ${ensState.username.trim()} from ${address}`);
  try {
    const result = await invoke<{ tx_hash: string; full_name: string }>('update_ens_public_key', {
      request: {
        // snake_case inside `request`: serde reads `EnsUpdateKeyRequest`, and
        // Tauri's camelCase conversion covers only command arguments.
        chain_id: statusState.chainId,
        from: walletState.address,
        username: ensState.username.trim(),
        password: secret,
      },
    });

    ensState.txHash = result?.tx_hash ?? '';
    ensState.fullName = result?.full_name ?? '';
    ensState.linked = true;
    ensState.step = 'done';
    info(`[ens] chat key rewritten for ${ensState.fullName} in ${ensState.txHash}`);
    return true;
  } catch (e) {
    const message = formatError(e, 'Failed to update the chat key');
    if (/incorrect password|decrypt|authentication/i.test(message)) {
      sendState.password = '';
      sendState.needsPassword = true;
    }
    ensState.error = message;
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

/**
 * Records a name this wallet already owns in the current profile.
 *
 * @returns `true` when the name was attached.
 * @remarks
 * Registration happens on chain, the profile keeps its own list. A profile restored
 * from its seed phrase starts with an empty list, so a name it owns is invisible to the
 * interface — and re-registering it is impossible: the contract says the name is taken,
 * by the user's own address. This is the missing half: take the name from the contract
 * (already verified as owned by this wallet) and write it into the profile.
 *
 * No transaction is involved, so there is no password and no deposit.
 */
export async function attachExistingName(): Promise<boolean> {
  if (!statusState.backendRunning) {
    ensState.error = 'Wallet is not ready';
    return false;
  }
  const name = ensState.username.trim();
  if (!name || usernameError(name)) return false;

  const full = fullEnsName(name);
  ensState.isSending = true;
  ensState.error = '';
  try {
    await addEnsUsername(statusState.chainId, full);
    await loadProfileNames();
    ensState.fullName = full;
    ensState.txHash = '';
    ensState.linked = true;
    ensState.step = 'done';
    info(`[ens] attached existing name ${full}`);
    return true;
  } catch (e) {
    ensState.error = formatError(e, 'Failed to attach the name');
    warn('[ens] attach failed:', e);
    return false;
  } finally {
    ensState.isSending = false;
  }
}
