/**
 * Normalizes errors coming back from Tauri commands.
 *
 * Commands return `AppError` (see src-tauri/src/error.rs), serialized as an
 * object:
 *
 *   { "kind": "backend", "message": "backend is not running" }
 *
 * This is the single place that turns such a payload, a plain `Error`, a
 * string, or anything else into display text, so no call site falls back to
 * `e?.message || e` and shows `[object Object]` for an object without a
 * `message` field.
 */

/** Error category. Mirrors `ErrorKind` on the Rust side. */
export type ErrorKind = 'backend' | 'config' | 'io' | 'network' | 'internal';

/** A Tauri command error after serialization. */
export interface AppErrorPayload {
  kind: ErrorKind;
  message: string;
}

function isAppError(value: unknown): value is AppErrorPayload {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    'message' in value &&
    typeof (value as AppErrorPayload).message === 'string'
  );
}

/**
 * Extracts human-readable text from any thrown value.
 *
 * An `AppError` contributes its `message`, an `Error` its `message`, and
 * anything else goes through `String()`.
 *
 * @param e - Whatever was caught.
 * @param fallback - Text returned when nothing usable is found.
 * @returns Display text that is never `[object Object]`.
 */
export function formatError(e: unknown, fallback = 'Произошла неизвестная ошибка'): string {
  if (isAppError(e)) {
    return e.message;
  }
  if (e instanceof Error) {
    return e.message || fallback;
  }
  if (typeof e === 'string' && e.trim() !== '') {
    return e;
  }
  return fallback;
}

/**
 * Returns the error category when one can be determined.
 *
 * Needed where behavior depends on the cause: "backend is not running" is
 * handled differently from "network unreachable".
 *
 * @param e - Whatever was caught.
 * @returns The category, or `null` for a value that is not an `AppError`.
 */
export function errorKind(e: unknown): ErrorKind | null {
  return isAppError(e) ? e.kind : null;
}

/**
 * Builds a short log tag such as `[backend]`.
 *
 * @param e - Whatever was caught.
 * @returns The tag with a trailing space, or an empty string when the category
 * is unknown.
 */
export function errorTag(e: unknown): string {
  const kind = errorKind(e);
  return kind ? `[${kind}] ` : '';
}
