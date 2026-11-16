import { describe, it, expect, vi, beforeEach } from 'vitest';
import { statusState, setNetworkInfo, setAccounts, resetState, processSignal } from './statusStore.svelte';
import { startMessenger } from '$lib/status/api';

// Mocks the API so processSignal makes no real requests.
vi.mock('$lib/status/api', () => ({
  startMessenger: vi.fn().mockResolvedValue({}),
  logout: vi.fn().mockResolvedValue({})
}));

vi.spyOn(console, 'warn').mockImplementation(() => {});

describe('statusStore', () => {
  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
  });

  describe('initial state', () => {
    it('должен иметь дефолтные значения mainnet', () => {
      expect(statusState.networkName).toBe('mainnet');
      expect(statusState.isTestnet).toBe(false);
      expect(statusState.wakuFleet).toBe('status.prod');
      expect(statusState.rpcUrl).toBe('');
      expect(statusState.isConnected).toBe(false);
      expect(statusState.isLoggedIn).toBe(false);
    });
  });

  describe('setNetworkInfo', () => {
    it('должен обновлять сетевую информацию', () => {
      setNetworkInfo('sepolia', 'https://rpc.sepolia.org', 'status.test', true, 11155111);
      expect(statusState.networkName).toBe('sepolia');
      expect(statusState.rpcUrl).toBe('https://rpc.sepolia.org');
      expect(statusState.wakuFleet).toBe('status.test');
      expect(statusState.isTestnet).toBe(true);
    });

    it('должен устанавливать mainnet', () => {
      setNetworkInfo('mainnet', 'https://ethereum-rpc.publicnode.com', 'status.prod', false, 1);
      expect(statusState.networkName).toBe('mainnet');
      expect(statusState.isTestnet).toBe(false);
    });
  });

  describe('setAccounts', () => {
    it('должен устанавливать список аккаунтов', () => {
      const mockAccounts = [
        { 'key-uid': 'uid-1', displayName: 'Account 1' },
        { 'key-uid': 'uid-2', displayName: 'Account 2' }
      ];
      setAccounts(mockAccounts);
      expect(statusState.accounts).toHaveLength(2);
      expect(statusState.accounts[0]['key-uid']).toBe('uid-1');
    });

    it('должен очищать аккаунты при передаче пустого массива', () => {
      setAccounts([{ 'key-uid': 'uid-1' }]);
      setAccounts([]);
      expect(statusState.accounts).toHaveLength(0);
    });
  });

  describe('resetState', () => {
    it('должен сбрасывать все поля к дефолтным значениям', () => {
      // Custom values are set first, then reset below.
      setNetworkInfo('sepolia', 'https://rpc.sepolia.org', 'status.test', true, 11155111);
      setAccounts([{ 'key-uid': 'uid-1' }]);
      statusState.isConnected = true;
      statusState.isConnecting = true; // also reset by resetState
      statusState.isLoggedIn = true;
      statusState.backendRunning = true;
      statusState.backendDataDir = '/tmp/test';
      statusState.accountKeyUid = 'uid-1';
      statusState.errorMsg = 'Some error';

      // Reset.
      resetState();

      // Check the reset.
      expect(statusState.networkName).toBe('mainnet'); // resetState sets it back to mainnet
      expect(statusState.accounts).toHaveLength(0);
      expect(statusState.isConnected).toBe(false);
      expect(statusState.isConnecting).toBe(false); // resetState clears isConnecting too
      expect(statusState.isLoggedIn).toBe(false);
      expect(statusState.backendRunning).toBe(false);
      expect(statusState.backendDataDir).toBe('');
      expect(statusState.accountKeyUid).toBe('');
      expect(statusState.errorMsg).toBe('');
    });
  });

  describe('processSignal', () => {
    it('должен обрабатывать сигнал node.login, не запуская messenger', () => {
      // The messenger starts from connectionStore after configureWalletRpc: RPC clients are cached
      // per chainID, and starting it before the providers are set would leave them pointing at
      // dead URLs.
      statusState.backendRunning = true;

      const loginSignal = JSON.stringify({
        type: 'node.login',
        event: {
          settings: {
            'key-uid': 'test-uid-123'
          }
        }
      });

      processSignal(loginSignal);

      expect(statusState.isLoggedIn).toBe(true);
      expect(statusState.accountKeyUid).toBe('test-uid-123');
      expect(startMessenger).not.toHaveBeenCalled();
    });

    it('должен обрабатывать ошибку входа', () => {
      const errorSignal = JSON.stringify({
        type: 'node.login',
        event: {
          error: 'Invalid password'
        }
      });
      processSignal(errorSignal);
      expect(statusState.errorMsg).toBe('Login failed: Invalid password');
      expect(statusState.isLoggedIn).toBe(false);
    });

    it('должен игнорировать невалидный JSON', () => {
      expect(() => processSignal('not a json')).not.toThrow();
    });

    it('должен игнорировать пустую строку', () => {
      expect(() => processSignal('')).not.toThrow();
    });
  });
});
