import { statusState } from './statusStore.svelte';
import { getContacts, sendContactRequest, acceptContactRequest } from '$lib/status/api';
import { formatError } from '$lib/utils/errors';
import { isIncomingRequest } from '$lib/status/contactState';
import { setPendingRequestsCount } from './statusStore.svelte';

export const contactsState = $state({
  items: [] as any[],
  selected: null as any | null,
  isLoading: false,
  loaded: false,
  error: '',
});

export async function loadContacts(force = false) {
  if (!statusState.backendRunning) return;
  if (contactsState.loaded && !force) return;

  contactsState.isLoading = true;
  try {
    const res = await getContacts();
    contactsState.items = res.result || [];
    const pendingCount = contactsState.items.filter((c: any) => isIncomingRequest(c)).length;
    setPendingRequestsCount(pendingCount);
    contactsState.loaded = true;
  } catch (e: any) {
    contactsState.error = formatError(e);
  } finally {
    contactsState.isLoading = false;
  }
}

export function selectContact(contact: any | null) {
  contactsState.selected = contact;
}

export async function acceptRequest(contactId: string) {
  if (!statusState.backendRunning) return;
  try {
    await acceptContactRequest(contactId);
    await loadContacts(true);
  } catch (e) {
    console.warn("Failed to accept:", e);
  }
}

export function resetContacts() {
  contactsState.items = [];
  contactsState.selected = null;
  contactsState.loaded = false;
}
