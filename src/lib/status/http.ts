import { invoke } from '@tauri-apps/api/core';
import { debug, error } from '$lib/utils/log';
import { statusState } from '$lib/stores/statusStore.svelte';

/**
 * status-go RPC client.
 *
 * status-go runs inside this process, so a call is a Tauri command rather than an
 * HTTP request: there is no port, no proxy and no token. `status_rpc` moves the
 * blocking C call to a worker thread in Rust.
 *
 * Request and response bodies are NEVER logged: `settings_getSettings` returns
 * the seed phrase in the `mnemonic` field, so any body logging writes it to the
 * webview console. What is logged: the method name, the duration and, on
 * failure, the error text. Error text carries no profile data, because status-go
 * puts it in a separate `error` field.
 */

/**
 * Parses a status-go response: empty body, JSON, and JSON-RPC errors.
 *
 * The Rust side already unwraps the JSON-RPC envelope for `status_rpc`, so this
 * only has to reject a shape it does not recognise.
 */
function parseResult<T>(value: any, label: string): T {
  if (value === null || value === undefined) {
    return {} as T;
  }
  if (value && typeof value === 'object' && 'error' in value && value.error) {
    const err = (value as any).error;
    const message =
      typeof err === 'string' ? err : (err.message ?? JSON.stringify(err));
    error(`[statusFetch] ← ${label} error: ${message}`);
    throw new Error(message);
  }
  return value as T;
}

/** RPC method name from a request body, for logging. */
function methodOf(body: any): string {
  if (body && typeof body === 'object' && typeof body.method === 'string') {
    return body.method;
  }
  return 'direct';
}

/**
 * Calls a lifecycle endpoint by name.
 *
 * `InitializeApplication`, `LoginAccount`, `CreateAccountAndLogin` and `Logout`
 * return their whole body rather than a JSON-RPC `result`, so they go through
 * `status_call` instead of `status_rpc`.
 *
 * @param endpoint - status-go export name, e.g. `LoginAccount`.
 * @param body - Request object, serialised before the call.
 * @returns The parsed reply.
 */
export async function statusCall<T>(endpoint: string, body: any): Promise<T> {
  const started = performance.now();
  debug(`[statusCall] → ${endpoint}`);
  const text = await invoke<string>('status_call', {
    endpoint,
    body: JSON.stringify(body),
  });
  debug(`[statusCall] ← ${endpoint} ok ${Math.round(performance.now() - started)}ms`);
  if (!text || text.trim() === '') return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    error(`[statusCall] ← ${endpoint} invalid JSON`);
    throw new Error(`Invalid JSON response from ${endpoint}`, { cause: e });
  }
}

/**
 * One JSON-RPC call to status-go.
 *
 * `statusFetch` keeps the shape callers already use: an endpoint plus a JSON-RPC
 * body. In practice the endpoint is always `CallRPC`.
 *
 * @param endpoint - `CallRPC` for JSON-RPC, otherwise a lifecycle endpoint.
 * @param body - JSON-RPC request.
 * @returns The reply in the shape callers already use: `{ result }` for
 * `CallRPC`, the whole body for a lifecycle endpoint.
 *
 * @remarks
 * Rust unwraps the JSON-RPC envelope and returns the bare `result`, while every
 * caller reads `res.result` (and `res.error` before it). The envelope is rebuilt
 * here, in one place, rather than at 26 call sites.
 */
export async function statusFetch<T>(endpoint: string, body: any): Promise<T> {
  const method = methodOf(body);
  const label = `${endpoint}/${method}`;

  if (endpoint !== 'CallRPC') {
    // Lifecycle endpoints answer with their whole body, not a `result`.
    return (await statusCall<T>(endpoint, body)) as T;
  }

  const started = performance.now();
  debug(`[statusFetch] → ${label}`);
  try {
    const result = await invoke<any>('status_rpc', {
      method,
      params: body?.params ?? [],
    });
    debug(`[statusFetch] ← ${label} ok ${Math.round(performance.now() - started)}ms`);
    if (result === null || result === undefined) {
      // Callers read `res.result` without a null check (`res.result || []`), so
      // a null reply becomes a null field rather than a null envelope.
      return { result: null } as T;
    }
    const value = parseResult<any>(result, label);
    // `parseResult` already rejected an error body; what is left is the result.
    return { result: value?.result ?? value } as T;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    error(`[statusFetch] ← ${label} error: ${message}`);
    throw e instanceof Error ? e : new Error(message);
  }
}

