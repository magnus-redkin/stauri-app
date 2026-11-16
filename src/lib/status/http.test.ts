import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { statusCall, statusFetch } from './http';

// status-go lives in this process, so every call is a Tauri command.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
}));

describe('statusFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('должен вызывать status_rpc с именем метода и параметрами', async () => {
    vi.mocked(invoke).mockResolvedValue({ data: 123 });

    const result = await statusFetch('CallRPC', {
      method: 'wakuext_chats',
      params: [],
    });

    expect(invoke).toHaveBeenCalledWith('status_rpc', {
      method: 'wakuext_chats',
      params: [],
    });
    // Rust returns the bare result; callers read `res.result`, so the envelope
    // is rebuilt in statusFetch.
    expect(result).toEqual({ result: { data: 123 } });
  });

  it('оборачивает пустой ответ в result, чтобы вызывающие читали res.result', async () => {
    vi.mocked(invoke).mockResolvedValue(null);

    const result = await statusFetch<any>('CallRPC', { method: 'wakuext_chats', params: [] });
    expect(result.result).toBeNull();
  });

  it('не заворачивает result повторно', async () => {
    // A caller that already received an envelope-shaped reply must not get
    // `{ result: { result: … } }`.
    vi.mocked(invoke).mockResolvedValue({ result: [1, 2] });

    const result = await statusFetch<any>('CallRPC', { method: 'wakuext_chats', params: [] });
    expect(result.result).toEqual([1, 2]);
  });

  it('должен пробрасывать ошибку backend без тела ответа', async () => {
    // Rust turns a JSON-RPC error into a rejected command; the message is the
    // method error text and carries no profile data.
    vi.mocked(invoke).mockRejectedValue(new Error('incorrect password'));

    await expect(
      statusFetch('CallRPC', { method: 'wallet_signMessage', params: [] })
    ).rejects.toThrow('incorrect password');
  });

  it('должен выбрасывать ошибку, если в ответе есть поле error', async () => {
    vi.mocked(invoke).mockResolvedValue({ error: { code: -32000, message: 'method not found' } });

    await expect(
      statusFetch('CallRPC', { method: 'wallet_unknown', params: [] })
    ).rejects.toThrow('method not found');
  });

  it('должен выбрасывать ошибку, если error является строкой', async () => {
    vi.mocked(invoke).mockResolvedValue({ error: 'incorrect password' });

    await expect(statusFetch('CallRPC', { method: 'x', params: [] })).rejects.toThrow(
      'incorrect password'
    );
  });

  it('не логирует тело запроса и ответа', async () => {
    // `settings_getSettings` returns the seed phrase in `mnemonic`; a log line
    // containing it would write the seed to the console.
    const spy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    vi.mocked(invoke).mockResolvedValue({ mnemonic: 'alpha bravo charlie' });

    await statusFetch('CallRPC', { method: 'settings_getSettings', params: [] });

    const logged = spy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).not.toContain('alpha bravo charlie');
    spy.mockRestore();
  });
});

describe('statusCall', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('передаёт lifecycle-эндпоинт в status_call', async () => {
    vi.mocked(invoke).mockResolvedValue('{"accounts":[]}');

    const result = await statusCall('InitializeApplication', { dataDir: '/tmp/x' });

    expect(invoke).toHaveBeenCalledWith('status_call', {
      endpoint: 'InitializeApplication',
      body: JSON.stringify({ dataDir: '/tmp/x' }),
    });
    expect(result).toEqual({ accounts: [] });
  });

  it('возвращает пустой объект на пустой ответ', async () => {
    vi.mocked(invoke).mockResolvedValue('');

    expect(await statusCall('Logout', {})).toEqual({});
  });

  it('statusFetch направляет не-CallRPC эндпоинт в status_call', async () => {
    vi.mocked(invoke).mockResolvedValue('{"accounts":[{"key-uid":"0x1"}]}');

    const result = await statusFetch<any>('LoginAccount', { password: 'x' });

    expect(invoke).toHaveBeenCalledWith('status_call', {
      endpoint: 'LoginAccount',
      body: JSON.stringify({ password: 'x' }),
    });
    expect(result.accounts[0]['key-uid']).toBe('0x1');
  });
});
