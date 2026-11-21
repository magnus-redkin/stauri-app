/**
 * PIN storage for a profile: the user's PIN, and the password it protects.
 *
 * The PIN never leaves the device unencrypted and is never stored: Argon2id derives a
 * key from it, and that key decrypts the generated profile password
 * (`src-tauri/src/credentials.rs`). This module only moves values across the boundary.
 *
 * @remarks
 * Nothing here is written to `localStorage`: a PIN in webview storage would be readable
 * by any script in the page. The Rust side keeps the envelope in the application's
 * private directory.
 */

import { invoke } from '@tauri-apps/api/core';
import { debug } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';
import { isAndroid } from '$lib/utils/platform';

/*
 * The PIN's shape is platform policy and is read from the backend (`pinRules`), not
 * duplicated here: five digits on the phone, eight characters with four classes on the
 * desktop. A constant in this file would be a second source of truth that can drift.
 */

/** Rules reported by the backend, so the interface does not invent its own. */
export interface PinRules {
  /** Opening accepts any non-empty PIN up to this length. */
  max_length: number;
  max_attempts: number;
  /** The creation policy: the shortest PIN that will be stored. */
  creation_min: number;
  /** Creation on the phone: digits only, which is all its keypad can type. */
  digits_only: boolean;
  /** Creation on the desktop: lowercase, uppercase, digits and a symbol. */
  require_classes: boolean;
}

/**
 * Whether this build can keep a PIN.
 *
 * A release desktop build answers `false`: it has no backend for this yet, and the
 * password prompt stays as it is.
 */
export async function credentialsAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>('credential_available');
  } catch (e) {
    debug(`[credentials] availability check failed: ${formatError(e)}`);
    return false;
  }
}

/**
 * Reads the PIN rules the backend enforces.
 *
 * @returns The rules, or this platform's defaults when the command is unavailable.
 */
export async function pinRules(): Promise<PinRules> {
  try {
    return await invoke<PinRules>('credential_pin_rules');
  } catch {
    // The fallback mirrors the Rust policy per platform, so a failed call degrades to
    // the right shape rather than to the phone's rules on a desktop.
    return isAndroid()
      ? { max_length: 12, max_attempts: 10, creation_min: 5, digits_only: true, require_classes: false }
      : { max_length: 64, max_attempts: 10, creation_min: 8, digits_only: false, require_classes: true };
  }
}

/** Characters used for a generated password, see {@link generatePassword}. */
const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '!#%*+-=?@^_';

/**
 * Length of a generated password, in characters.
 *
 * 32 characters over a 73-symbol alphabet is about 195 bits. The rule of `password.ts`
 * asks for 8 characters because a human has to remember them; a generated password is not
 * limited by that.
 */
export const GENERATED_PASSWORD_LENGTH = 32;

/**
 * Generates a password that satisfies the product rules.
 *
 * @returns A random password of {@link GENERATED_PASSWORD_LENGTH} characters.
 * @remarks
 * One character of each class is placed first and the rest are drawn from the full
 * alphabet, then the whole string is shuffled. Without that, a 32-character string could
 * by chance lack a digit and be refused by `checkPassword` on the way to status-go — a
 * failure the user could do nothing about, because the password is never shown.
 *
 * Visually ambiguous characters (`I`, `l`, `O`, `0`, `1`) are left out.
 */
