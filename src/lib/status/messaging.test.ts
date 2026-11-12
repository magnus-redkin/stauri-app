// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { hexToBase58Key } from './invite';
import { sendContactRequest } from './messaging';
import { statusFetch } from './http';

// Мокаем HTTP-границу: интересует только тело запроса, которое уходит
// в status-go, а не транспорт.
vi.mock('./http', () => ({
  statusFetch: vi.fn(),
}));

const fetchMock = vi.mocked(statusFetch);

/** Ключ из Invite на Android — на нём ловились обе ошибки. */
const KEY_B58 = 'zQ3shgzWjnQtDHjmoYf6ZtzsWHkV31nfP4fisEiTmX1LuvGhm';
const KEY_HEX = '0x0322f1afef301489b0102a63d7f0ea6746ae1d6eaf35347854acbed82e4773d1c0';
/** Старый несжатый ключ: 132 символа, status-go принимает как есть. */
const KEY_LEGACY = '0x04' + 'a'.repeat(128);

/** Тело последнего вызова `statusFetch` (params[0] от `wakuext_sendContactRequest`). */
function sentBody(): any {
  expect(fetchMock).toHaveBeenCalled();
  const call = fetchMock.mock.calls.at(-1)!;
  return (call[2] as any).params[0];
}

describe('sendContactRequest', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({} as any);
  });

  it('конвертирует сжатый 0x-ключ в multibase: status-go не понимает type "3"', async () => {
    await sendContactRequest(1, KEY_HEX, '');
    expect(sentBody().id.startsWith('zQ3')).toBe(true);
    expect(sentBody().id).toBe(KEY_B58);
  });

  it('multibase-ключ передаёт как есть', async () => {
    await sendContactRequest(1, KEY_B58, '');
    expect(sentBody().id).toBe(KEY_B58);
  });

  it('старый несжатый ключ (132 символа) передаёт как есть', async () => {
    await sendContactRequest(1, KEY_LEGACY, '');
    expect(sentBody().id).toBe(KEY_LEGACY);
  });

  it('пустое сообщение заменяет текстом: status-go возвращает invalid message', async () => {
    await sendContactRequest(1, KEY_B58, '');
    expect(sentBody().message.trim().length).toBeGreaterThan(0);
  });

  it('пробельное сообщение тоже считает пустым', async () => {
    await sendContactRequest(1, KEY_B58, '   ');
    expect(sentBody().message.trim().length).toBeGreaterThan(0);
  });

  it('непустое сообщение сохраняет без изменений', async () => {
    await sendContactRequest(1, KEY_B58, 'Привет!');
    expect(sentBody().message).toBe('Привет!');
  });

  it('отправляет через wakuext_sendContactRequest', async () => {
    await sendContactRequest(1, KEY_B58, '');
    const call = fetchMock.mock.calls.at(-1)!;
    expect((call[2] as any).method).toBe('wakuext_sendContactRequest');
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
