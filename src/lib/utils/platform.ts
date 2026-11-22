/**
 * Which platform the interface is running on.
 *
 * @remarks
 * The desktop layout switches on window width (`matchMedia`), and that is not enough
 * to pick an entry flow: a narrow desktop window would get the phone flow, which
 * generates a password the desktop cannot store and hides the password prompt the
 * user needs. The entry flow is therefore chosen by the *platform*, not by the width.
 *
 * Android is identified by the WebView's user agent, which always carries `Android`.
 * The Tauri runtime check keeps the phone flow from appearing in a plain browser
 * during development.
 */

/** Whether the Tauri runtime is present (as opposed to a plain browser). */
export function isTauri(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Whether this is the Android build.
 *
 * @returns `true` inside the Android WebView.
 */
export function isAndroid(): boolean {
  if (!isTauri()) return false;
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/**
 * Whether this build runs on a phone or tablet.
 *
 * @returns `true` inside the Android or iOS WebView.
 * @remarks
 * The layout must not be chosen by window width alone. A phone held sideways is wider
 * than the 768px breakpoint, and the desktop layout it then picked has no bottom menu —
 * the section bar disappeared and the user was left on a pane with no way back. A phone
 * is a phone in both orientations.
 */
export function isPhonePlatform(): boolean {
  if (!isTauri()) return false;
  return typeof navigator !== 'undefined' && /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
}
