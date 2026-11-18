// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hexToBase58Key } from './invite';
import { sendContactRequest, sendContactUpdates } from './messaging';
import { statusFetch } from './http';

// Mock the HTTP boundary: only the request body that reaches status-go matters,
// not the transport.
vi.mock('./http', () => ({
  statusFetch: vi.fn(),
}));

const fetchMock = vi.mocked(statusFetch);

/** Key from an Android invite; both failure modes were reproduced with it. */
const KEY_B58 = 'zQ3shgzWjnQtDHjmoYf6ZtzsWHkV31nfP4fisEiTmX1LuvGhm';
const KEY_HEX = '0x0322f1afef301489b0102a63d7f0ea6746ae1d6eaf35347854acbed82e4773d1c0';
/** Legacy uncompressed key: 132 characters, accepted by status-go as is. */
const KEY_LEGACY = '0x04' + 'a'.repeat(128);

/** Body of the last `statusFetch` call (`params[0]` of `wakuext_sendContactRequest`). */
function sentBody(): any {
  expect(fetchMock).toHaveBeenCalled();
  const call = fetchMock.mock.calls.at(-1)!;
  return (call[1] as any).params[0];
}

describe('sendContactRequest', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({} as any);
  });

  it('конвертирует сжатый 0x-ключ в multibase: status-go не понимает type "3"', async () => {
    await sendContactRequest(KEY_HEX, '');
    expect(sentBody().id.startsWith('zQ3')).toBe(true);
    expect(sentBody().id).toBe(KEY_B58);
  });

  it('multibase-ключ передаёт как есть', async () => {
    await sendContactRequest(KEY_B58, '');
    expect(sentBody().id).toBe(KEY_B58);
  });

  it('старый несжатый ключ (132 символа) передаёт как есть', async () => {
    await sendContactRequest(KEY_LEGACY, '');
    expect(sentBody().id).toBe(KEY_LEGACY);
  });

  it('пустое сообщение заменяет текстом: status-go возвращает invalid message', async () => {
    await sendContactRequest(KEY_B58, '');
    expect(sentBody().message.trim().length).toBeGreaterThan(0);
  });

  it('пробельное сообщение тоже считает пустым', async () => {
    await sendContactRequest(KEY_B58, '   ');
    expect(sentBody().message.trim().length).toBeGreaterThan(0);
  });

  it('непустое сообщение сохраняет без изменений', async () => {
    await sendContactRequest(KEY_B58, 'Привет!');
    expect(sentBody().message).toBe('Привет!');
  });

  it('отправляет через wakuext_sendContactRequest', async () => {
    await sendContactRequest(KEY_B58, '');
    const call = fetchMock.mock.calls.at(-1)!;
    expect((call[1] as any).method).toBe('wakuext_sendContactRequest');
  });
});

describe('hexToBase58Key', () => {
  it('даёт multibase-форму с префиксом z и multicodec 0xe7 0x01', () => {
    const out = hexToBase58Key(KEY_HEX);
    expect(out.startsWith('z')).toBe(true);
    expect(out).toBe(KEY_B58);
  });

  it('отвергает ключ неверной длины', () => {
    expect(() => hexToBase58Key('0x1234')).toThrow();
  });
});

describe('sendContactUpdates', () => {
  beforeEach(() => fetchMock.mockReset());

  it('передаёт имя ENS, а не экранное имя', async () => {
    // `SendContactUpdates(ctx, ensName, profileImage, …)` in status-go reads the display
    // name from settings itself. Passing the display name in this slot sent it to
    // contacts as their ENS name.
    fetchMock.mockResolvedValue({} as any);
    await sendContactUpdates('magnus-redkin.stateofus.eth');
    const call = fetchMock.mock.calls.at(-1)!;
    expect((call[1] as any).method).toBe('wakuext_sendContactUpdates');
    expect((call[1] as any).params[0]).toBe('magnus-redkin.stateofus.eth');
  });

  it('по умолчанию сообщает пустое имя ENS', async () => {
    fetchMock.mockResolvedValue({} as any);
    await sendContactUpdates();
    const call = fetchMock.mock.calls.at(-1)!;
    expect((call[1] as any).params[0]).toBe('');
  });
});
