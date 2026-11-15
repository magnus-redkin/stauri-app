/**
 * Frontend logging.
 *
 * ## Where messages go
 *
 * Logging from the webview alone is useless: a release bundle drops
 * `console.*`, and the user never sees the window's stdout. Messages are sent
 * to Rust through the `log_frontend` command, and `logging.rs` writes them to
 * the same file as backend messages:
 *
 *   ~/.local/share/com.magnus.stauri-app/logs/stauri.<date>.log
 *
 * Secret redaction is done by `RedactingWriter` on the Rust side — one place
 * rather than every call site here.
 *
 * ## Enabling
 *
 * Logging is on by default and can only be turned off with a
 * `VITE_DEBUG_LOG=0` build. Opt-in logging leaves a release log with only Rust
 * messages and no RPC calls, which makes a scenario impossible to trace.
 */

import { invoke } from '@tauri-apps/api/core';

type Level = 'debug' | 'info' | 'warn' | 'error';

const isDev = import.meta.env.DEV;
// On by default; disabled only by an explicit VITE_DEBUG_LOG=0.
const enabled = import.meta.env.VITE_DEBUG_LOG !== '0';

/**
 * Cap on the size of a single message.
 *
 * Rust truncates at 4096 characters, but the extra IPC traffic is pointless.
 */
const MAX_LEN = 4000;

/** Turns any value into a string without throwing on cyclic structures. */
function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) {
    return value.stack ? `${value.message}\n${value.stack}` : value.message;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function send(level: Level, args: unknown[]) {
  const message = args.map(stringify).join(' ');
  const trimmed = message.length > MAX_LEN ? `${message.slice(0, MAX_LEN)}…` : message;

  // In dev, mirror to the console so the log file is not needed.
  if (isDev) {
    // eslint-disable-next-line no-console -- this module exists for exactly this
    (console[level] ?? console.log)(trimmed);
  }

  if (!enabled) return;

  // The promise is not awaited: logging must not hold up the caller.
  // The error is swallowed — a missing IPC channel must not crash the app.
  //
  // `?.catch` is required: tests mock `invoke` with a plain function, and
  // calling `.catch` on `undefined` would throw in the caller.
  try {
    invoke('log_frontend', { level, message: trimmed })?.catch(() => {});
  } catch {
    // A synchronous throw from invoke (a test environment, for instance) must
    // not affect the application either.
  }
}

export const debug = (...args: unknown[]) => send('debug', args);
export const info = (...args: unknown[]) => send('info', args);
export const warn = (...args: unknown[]) => send('warn', args);
export const error = (...args: unknown[]) => send('error', args);

/**
 * Logs the entry into and the outcome of an RPC call.
 *
 * Only the method name, the response size and whether it failed are logged:
 * request and response bodies stay out of the log because
 * `settings_getSettings` returns the seed phrase in its `mnemonic` field.
 *
 * @param method - RPC method name, used as the log label.
 * @param fn - The call to run.
 * @returns Whatever `fn` resolves to.
 * @throws Whatever `fn` throws; the error is logged first.
 * @remarks Wrapping the call here keeps `try/finally` out of every call site.
 */
export async function traceRpc<T>(method: string, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  debug(`[rpc] → ${method}`);
  try {
    const result = await fn();
    const ms = Math.round(performance.now() - started);
    const size = typeof result === 'object' && result !== null
      ? JSON.stringify(result).length
      : String(result ?? '').length;
    debug(`[rpc] ← ${method} ok ${ms}ms ${size}b`);
    return result;
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    error(`[rpc] ← ${method} FAILED ${ms}ms: ${stringify(e)}`);
    throw e;
  }
}
