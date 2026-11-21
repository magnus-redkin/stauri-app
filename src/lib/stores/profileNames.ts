/**
 * Display names of the profiles on this device, remembered for the entry screen.
 *
 * @remarks
 * status-go keeps the display name in settings, and settings belong to the profile that
 * is logged in. The entry screen runs before any login, yet it has to label the profiles
 * with the names their owner chose — the multiaccount name from creation ("Stauri User")
 * would stay on screen forever after a rename. A name is not a secret, so it is cached
 * per key uid here and refreshed every time the application sees the real value: on
 * login, after an edit, and when the creation wizard sets it.
 *
 * `localStorage` is a convenience, not storage of record: if it is unavailable the
 * picker falls back to whatever status-go reported, and nothing else changes.
 */

const PREFIX = 'stauri.profile-name.';

/**
 * Last known display name of a profile.
 *
 * @param keyUid - Profile key uid.
 * @returns The remembered name, or `undefined` when none was seen yet.
 */
export function profileName(keyUid: string): string | undefined {
  if (typeof localStorage === 'undefined' || !keyUid) return undefined;
  try {
    return localStorage.getItem(PREFIX + keyUid) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records the current display name of a profile.
 *
 * @param keyUid - Profile key uid.
 * @param name - Display name; an empty one forgets the entry.
 */
export function rememberProfileName(keyUid: string, name: string): void {
  if (typeof localStorage === 'undefined' || !keyUid) return;
  const trimmed = name.trim();
  try {
    if (trimmed) localStorage.setItem(PREFIX + keyUid, trimmed);
    else localStorage.removeItem(PREFIX + keyUid);
  } catch {
    // A refused write costs a stale label in the picker, nothing more.
  }
}
