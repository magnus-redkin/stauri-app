/**
 * WebSocket to the backend `/signals` endpoint.
 *
 * The connection carries no reactive application state — it is a resource to
 * open, reuse and close — so the socket handle stays private and only the
 * operations are exported.
 */

import { processSignal } from './statusStore.svelte';
import { getAuthToken } from '$lib/status/api';
import WebSocket from '@tauri-apps/plugin-websocket';

let ws: WebSocket | null = null;

/** Whether the socket is currently open. */
export function isWsOpen(): boolean {
  return ws !== null;
}

/**
 * Connects the WebSocket, closing any previous one first.
 *
 * The token travels in a header: a plain browser WebSocket cannot set headers,
 * but the Tauri plugin accepts `ConnectionConfig.headers`. The proxy checks the
 * token before the upgrade. `port` is the authenticating proxy port, not the
 * backend port.
 *
 * @param port - Port of the authenticating proxy that fronts the backend.
 */
export async function openWs(port: number): Promise<void> {
  // Android has no `/signals` socket (the backend is a library, see B.2).
  // Signals are not bridged yet: login and requests go through
  // statusFetch → status_call.
  if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) {
    return;
  }
  await closeWs();

  const socket = await WebSocket.connect(`ws://127.0.0.1:${port}/signals`, {
    headers: { 'X-Stauri-Token': await getAuthToken() },
  });
  socket.addListener((msg) => {
    // msg.data arrives as string | number[] | CloseFrame | null
    if (typeof msg.data === 'string') processSignal(msg.data);
  });
  ws = socket;
}

/** Closes the socket if it is open. Safe to call repeatedly. */
export async function closeWs(): Promise<void> {
  if (!ws) return;
  try {
    await ws.disconnect();
  } catch {
    /* a failed close is not critical: the next connect opens a new socket */
  }
  ws = null;
}
