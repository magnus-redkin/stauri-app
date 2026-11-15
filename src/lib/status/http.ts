import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { invoke } from '@tauri-apps/api/core';
import { debug, error } from '$lib/utils/log';
import { statusState } from '$lib/stores/statusStore.svelte';

/**
 * status-go RPC client.
 *
 * Request and response bodies are NEVER logged: `settings_getSettings` returns
 * the seed phrase in the `mnemonic` field, so any body logging writes it to the
 * webview console. What is logged: the method name, the duration and, on
 * failure, the status code and the error text. Error text carries no profile
 * data, because status-go puts it in a separate `error` field.
 *
 * @remarks
 * `port` is the port of the AUTHENTICATING PROXY, not of the backend. The proxy
 * requires a token header and forwards the request only after checking it.
 */

/** Proxy token, cached for the lifetime of the page. */
let authToken: string | null = null;

async function token(): Promise<string> {
  if (authToken) return authToken;
  authToken = await invoke<string>('auth_proxy_token');
  return authToken;
}

/** Extracts the RPC method name from a request body, for logging. */
function methodOf(body: any): string {
  if (body && typeof body === 'object' && typeof body.method === 'string') {
    return body.method;
  }
  return 'direct';
}

export async function statusFetch<T>(port: number, endpoint: string, body: any): Promise<T> {
  const url = `http://127.0.0.1:${port}/statusgo/${endpoint}`;
  const method = methodOf(body);
  const label = `${endpoint}/${method}`;
  const started = performance.now();
  // Android has no HTTP server; requests go through the libstatus.so bridge.
  if (isAndroid()) {
    const started = performance.now();
    debug(`[statusFetch] → ${label} (bridge)`);
    const text = await invoke<string>('status_call', {
      endpoint,
      body: JSON.stringify(body),
    });
    statusState.probe = `[bridge] ${label}: ${text.slice(0, 120)}`;
    debug(`[statusFetch] ← ${label} ok ${Math.round(performance.now() - started)}ms (bridge)`);
    return parseBody<T>(text, label, endpoint);
  }


  debug(`[statusFetch] → ${label}`);

  const response = await tauriFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Stauri-Token': await token(),
    },
    body: JSON.stringify(body)
  });

  const ms = Math.round(performance.now() - started);

  // Check the HTTP status first. The body is neither logged nor included in the
  // error text: it may carry profile data. Only the status and its length stay.
  if (!response.ok) {
    const errorText = await response.text();
    error(`[statusFetch] ← ${label} HTTP ${response.status} ${ms}ms len=${errorText.length}`);
    throw new Error(`HTTP ${response.status}`);
  }

  const text = await response.text();
  debug(`[statusFetch] ← ${label} ok ${ms}ms len=${text.length}`);

  return parseBody<T>(text, label, endpoint);
}


/** Parses a status-go response: empty body, JSON, and JSON-RPC errors. */
function parseBody<T>(text: string, label: string, endpoint: string): T {
  // An empty body is a normal answer, for example from LoginAccount.
  if (!text || text.trim() === '') {
    return {} as T;
  }

  // Parse the JSON.
  let data: any;
  try {
    data = JSON.parse(text);
  } catch (e) {
    error(`[statusFetch] ← ${label} invalid JSON`);
    throw new Error(`Invalid JSON response from ${endpoint}`, { cause: e });
  }

  // Handle errors from both JSON-RPC and the plain API in one place.
  if (data && data.error) {
    let errorMessage: string;

    if (typeof data.error === 'string') {
      errorMessage = data.error;
    } else if (typeof data.error === 'object' && data.error.message) {
      errorMessage = data.error.message;
    } else {
      errorMessage = JSON.stringify(data.error);
    }

    // Log the full error text: it names the backend's reason for refusing, and
    // without it the failure cannot be diagnosed. It holds no profile data —
    // that lives in `result`.
    error(`[statusFetch] ← ${label} error: ${errorMessage}`);
    throw new Error(errorMessage);
  }

  return data as T;
}

/** On Android there is no backend HTTP server, so requests go through a bridge. */
function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}
