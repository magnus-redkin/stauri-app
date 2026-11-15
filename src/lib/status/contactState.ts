/**
 * Contact request state derived from status-go contact fields.
 *
 * The source of truth is `internal/protocol/contacts/contact.go`:
 *   - we added them:   `ContactRequestLocalState  == Sent (2)`
 *   - they added us:   `ContactRequestRemoteState == Received (3)`
 *   - mutual:          both of the above
 *
 * @remarks
 * There is no `contactRequestState` field on a contact. Comparing that
 * non-existent field with 3 yields `undefined`, so incoming requests are never
 * detected.
 */

export const LOCAL_SENT = 2;
export const REMOTE_RECEIVED = 3;
/** We dismissed the incoming request (`ContactRequestStateDismissed`, contact.go). */
export const LOCAL_DISMISSED = 4;

export interface ContactRequestFields {
  contactRequestLocalState?: number;
  contactRequestRemoteState?: number;
}

/**
 * Whether someone sent us a request we have not accepted yet.
 *
 * @param c - Contact record from status-go, possibly absent.
 * @returns `true` when a request arrived and we have not sent one back.
 */
export function isIncomingRequest(c: ContactRequestFields | null | undefined): boolean {
  if (!c) return false;
  return c.contactRequestRemoteState === REMOTE_RECEIVED && c.contactRequestLocalState !== LOCAL_SENT;
}

/**
 * Whether the contact is mutual: we added them and they added us.
 *
 * @param c - Contact record from status-go, possibly absent.
 * @returns `true` when both sides have a sent request.
 */
export function isMutual(c: ContactRequestFields | null | undefined): boolean {
  if (!c) return false;
  return c.contactRequestLocalState === LOCAL_SENT && c.contactRequestRemoteState === REMOTE_RECEIVED;
}
