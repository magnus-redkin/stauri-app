import { statusState, setSeedSaved } from './statusStore.svelte';
import { loadAvatar } from '$lib/status/profile';

/**
 * Shared profile picture state.
 *
 * One store rather than a value per section: the picture is shown in the profile
 * on both sides (the left column and the editing pane), and uploading it in one
 * place has to update the other without a reload. Keeping the data URL here means
 * the picture is fetched once per session, not once per pane.
 */
export const profileAvatarState = $state({
  /** The picture as a data URL, or `null` when there is none or it is not loaded. */
  url: null as string | null,
  /** Set while a fetch is in flight, so a second call does not start another. */
  loading: false,
});

/**
 * Replaces the shared picture.
 *
 * @param url - New data URL, or `null` to show initials.
 * @remarks Called after an upload; the backend stores the file itself, so this only
 * updates what the panes display.
 */
export function setProfileAvatar(url: string | null): void {
  profileAvatarState.url = url;
}

/**
 * Fetches the picture once and stores it for every pane.
 *
 * @param force - Fetch even when a value is already present.
 * @remarks
 * Two panes ask for the picture on the same login; without the `loading` flag both
 * would fetch it, and without the early return every visit to the profile would
 * fetch it again. The picture changes only through an upload, which sets the value
 * directly.
 */
export async function ensureProfileAvatar(force = false): Promise<void> {
  if (!statusState.backendRunning) return;
  if (profileAvatarState.loading) return;
  if (profileAvatarState.url && !force) return;
  profileAvatarState.loading = true;
  try {
    profileAvatarState.url = await loadAvatar();
  } finally {
    profileAvatarState.loading = false;
  }
}

/**
 * Password typed at login, kept in memory for the session.
 *
 * @remarks
 * The user is expected to remember the seed phrase, not the string that encrypts this
 * device's database, so the password is captured once when the profile is opened and
 * reused where status-go needs it — changing the password, for instance, which has to
 * unwrap the key before re-wrapping it.
 *
 * Never written to disk and cleared on logout. It stays in a module variable rather
 * than in reactive state: nothing renders it, and a `$state` field would put it into
 * every reactive graph that reads the store.
 */
let sessionPassword = '';

/** Records the password typed at login. */
export function setSessionPassword(password: string): void {
  sessionPassword = password;
}

/** The password typed at login, or an empty string when the app has none. */
export function getSessionPassword(): string {
  return sessionPassword;
}

/** Forgets the password. Called on logout and profile switch. */
export function clearSessionPassword(): void {
  sessionPassword = '';
}

/**
 * Returns the display name (alias, falling back to "User").
 */
export function getAlias(): string {
  return statusState.alias || 'User';
}

/**
 * Reports whether the seed phrase has been saved.
 */
export function isSeedSaved(): boolean {
  return statusState.isSeedSaved;
}

/**
 * Stores the seed-phrase flag, both in state and in `localStorage`.
 *
 * @param saved - Whether the user confirmed saving the seed phrase.
 */
export function saveSeedStatus(saved: boolean) {
  setSeedSaved(saved);
}

/**
 * Returns the profile public key, or an empty string before login.
 */
export function getPublicKey(): string {
  return statusState.publicKey || '';
}

/**
 * Returns the Profile ID (`key-uid`), or an empty string before login.
 */
export function getProfileId(): string {
  return statusState.accountKeyUid || '';
}

/**
 * Returns the account list known to the backend.
 */
export function getAccounts(): any[] {
  return statusState.accounts || [];
}
