/**
 * Состояние контактного запроса по полям контакта status-go.
 *
 * Источник правды — `internal/protocol/contacts/contact.go`:
 *   - мы добавили:   ContactRequestLocalState  == Sent (2)
 *   - нас добавили:  ContactRequestRemoteState == Received (3)
 *   - взаимный:      оба условия
 *
 * Поле `contactRequestState` у контакта не существует: прежний код сравнивал его
 * с 3 и поэтому никогда не видел входящих запросов.
 */

export const LOCAL_SENT = 2;
export const REMOTE_RECEIVED = 3;
/** Мы отклонили входящий запрос (`ContactRequestStateDismissed`, contact.go). */
export const LOCAL_DISMISSED = 4;

export interface ContactRequestFields {
  contactRequestLocalState?: number;
  contactRequestRemoteState?: number;
}

/** Нам прислали запрос, и мы его ещё не приняли (кнопка «Accept»). */
export function isIncomingRequest(c: ContactRequestFields | null | undefined): boolean {
  if (!c) return false;
  return c.contactRequestRemoteState === REMOTE_RECEIVED && c.contactRequestLocalState !== LOCAL_SENT;
}

/** Взаимный контакт: мы добавили и нас добавили. */
export function isMutual(c: ContactRequestFields | null | undefined): boolean {
  if (!c) return false;
  return c.contactRequestLocalState === LOCAL_SENT && c.contactRequestRemoteState === REMOTE_RECEIVED;
}
