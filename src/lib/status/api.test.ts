import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as api from './api';
import * as http from './http';
import { invoke } from '@tauri-apps/api/core';

// Mock external dependencies.
vi.mock('@tauri-apps/api/core');
vi.mock('./http');

describe('Status API', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('startBackend', () => {
    it('должен вызывать invoke с правильными аргументами для sepolia', async () => {
      const mockResponse = {
        port: 1234, dataDir: '/tmp/sepolia', networkName: 'sepolia',
        chainId: 11155111, rpcUrl: 'https://rpc.sepolia.org', wakuFleet: 'status.test', isTestnet: true
      };
      vi.mocked(invoke).mockResolvedValue(mockResponse);

      const result = await api.startBackend('sepolia');

      expect(invoke).toHaveBeenCalledWith('start_backend', { network: 'sepolia' });
      expect(result).toEqual(mockResponse);
    });

    it('должен вызывать invoke без network по умолчанию', async () => {
      vi.mocked(invoke).mockResolvedValue({ port: 1234, dataDir: '/tmp', networkName: 'mainnet', chainId: 1, rpcUrl: '', wakuFleet: '', isTestnet: false });

      await api.startBackend();

      expect(invoke).toHaveBeenCalledWith('start_backend', { network: undefined });
    });
  });

  describe('initializeApplication', () => {
    it('должен вызывать statusFetch с правильным payload', async () => {
      const mockResponse = { accounts: [{ 'key-uid': 'test-123' }] };
      vi.mocked(http.statusFetch).mockResolvedValue(mockResponse);

      const result = await api.initializeApplication('/tmp/data', 11155111);

      expect(http.statusFetch).toHaveBeenCalledWith('InitializeApplication', {
        dataDir: '/tmp/data',
        NetworkID: 11155111,
      });
      expect(result).toEqual(mockResponse);
    });
  });

  describe('createAccountAndLogin', () => {
    it('должен формировать корректный запрос на создание аккаунта', async () => {
      vi.mocked(http.statusFetch).mockResolvedValue({ error: '' });

      await api.createAccountAndLogin('/tmp/data', 'supersecret');

      // RPC keys come from .env and are absent in tests, so only the fields the
      // code builds itself are checked.
      expect(http.statusFetch).toHaveBeenCalledWith('CreateAccountAndLogin',
        expect.objectContaining({
          rootDataDir: '/tmp/data',
          displayName: 'Stauri User',
          password: 'supersecret',
          customizationColor: 'primary',
          statusProxyStageName: 'prod',
          // Without an enabled swap provider the Router has no handlers and
          // answers WR-005 "no best route found" for every swap request.
          enableLiFiProvider: true,
        })
      );
    });
  });

  describe('loginAccount', () => {
    it('должен вызывать LoginAccount с keyUid и паролем', async () => {
      vi.mocked(http.statusFetch).mockResolvedValue({ 'key-uid': 'test-123' });

      await api.loginAccount('supersecret', 'test-123');

      expect(http.statusFetch).toHaveBeenCalledWith('LoginAccount',
        expect.objectContaining({
          password: 'supersecret',
          keyUid: 'test-123',
          statusProxyStageName: 'prod',
          // WalletConfig is read on login too
          // (pkg/backend/geth_backend.go, loginAccount), so the flag must be
          // present here as well, not only at account creation.
          enableLiFiProvider: true,
        })
      );
    });
  });

  describe('getAccountsList', () => {
    it('должен делегировать вызов initializeApplication и возвращать массив accounts', async () => {
      const mockInitData = { accounts: [{ 'key-uid': 'acc-1' }, { 'key-uid': 'acc-2' }] };
      vi.mocked(http.statusFetch).mockResolvedValue(mockInitData);

      const accounts = await api.getAccountsList('/tmp/data', 1);

      expect(http.statusFetch).toHaveBeenCalledWith('InitializeApplication', {
        dataDir: '/tmp/data',
        NetworkID: 1
      });
      expect(accounts).toHaveLength(2);
      expect(accounts[0]['key-uid']).toBe('acc-1');
    });

    it('должен возвращать пустой массив, если accounts undefined', async () => {
      vi.mocked(http.statusFetch).mockResolvedValue({}); // No accounts field.

      const accounts = await api.getAccountsList('/tmp/data', 1);
      expect(accounts).toEqual([]);
    });
  });

  describe('Обработка ошибок', () => {
    it('должен пробрасывать ошибку от statusFetch', async () => {
      const error = new Error('Network error');
      vi.mocked(http.statusFetch).mockRejectedValue(error);

      await expect(api.startMessenger()).rejects.toThrow('Network error');
    });
  });

  describe('sendChatMessage и комментарии', () => {
    beforeEach(() => {
      vi.mocked(http.statusFetch).mockResolvedValue({});
    });

    it('отправляет обычное сообщение с пустым responseTo', async () => {
      await api.sendChatMessage('status', 'hi');

      const body = vi.mocked(http.statusFetch).mock.calls[0][1] as any;
      expect(body.params[0]).toMatchObject({
        chatId: 'status',
        text: 'hi',
        contentType: 1,
        responseTo: '',
      });
    });

    it('передаёт responseTo на верхнем уровне объекта', async () => {
      // Message.UnmarshalJSON reads the field at the top level:
      // `ResponseTo string \`json:"responseTo"\`` in the aux struct.
      await api.sendChatMessage('status', 'comment', '', '0xparent');

      const body = vi.mocked(http.statusFetch).mock.calls[0][1] as any;
      expect(body.params[0].responseTo).toBe('0xparent');
      // Not nested in a payload, and not in chatId.
      expect(body.params[0].chatId).toBe('status');
    });
  });

  describe('isReply', () => {
    it('различает запись и комментарий по responseTo', () => {
      expect(api.isReply({ responseTo: '0xparent' })).toBe(true);
      expect(api.isReply({ responseTo: '' })).toBe(false);
      expect(api.isReply({})).toBe(false);
      expect(api.isReply(null)).toBe(false);
      expect(api.isReply(undefined)).toBe(false);
    });
  });

  describe('keyUidFromMnemonic', () => {
    it('возвращает keyUID для правильной фразы', async () => {
      vi.mocked(http.statusCall).mockResolvedValue({ keyUID: '0xabc' });

      await expect(api.keyUidFromMnemonic('one two three')).resolves.toBe('0xabc');
      expect(http.statusCall).toHaveBeenCalledWith('ValidateMnemonicV2', { mnemonic: 'one two three' });
    });

    it('нормализует пробелы и регистр перед отправкой', async () => {
      // status-go matches words case-sensitively against its word list: the phrase
      // typed with capitals or double spaces must still resolve to the same profile.
      vi.mocked(http.statusCall).mockResolvedValue({ keyUID: '0xabc' });

      await api.keyUidFromMnemonic('  One   TWO three \n');

      expect(http.statusCall).toHaveBeenCalledWith('ValidateMnemonicV2', { mnemonic: 'one two three' });
    });

    it('возвращает null, когда бэкенд отверг фразу', async () => {
      // `error` in the reply body is how this export reports a bad mnemonic; it does
      // not throw, so the caller gets null instead of an exception.
      vi.mocked(http.statusCall).mockResolvedValue({ error: 'invalid mnemonic' });

      await expect(api.keyUidFromMnemonic('bad words')).resolves.toBeNull();
    });

    it('возвращает null, когда вызов упал', async () => {
      // A wrong phrase is an ordinary typing outcome, not a failure to surface.
      vi.mocked(http.statusCall).mockRejectedValue(new Error('boom'));

      await expect(api.keyUidFromMnemonic('bad words')).resolves.toBeNull();
    });

    it('возвращает null без keyUID в ответе', async () => {
      vi.mocked(http.statusCall).mockResolvedValue({});

      await expect(api.keyUidFromMnemonic('one two three')).resolves.toBeNull();
    });
  });

  describe('deleteProfile', () => {
    it('передаёт keyUID и каталог keystore', async () => {
      vi.mocked(http.statusCall).mockResolvedValue({ error: '' });

      await api.deleteProfile('0xabc', '/data/keystore/0xabc');

      expect(http.statusCall).toHaveBeenCalledWith('DeleteMultiaccount', {
        keyUID: '0xabc',
        keyStoreDir: '/data/keystore/0xabc',
      });
    });

    it('пробрасывает ошибку бэкенда, не считая её успехом', async () => {
      // The export answers `{"error": ""}` on success, so a non-empty `error` must
      // stop the restore: continuing would then try to log into a profile that is
      // still locked by the old password.
      vi.mocked(http.statusCall).mockResolvedValue({ error: 'keystore is in use' });

      await expect(api.deleteProfile('0xabc', '/tmp')).rejects.toThrow('keystore is in use');
    });
  });
});
