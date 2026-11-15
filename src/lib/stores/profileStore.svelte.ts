import { statusState, setSeedSaved } from './statusStore.svelte';

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
