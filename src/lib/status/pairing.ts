/**
 * Local pairing: copying a profile between devices on the same network.
 *
 * This module only moves values across the boundary; discovery, the handshake and the
 * transfer itself live in Rust (`src-tauri/src/lanpair.rs` and `pairing.rs`).
 *
 * @remarks
 * Three facts shape this API:
 *
 * * the device that **has** the profile is the sender, the empty one is the receiver —
 *   the role follows from whether the device is logged in;
 * * the connection string is a secret (it carries the transfer's AES key), so it never
 *   reaches a screen: it travels inside an encrypted session the two devices establish
 *   themselves, and only after both people compared six digits;
 * * the transfer carries the sender's **password**, so the receiver ends up with a
 *   32-character string nobody typed and has to wrap it under its own PIN.
 *
 * The screens poll {@link lanStatus}: a transfer is one long operation on the Rust side,
 * and polling a small value is simpler and more robust than a stream of events that has
 * to be kept in step with the lifecycle of a screen.
 */

import { invoke } from '@tauri-apps/api/core';
import { debug } from '$lib/utils/log';

/** Role a device takes in a transfer. */
export type PairingRole = 'sender' | 'receiver';

/** Where an attempt is. */
export type LanPhase = 'idle' | 'waiting' | 'codes' | 'transferring' | 'done' | 'failed';

/** State of the attempt as the Rust side reports it. */
export interface LanStatus {
  /** `idle` before anything starts, `failed` when it stopped with a reason. */
  phase: LanPhase;
  /** Six digits both screens compare, once the handshake is done. */
  digits?: string | null;
  /** Why the attempt stopped, when it did. */
  error?: string | null;
  /** Key uid of the profile that arrived, on the receiving side. */
  key_uid?: string | null;
  /** Its display name, when the sender had one. */
  name?: string | null;
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
    debug(`[pairing] availability check failed: ${e}`);
    return false;
  }
}

/**
 * Starts this device as the receiver and begins announcing itself on the network.
 *
 * @param dataDir - Root data directory of the selected network.
 * @param network - `mainnet` or `testnet`; the received password is filed under it.
 * @returns The initial status, `waiting`.
 * @remarks
 * Returns immediately: the search runs in the background and the screen polls
 * {@link lanStatus}. The receiving side has no secret to show, so it can start before
 * the other device exists at all.
 */
export async function lanReceiveStart(dataDir: string, network: string): Promise<LanStatus> {
  const status = await invoke<LanStatus>('pairing_lan_receive_start', { dataDir, network });
  debug(`[pairing] receiver waiting`);
  return status;
}

/**
 * Starts this device as the sender and searches for the other one.
 *
 * @param dataDir - Root data directory of the selected network.
 * @param keyUid - Profile being sent.
 * @param password - Its password; status-go needs it to read the keys.
 * @param deviceType - `android`, `linux`, … as status-go records it.
 * @param syncMessages - Whether the message history travels with the profile.
 * @returns The initial status, `waiting`.
 * @remarks
 * History is on only when the caller says so. status-go transfers the whole message
 * database with no date window, and calls it a privacy decision in its own source; the
 * flag is read when its server starts, which happens after both sides press Sync.
 */
export async function lanSendStart(
  dataDir: string,
  keyUid: string,
  password: string,
  deviceType: string,
  syncMessages: boolean,
  address?: string
): Promise<LanStatus> {
  const status = await invoke<LanStatus>('pairing_lan_send_start', {
    dataDir,
    keyUid,
    password,
    deviceType,
    syncMessages,
    address: address?.trim() || null,
  });
  debug(`[pairing] sender searching, history ${syncMessages}`);
  return status;
}

/**
 * Address of this device on the local network.
 *
 * @returns The IPv4 address, or `null` when the device has no network.
 * @remarks
 * Shown on the waiting screen of the receiving device. Typing it on the other one turns
 * the search into a direct probe, which is the way through a router that drops broadcast
 * but lets unicast past.
 */
export async function lanLocalAddress(): Promise<string | null> {
  try {
    return await invoke<string | null>('pairing_lan_local_address');
  } catch {
    return null;
  }
}

/**
 * Presses Sync after the digits matched on both screens.
 *
 * @returns The status as it is now.
 * @remarks
 * Pressing early is safe: the press is remembered, and the exchange waits for the other
 * side. The transfer starts when both have pressed, so consent comes from two devices.
 */
export async function lanConfirm(): Promise<LanStatus> {
  return await invoke<LanStatus>('pairing_lan_confirm');
}

/**
 * Stops the attempt.
 *
 * @returns The idle status.
 * @remarks
 * Called when the user leaves the screen. A transfer already under way is not interrupted
 * cleanly — status-go has no export for stopping its server — but the screen stops
 * polling and the attempt is forgotten.
 */
export async function lanCancel(): Promise<LanStatus> {
  return await invoke<LanStatus>('pairing_lan_cancel');
}

/**
 * Reads the current state of the transfer.
 *
 * @returns The status, `idle` when nothing is running.
 */
export async function lanStatus(): Promise<LanStatus> {
  return await invoke<LanStatus>('pairing_lan_status');
}
