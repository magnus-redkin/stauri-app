/**
 * Display-name rules, mirroring status-go.
 *
 * A name that status-go rejects is worse than one it refuses to save: the local
 * write succeeds, `wakuext_sendContactUpdates` answers successfully, and the
 * receiver silently drops the update. The sender then sees the new name and
 * nobody else does. The rules here are the ones enforced by
 * `ValidateDisplayName` in `internal/protocol/common/display_name.go`.
 */

/** Shortest accepted name, in characters. */
export const DISPLAY_NAME_MIN = 5;
/** Longest accepted name, in characters. */
export const DISPLAY_NAME_MAX = 24;

/**
 * What status-go accepts: letters, combining marks, digits, underscore, hyphen
 * and spaces.
 *
 * The same expression as Go's `^[\p{L}\p{M}\p{N}_\-\s]+$`, written with the
 * `u` flag so Unicode classes mean the same thing.
 */
const ALLOWED = /^[\p{L}\p{M}\p{N}_\-\s]+$/u;

/** Suffixes status-go refuses even though the expression above would allow a dot. */
const REFUSED_SUFFIXES = ['.eth', '_eth', '-eth'];

/**
 * Whether a name would be accepted by status-go.
 *
 * @param raw - Name as typed.
 * @returns `null` when the name is acceptable, otherwise the reason as a key of
 *   the locale files, so the caller can show a translated message.
 *
 * @remarks
 * An empty name is accepted: status-go treats it as "no name" and removes it.
 * Length is counted in characters, not UTF-16 units, so a name of Cyrillic or
 * emoji is measured the way Go measures it.
 */
export function displayNameError(raw: string): string | null {
  const name = raw.trim();
  if (name === '') return null;

  const length = [...name].length;
  if (length < DISPLAY_NAME_MIN || length > DISPLAY_NAME_MAX) return 'Name must be 5 to 24 characters';

  if (!ALLOWED.test(name)) return 'Only letters, digits, spaces, hyphens and underscores';
  if (REFUSED_SUFFIXES.some((s) => name.toLowerCase().endsWith(s))) return 'A name cannot end with eth';

  return null;
}
