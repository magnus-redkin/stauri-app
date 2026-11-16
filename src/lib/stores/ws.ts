/**
 * status-go signal subscription.
 *
 * The backend lives inside this process, so there is no `/signals` socket:
 * Rust registers a C callback with status-go and forwards every signal to the
 * webview as the `status-signal` Tauri event. What remains here is the shape the
 * rest of the app expects (`openWs`/`closeWs`/`isWsOpen`), so call sites did not
 * have to change.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import { processSignal } from './statusStore.svelte';

let unlisten: UnlistenFn | null = null;

/** Whether the signal subscription is active. */
export function isWsOpen(): boolean {
  return unlisten !== null;
}

/**
 * Starts listening for status-go signals.
 *
 * Idempotent: a second call replaces the listener rather than doubling it.
 *
 * @param _port - Retained for call-site compatibility; no transport exists.
 */
export async function openWs(): Promise<void> {
  await closeWs();
  unlisten = await listen<any>('status-signal', (event) => {
    if (event.payload) processSignal(JSON.stringify(event.payload));
  });
}

/** Stops listening. Safe to call repeatedly. */
export async function closeWs(): Promise<void> {
  if (!unlisten) return;
  unlisten();
  unlisten = null;
}
