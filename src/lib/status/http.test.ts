import { describe, it, expect, vi, beforeEach } from 'vitest';
import { statusFetch } from './http';
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';

// Mock the @tauri-apps/plugin-http module.
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}));

// The auth proxy token comes from a Rust command.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue('test-token'),
}));

describe('statusFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('должен успешно отправлять запрос и возвращать распарсенные данные', async () => {
    const mockResponse = {
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ result: 'success', data: 123 })),
    };
    vi.mocked(tauriFetch).mockResolvedValue(mockResponse as any);

    const result = await statusFetch(8080, 'TestEndpoint', { foo: 'bar' });

    expect(tauriFetch).toHaveBeenCalledWith('http://127.0.0.1:8080/statusgo/TestEndpoint', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Stauri-Token': 'test-token',
      },
      body: JSON.stringify({ foo: 'bar' }),
    });
    expect(result).toEqual({ result: 'success', data: 123 });
  });

  it('должен возвращать пустой объект при пустом ответе', async () => {
    const mockResponse = {
      ok: true,
      text: vi.fn().mockResolvedValue(''),
    };
    vi.mocked(tauriFetch).mockResolvedValue(mockResponse as any);

    const result = await statusFetch(8080, 'LoginAccount', { password: '123' });
    expect(result).toEqual({});
  });

  it('должен выбрасывать ошибку при HTTP-статусе не 2xx', async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      text: vi.fn().mockResolvedValue('Internal Server Error details...'),
    };
    vi.mocked(tauriFetch).mockResolvedValue(mockResponse as any);

    // The response body is deliberately kept out of the error text: it may carry
    // profile data. Only the status code remains.
    const promise = statusFetch(8080, 'Fail', {});
    await expect(promise).rejects.toThrow('HTTP 500');
    await expect(promise).rejects.not.toThrow('Internal Server Error details');
  });

  it('должен выбрасывать ошибку при невалидном JSON', async () => {
    const mockResponse = {
      ok: true,
      text: vi.fn().mockResolvedValue('not a valid json string'),
    };
    vi.mocked(tauriFetch).mockResolvedValue(mockResponse as any);

    // A fragment of the body is left out of the error as well.
    const promise = statusFetch(8080, 'BadJson', {});
    await expect(promise).rejects.toThrow('Invalid JSON response from BadJson');
    await expect(promise).rejects.not.toThrow('not a valid json string');
  });

  it('должен выбрасывать ошибку, если data.error является строкой', async () => {
    const mockResponse = {
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({ error: 'incorrect password' })),
    };
    vi.mocked(tauriFetch).mockResolvedValue(mockResponse as any);

    await expect(statusFetch(8080, 'Login', {})).rejects.toThrow('incorrect password');
  });

  it('должен выбрасывать ошибку, если data.error является объектом (JSON-RPC стиль)', async () => {
    const mockResponse = {
      ok: true,
      text: vi.fn().mockResolvedValue(JSON.stringify({
        error: { code: -32000, message: 'method not found' }
      })),
    };
    vi.mocked(tauriFetch).mockResolvedValue(mockResponse as any);

    await expect(statusFetch(8080, 'RPC', {})).rejects.toThrow('method not found');
  });
});
