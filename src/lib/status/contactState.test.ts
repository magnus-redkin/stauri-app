import { describe, it, expect } from 'vitest';
import { isIncomingRequest, isMutual, LOCAL_SENT, REMOTE_RECEIVED } from './contactState';

describe('состояние контактного запроса', () => {
  it('входящий запрос: нам прислали, мы ещё не добавляли', () => {
    expect(isIncomingRequest({ contactRequestRemoteState: REMOTE_RECEIVED, contactRequestLocalState: 0 })).toBe(true);
  });

  it('после принятия (мы добавили) входящего уже нет', () => {
    expect(isIncomingRequest({ contactRequestRemoteState: REMOTE_RECEIVED, contactRequestLocalState: LOCAL_SENT })).toBe(false);
  });

  it('взаимный контакт — не входящий запрос', () => {
    const c = { contactRequestRemoteState: REMOTE_RECEIVED, contactRequestLocalState: LOCAL_SENT };
    expect(isMutual(c)).toBe(true);
    expect(isIncomingRequest(c)).toBe(false);
  });

  it('старое поле contactRequestState=3 больше не даёт входящего', () => {
    expect(isIncomingRequest({ contactRequestState: 3 } as any)).toBe(false);
  });

  it('пустой контакт — ничего не ожидает', () => {
    expect(isIncomingRequest(null)).toBe(false);
    expect(isMutual(undefined)).toBe(false);
  });
});