export function generatePassword(): string {
  const all = UPPER + LOWER + DIGITS + SYMBOLS;
  const pick = (alphabet: string): string => alphabet[pickIndex(alphabet.length)];

  const required = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  const rest: string[] = [];
  for (let i = required.length; i < GENERATED_PASSWORD_LENGTH; i++) rest.push(pick(all));

  // Fisher–Yates, so the guaranteed characters are not always the first four.
  const chars = [...required, ...rest];
  for (let i = chars.length - 1; i > 0; i--) {
    const j = pickIndex(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Uniform index in `[0, size)`.
 *
 * @remarks
 * `crypto.getRandomValues` is the only acceptable source: `Math.random` is not
 * cryptographic and the password is the whole protection of the database. The rejection
 * loop removes the modulo bias that would otherwise make the first characters of the
 * alphabet slightly more likely.
 */
function pickIndex(size: number): number {
  const limit = Math.floor(0x100000000 / size) * size;
  const buffer = new Uint32Array(1);
  let value = 0;
  do {
    crypto.getRandomValues(buffer);
    value = buffer[0];
  } while (value >= limit);
  return value % size;
}

/**
 * Stores the profile password encrypted under `pin`.
 *
 * @param network - `mainnet` or `testnet`; profiles of the two never share a slot.
 * @param keyUid - The profile's key uid.
 * @param pin - The user's PIN, digits only.
 * @param password - Password that opens the local database.
 * @remarks
 * Takes about a third of a second: Argon2id is deliberately expensive. The caller shows
 * its busy state for that time.
 */
export async function savePin(
  network: string,
  keyUid: string,
  pin: string,
  password: string
): Promise<void> {
  await invoke('credential_save_pin', { network, keyUid, pin, password });
  debug(`[credentials] pin stored network=${network} key=${keyUid.slice(0, 10)}`);
}

/**
 * Returns the profile password unlocked by `pin`.
 *
 * @param network - Network of the profile.
 * @param keyUid - The profile's key uid.
 * @param pin - Digits entered by the user.
 * @throws When the PIN is wrong, the attempt limit is reached, or no PIN is set.
 *   The message is meant for the user and says how many attempts are left.
 */
export async function openPin(
  network: string,
  keyUid: string,
  pin: string
): Promise<string> {
  return await invoke<string>('credential_open_pin', { network, keyUid, pin });
}

/** Whether a PIN is set for this profile. */
export async function hasPin(network: string, keyUid: string): Promise<boolean> {
  try {
    return await invoke<boolean>('credential_has_pin', { network, keyUid });
  } catch {
    return false;
  }
}

/**
 * What the entry flow should show for this profile.
 *
 * @param network - `mainnet` or `testnet`.
 * @param keyUid - The profile's key uid.
 * @returns `missing` (no PIN yet), `ready`, `locked-out` or `damaged`.
 * @remarks
 * The attempt count is part of the answer: a profile past the limit goes straight to the
 * seed phrase instead of a keypad that cannot succeed. `damaged` means an envelope exists
 * but cannot be read — the password behind it is generated, so the password prompt would
 * be a door nobody can open, and the caller sends the user to the phrase as well.
 */
export async function pinState(network: string, keyUid: string): Promise<PinState> {
  try {
    return await invoke<PinState>('credential_pin_state', { network, keyUid });
  } catch (e) {
    // A build without the command cannot store PINs at all, which the caller already
    // knows from `credentialsAvailable`. Reporting `missing` keeps the password path.
    debug(`[credentials] state lookup failed: ${formatError(e)}`);
    return 'missing';
  }
}

/** Answer of {@link pinState}, mirroring the Rust side. */
export type PinState = 'missing' | 'ready' | 'locked-out' | 'damaged';

/**
 * Stores the password of a paired profile under a PIN.
 *
 * @param network - `mainnet` or `testnet`.
 * @param keyUid - The profile that arrived over pairing.
 * @param pin - The user's PIN, digits only.
 * @remarks
 * The password is not a parameter: it arrived with the transfer and waits in the Rust
 * side. This is the only call that can wrap it, and it drops it afterwards.
 */
export async function savePinFromPending(
  network: string,
  keyUid: string,
  pin: string
): Promise<void> {
  await invoke('credential_save_pin_from_pending', { network, keyUid, pin });
  debug(`[credentials] paired password stored network=${network} key=${keyUid.slice(0, 10)}`);
}

/**
 * Forgets a paired password that was not wrapped under a PIN.
 *
 * @param network - `mainnet` or `testnet`.
 * @param keyUid - The profile that arrived over pairing.
 * @returns `true` when there was something to forget.
 * @remarks
 * Called when the user leaves the PIN screen after a transfer: the profile stays, but
 * without its password it cannot be opened, and the seed phrase is the way back.
 */
export async function forgetPendingPin(network: string, keyUid: string): Promise<boolean> {
  try {
    return await invoke<boolean>('credential_forget_pending', { network, keyUid });
  } catch {
    return false;
  }
}

/**
 * Removes the PIN and the stored password of a profile.
 *
 * @remarks
 * Called when the profile is removed from this device, so a later restore of the same
 * profile does not inherit a PIN that belonged to a database that no longer exists.
 */
export async function deleteCredential(network: string, keyUid: string): Promise<void> {
  await invoke('credential_delete', { network, keyUid });
}
