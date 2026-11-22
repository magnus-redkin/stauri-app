/**
 * Background update check.
 *
 * @remarks
 * The check used to be a button on the Settings screen, which meant nobody pressed it: a
 * release could sit unnoticed for weeks. It now runs once at start and then hourly, and
 * the result is shared state — the section bar marks Settings with a dot and the profile
 * panel shows a banner, so the offer appears wherever the user already is.
 *
 * Checking is automatic; installing is not. The signature prevents a swapped binary but
 * not a swapped moment, and an application that holds keys should not replace itself
 * under the user's hands.
 */
import { checkForUpdate, type UpdateInfo } from './updater';

/** One hour between checks, as agreed: often enough to notice, rare enough to be free. */
const INTERVAL_MS = 60 * 60 * 1000;

/** Result of the latest check. */
export const updateState = $state<{
  /** Version offered by the server; `null` when the build is current. */
  available: UpdateInfo | null;
  /** A check is in flight. */
  checking: boolean;
  /** When the last check finished, in milliseconds. */
  checkedAt: number | null;
  /** Why the last check gave no answer, if it did not. */
  error: string | null;
}>({
  available: null,
  checking: false,
  checkedAt: null,
  error: null,
});

let timer: ReturnType<typeof setInterval> | null = null;

/**
 * Asks the server whether a newer release exists.
 *
 * Never throws: an update is not critical, and a failed check must not disturb anything.
 */
export async function runUpdateCheck(): Promise<void> {
  if (updateState.checking) return;
  updateState.checking = true;
  try {
    const { update, error } = await checkForUpdate();
    updateState.available = update;
    updateState.error = error;
    updateState.checkedAt = Date.now();
  } finally {
    updateState.checking = false;
  }
}

/**
 * Starts the hourly check.
 *
 * @remarks
 * Idempotent: the page calls it once at startup, and a second call (a hot reload, a
 * second mount) must not stack timers.
 */
export function startUpdatePolling(): void {
  if (timer !== null) return;
  void runUpdateCheck();
  timer = setInterval(() => void runUpdateCheck(), INTERVAL_MS);
}

/** Stops the timer; used by tests and by a full shutdown of the interface. */
export function stopUpdatePolling(): void {
  if (timer === null) return;
  clearInterval(timer);
  timer = null;
}
