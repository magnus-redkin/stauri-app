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

/**
 * Merges contact records that arrived inside a `messages.new` signal.
 *
 * @param incoming - Contact records from `event.contacts`.
 * @remarks
 * A rename made by the other side reaches this node as a contact update, and status-go
 * includes the changed record in the signal instead of only in the next `wakuext_contacts`
 * reply. Merging it here shows the new name at once: the contacts list, the profile of the
 * selected contact and the chat list all read these records.
 *
 * Records are merged rather than replaced because a signal carries only what changed;
 * replacing would erase every name it did not mention.
 */
export function mergeContacts(incoming: any[]): void {
  if (incoming.length === 0) return;
  const byId = new Map<string, any>(contactsState.items.map((c: any) => [String(c.id), c]));
  for (const contact of incoming) {
    if (contact?.id) byId.set(String(contact.id), contact);
  }
  contactsState.items = [...byId.values()];

  // `selected` holds one of those records by value, not a live reference: without
  // replacing it the contact card keeps the old name after a rename.
  const openId = contactsState.selected?.id;
  if (openId) {
    const fresh = byId.get(String(openId));
    if (fresh) contactsState.selected = fresh;
  }
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
