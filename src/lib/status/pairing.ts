/**
 * Local pairing: copying a profile between devices over the local network.
 *
 * This module only moves values across the boundary; the transfer itself is status-go's
 * (`src-tauri/src/pairing.rs`).
 *
 * @remarks
 * Three facts shape this API, and all three come from the status-go source rather than
 * from intuition:
 *
 * * the device that **has** the profile is the sender, the empty one is the receiver —
 *   the role follows from whether the device is logged in, not from who starts;
 * * the transfer carries the sender's **password**, so the receiver ends up with a
 *   32-character string nobody typed and has to wrap it under its own PIN;
 * * the string is the only channel. There is no discovery on Android — status-go
 *   disables the LAN beacon there outright — so one device always shows a string and
 *   the other reads it.
 */

import { invoke } from '@tauri-apps/api/core';
import { debug } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';

/** Role a device takes in a transfer. */
export type PairingRole = 'sender' | 'receiver';

/** A connection string produced on this device. */
export interface ConnectionString {
  /** The string to show. Several hundred characters; it cannot be typed. */
  value: string;
  /** Role this device took. */
  role: PairingRole;
  /**
   * Six digits both devices compare before the transfer starts.
   *
   * Derived from the key inside the string, so a string swapped on its way across yields
   * different digits. It does not protect against someone who saw the whole string —
   * the five-minute lifetime is what limits that.
   */
  confirmation_code: string;
}

/** A profile that arrived from another device. */
export interface PairedAccount {
  key_uid: string;
  name?: string;
}

/**
 * Whether this build can pair at all.
 *
 * @returns `false` on a library built without the local-pairing exports, in which case
 *   the screens hide the option instead of offering a button that cannot work.
 */
export async function pairingAvailable(): Promise<boolean> {
  try {
    return await invoke<boolean>('pairing_available');
  } catch (e) {
    debug(`[pairing] availability check failed: ${formatError(e)}`);
    return false;
  }
}

/**
 * Checks a connection string before a transfer starts.
 *
 * @param value - String pasted or scanned by the user.
 * @returns `true` when status-go accepts it.
 * @remarks
 * Cheap and local: it parses the string and verifies its fields, so a mistyped paste is
 * reported as such instead of failing after a network timeout.
 */
export async function validateConnectionString(value: string): Promise<boolean> {
  if (!value.trim()) return false;
  try {
    return await invoke<boolean>('pairing_validate', { connectionString: value.trim() });
  } catch {
    return false;
  }
}

/**
 * Starts this device as the sender.
 *
 * @param dataDir - Root data directory of the selected network.
 * @param keyUid - Profile being sent.
 * @param password - Its password; status-go needs it to read the keys.
 * @param deviceType - `android`, `linux`, … as status-go records it.
 * @param syncMessages - Whether the message history travels with the profile.
 * @returns The connection string to show on this device, and the code to compare.
 * @remarks
 * History is off unless the caller says otherwise: status-go transfers the whole message
 * database with no date window, and calls it a privacy decision in its own source.
 */
export async function startSending(
  dataDir: string,
  keyUid: string,
  password: string,
  deviceType: string,
  syncMessages = false
): Promise<ConnectionString> {
  const result = await invoke<ConnectionString>('pairing_start_sending', {
    dataDir,
    keyUid,
    password,
    deviceType,
    syncMessages,
  });
  debug(`[pairing] sender started, string length ${result.value.length}, history ${syncMessages}`);
  return result;
}

/**
 * Starts this device as the receiver.
 *
 * @param dataDir - Root data directory of the selected network.
 * @returns The connection string to show on this device.
 */
export async function startReceiving(dataDir: string): Promise<ConnectionString> {
  const result = await invoke<ConnectionString>('pairing_start_receiving', { dataDir });
  debug(`[pairing] receiver started, string length ${result.value.length}`);
  return result;
}

/**
 * Six digits the receiving device compares against the sender's screen.
 *
 * @param value - Connection string the user pasted.
 * @returns The digits, or `''` when the string is not in the documented shape.
 * @remarks
 * Computed in Rust, not here: both devices must run the same code over the same bytes,
 * and a second implementation in JavaScript would be a second thing to keep right.
 */
export async function confirmationCode(value: string): Promise<string> {
  if (!value.trim()) return '';
  try {
    return await invoke<string>('pairing_confirmation_code', {
      connectionString: value.trim(),
    });
  } catch (e) {
    debug(`[pairing] confirmation code failed: ${formatError(e)}`);
    return '';
  }
}

/**
 * Receives a profile from the other device.
 *
 * @param dataDir - Root data directory of the selected network.
 * @param connectionString - String shown by the sender.
 * @param network - `mainnet` or `testnet`; the received password is filed under it.
 * @returns The profile that arrived: key uid and name.
 * @throws When the string is refused, the transfer fails, or nothing arrives in time.
 * @remarks
 * The password that came with the profile is not in the answer. It waits on the Rust side
 * until `savePinFromPending` wraps it under the PIN the user picks, so it never sits in
 * webview state.
 */
export async function receiveAccount(
  dataDir: string,
  connectionString: string,
  network: string
): Promise<PairedAccount> {
  return await invoke<PairedAccount>('pairing_receive', {
    dataDir,
    connectionString: connectionString.trim(),
    network,
  });
}

/**
 * Sends this device's profile to the other one.
 *
 * @param dataDir - Root data directory of the selected network.
 * @param connectionString - String shown by the receiver.
 * @param keyUid - Profile being sent.
 * @param password - Its password.
 * @param deviceType - `android`, `linux`, … as status-go records it.
 * @throws When the string is refused or the transfer fails.
 */
export async function sendAccount(
  dataDir: string,
  connectionString: string,
  keyUid: string,
  password: string,
  deviceType: string
): Promise<void> {
  await invoke('pairing_send', {
    dataDir,
    connectionString: connectionString.trim(),
    keyUid,
    password,
    deviceType,
  });
}
