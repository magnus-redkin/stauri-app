/**
 * In-app navigation history behind the back and forward shortcuts.
 *
 * A snapshot of key state is stored rather than a section name, because the user returns to the
 * exact place they left: from a chat to that same chat, from the catalog to the community they had
 * expanded. A browser history is unavailable here: the SvelteKit SPA has a single URL, so
 * `history.back()` has nowhere to go and the stack is our own.
 *
 * @remarks
 * The stack is not recorded by hand at each navigation point, which is easy to forget. Instead
 * `+page.svelte` watches the key states and calls [`record`] after each change. A snapshot's key is
 * compared with the current top, so consecutive identical states are not written, or "back" would
 * return to the same place.
 */

export interface NavSnapshot {
  /** Top-level section (`home`, `chat`, `dapps`, …). */
  section: string;
  /** Selected chat id, or `null`. */
  chatId: string | null;
  /** Provider open in the dApp section, or `null`. */
  dappView: string | null;
  /** Selected catalog community id, or `null`. */
  communityId: string | null;
  /** Recovery screen. */
  showRecovery: boolean;
  /** Seed-phrase screen. */
  showCreateSeed: boolean;
}

/** Maximum number of steps; nobody goes deeper than this anyway. */
const MAX_STEPS = 50;

interface Entry {
  key: string;
  snapshot: NavSnapshot;
}

export const navState = $state({
  /** Position in history; -1 means history is empty. */
  index: -1,
  /** Whether a step back/forward is possible, for the UI buttons. */
  canBack: false,
  canForward: false,
});

// The stack and the applier live outside `$state`: the template does not read them. Only
// `canBack`/`canForward` above are read.
let stack: Entry[] = [];
let applyFn: ((s: NavSnapshot) => void) | null = null;

/**
 * Registers the state-restoring function.
 *
 * @param fn - Callback that applies a snapshot to the app.
 * @remarks
 * Called once from `+page.svelte`, the only place that knows how to set the section and nested
 * screens. The store does not import the component, to avoid a cycle.
 */
export function registerNavigationApplier(fn: (s: NavSnapshot) => void): void {
  applyFn = fn;
}

function syncFlags(): void {
  navState.canBack = navState.index > 0;
  navState.canForward = navState.index >= 0 && navState.index < stack.length - 1;
}

/** Snapshot identifier string; duplicates are filtered out by it. */
function keyOf(s: NavSnapshot): string {
  return [
    s.section,
    s.chatId ?? '',
    s.dappView ?? '',
    s.communityId ?? '',
    s.showRecovery ? 'r' : '',
    s.showCreateSeed ? 's' : '',
  ].join('|');
}

/**
 * Records the current state as a history step.
 *
 * @param snapshot - Key states describing where the user is.
 * @remarks
 * If the user went back first, the "future" is dropped, as in a browser: a new transition from
 * the middle of the history starts a new branch.
 */
export function record(snapshot: NavSnapshot): void {
  const key = keyOf(snapshot);

  // Same screen as the current top: a re-render (a new message arrived, say), not a transition.
  // Record nothing.
  if (navState.index >= 0 && stack[navState.index]?.key === key) return;

  // A transition from the middle: drop everything "ahead".
  if (navState.index < stack.length - 1) {
    stack = stack.slice(0, navState.index + 1);
  }

  stack.push({ key, snapshot });
  if (stack.length > MAX_STEPS) stack.shift();

  navState.index = stack.length - 1;
  syncFlags();
}

/** Steps back. Returns `true` when something was restored. */
export function goBack(): boolean {
  if (navState.index <= 0 || !applyFn) return false;
  navState.index -= 1;
  applyFn(stack[navState.index].snapshot);
  syncFlags();
  return true;
}

/** Steps forward. Returns `true` when something was restored. */
export function goForward(): boolean {
  if (navState.index >= stack.length - 1 || !applyFn) return false;
  navState.index += 1;
  applyFn(stack[navState.index].snapshot);
  syncFlags();
  return true;
}

/**
 * Clears the history.
 *
 * Runs on sign-out: returning into the previous profile's chats is not allowed, and stepping back
 * through foreign history would show empty screens.
 */
export function resetNavigation(): void {
  stack = [];
  navState.index = -1;
  syncFlags();
}

/** Test-only accessor for the snapshot keys on the stack. */
export function _debugStack(): string[] {
  return stack.map((e) => e.key);
}
