import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureWalletRpc, login, createAccount } from './connectionStore.svelte';
import { statusState, waitForNodeStopped, waitForLogin } from './statusStore.svelte';
import WebSocket from '@tauri-apps/plugin-websocket';
import {
  getFlatEthereumChains,
  setChainUserRpcProvider,
  startRpcProxy,
  getRpcProxySecret,
  setRpcUpstreams,
  loginAccount,
  logout,
  startMessenger,
  createAccountAndLogin,
} from '$lib/status/api';

vi.mock('$lib/status/api', () => ({
  startBackend: vi.fn(),
  stopBackend: vi.fn(),
  initializeApplication: vi.fn(),
  loginAccount: vi.fn(),
  createAccountAndLogin: vi.fn(),
  getFlatEthereumChains: vi.fn(),
  setChainUserRpcProvider: vi.fn(),
  startRpcProxy: vi.fn(),
  getRpcProxySecret: vi.fn(),
  setRpcUpstreams: vi.fn(),
  startMessenger: vi.fn(),
  getAuthToken: vi.fn().mockResolvedValue('test-token'),
  logout: vi.fn(),
}));

vi.mock('@tauri-apps/plugin-websocket', () => ({ default: { connect: vi.fn() } }));

vi.mock('./statusStore.svelte', () => ({
  statusState: { backendPort: 12345, isLoggedIn: false, accountKeyUid: 'key-uid-1' },
  setAccounts: vi.fn(),
  setNetworkInfo: vi.fn(),
  processSignal: vi.fn(),
  waitForLogin: vi.fn(),
  waitForNodeStopped: vi.fn(),
}));

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});

/**
 * A network in the shape networks_getFlatEthereumChains returns it.
 * The fields are named enabled and isActive — exactly as written in params.Network.
 */
function network(chainId: number, name: string, overrides: Record<string, unknown> = {}) {
  return { chainId, chainName: name, enabled: true, isActive: true, rpcProviders: [], ...overrides };
}

const PROXY_PORT = 43057;

/**
 * Forwarder path secret.
 *
 * The forwarder rejects requests without it (answering 404), so a provider URL
 * must carry the secret as its first segment. The tests pin this in their
 * expectations: otherwise a regression — "the secret disappeared from the URL
 * again" — would go unnoticed.
 */
const PROXY_SECRET = 'deadbeefdeadbeefdeadbeefdeadbeef';

/** Provider URL in the shape the function is expected to build. */
function proxyUrl(chainId: number): string {
  return `http://127.0.0.1:${PROXY_PORT}/${PROXY_SECRET}/${chainId}`;
}

describe('configureWalletRpc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (startRpcProxy as any).mockResolvedValue(PROXY_PORT);
    (getRpcProxySecret as any).mockResolvedValue(PROXY_SECRET);
    (setRpcUpstreams as any).mockResolvedValue(undefined);
    (setChainUserRpcProvider as any).mockResolvedValue({ result: null });
  });

  it('прописывает user-провайдера каждой активной сети на локальный форвардер', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([
      network(1, 'Ethereum'),
      network(42161, 'Arbitrum'),
    ]);

    await configureWalletRpc(12345);

    expect(setChainUserRpcProvider).toHaveBeenCalledTimes(2);
    expect(setChainUserRpcProvider).toHaveBeenCalledWith(
      12345, 1, 'stauri-rpc', proxyUrl(1)
    );
    expect(setChainUserRpcProvider).toHaveBeenCalledWith(
      12345, 42161, 'stauri-rpc', proxyUrl(42161)
    );
  });

  it('пропускает сети без isActive — регрессия на поле "active"', async () => {
    // Networks with an `active` field instead of `isActive`: filtering by the
    // missing field selected 0 networks and no providers were written at all.
    (getFlatEthereumChains as any).mockResolvedValue([
      network(1, 'Ethereum'),
      { chainId: 10, chainName: 'Optimism', enabled: true, active: true },
      network(8453, 'Base', { isActive: false }),
      network(56, 'Binance', { enabled: false }),
    ]);

    await configureWalletRpc(12345);

    expect(setChainUserRpcProvider).toHaveBeenCalledTimes(1);
    expect(setChainUserRpcProvider).toHaveBeenCalledWith(
      12345, 1, 'stauri-rpc', proxyUrl(1)
    );
  });

  it('передаёт таблицу upstream форвардеру при запуске', async () => {
    (getFlatEthereumChains as any).mockRejectedValue(new Error('API not ready'));

    await configureWalletRpc(12345);

    // Before node start networks_* is unavailable, but the forwarder must
    // already know the URLs: a provider from the previous run points at this port.
    expect(startRpcProxy).toHaveBeenCalledWith(
      expect.objectContaining({ 1: expect.stringContaining('publicnode') })
    );
    expect(setChainUserRpcProvider).not.toHaveBeenCalled();
  });

  it('не трогает сеть, если провайдер уже указывает на тот же URL', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([
      network(1, 'Ethereum', {
        rpcProviders: [{
          type: 'user', name: 'stauri-rpc', enabled: true,
          url: proxyUrl(1),
        }],
      }),
    ]);

    await configureWalletRpc(12345);

    expect(setChainUserRpcProvider).not.toHaveBeenCalled();
  });

  it('перезаписывает провайдера, если URL устарел', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([
      network(1, 'Ethereum', {
        rpcProviders: [{
          type: 'user', name: 'stauri-rpc', enabled: true,
          url: 'http://127.0.0.1:9999/1',
        }],
      }),
    ]);

    await configureWalletRpc(12345);

    expect(setChainUserRpcProvider).toHaveBeenCalledWith(
      12345, 1, 'stauri-rpc', proxyUrl(1)
    );
  });

  it('пропускает сети, для которых нет известного RPC', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([
      network(999999, 'Unknown chain'),
    ]);

    await configureWalletRpc(12345);

    expect(setChainUserRpcProvider).not.toHaveBeenCalled();
  });

  it('сообщает, что провайдеров пришлось записывать (чистый профиль)', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([network(1, 'Ethereum')]);

    const result = await configureWalletRpc(12345);

    expect(result.wroteProviders).toBe(true);
  });

  it('сообщает, что записывать было нечего (повторный запуск)', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([
      network(1, 'Ethereum', {
        rpcProviders: [{
          type: 'user', name: 'stauri-rpc', enabled: true,
          url: proxyUrl(1),
        }],
      }),
    ]);

    const result = await configureWalletRpc(12345);

    expect(result.wroteProviders).toBe(false);
  });
});

/**
 * Node restart on a fresh profile.
 *
 * The node starts inside loginAccount and immediately builds RPC clients from the
 * built-in providers; the cache is not invalidated until it stops. So when
 * providers had to be written, login must be repeated, or balances stay in error.
 */
describe('перезапуск ноды после записи провайдеров', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    statusState.backendPort = 12345;
    statusState.accountKeyUid = 'key-uid-1';
    (startRpcProxy as any).mockResolvedValue(PROXY_PORT);
    (getRpcProxySecret as any).mockResolvedValue(PROXY_SECRET);
    (setRpcUpstreams as any).mockResolvedValue(undefined);
    (setChainUserRpcProvider as any).mockResolvedValue({ result: null });
    (loginAccount as any).mockResolvedValue({});
    (logout as any).mockResolvedValue({});
    (startMessenger as any).mockResolvedValue({});
    (waitForLogin as any).mockResolvedValue(undefined);
    (waitForNodeStopped as any).mockResolvedValue(undefined);
    (WebSocket.connect as any).mockResolvedValue({
      addListener: vi.fn(),
      disconnect: vi.fn(),
    });
  });

  it('перезапускает ноду, когда вход идёт на чистом профиле', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([network(1, 'Ethereum')]);

    await login('pass', 'key-uid-1');

    // Logout and re-login happened exactly once.
    expect(logout).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith(12345);
    expect(waitForNodeStopped).toHaveBeenCalledTimes(1);
    expect(loginAccount).toHaveBeenCalledTimes(2);
    expect(loginAccount).toHaveBeenNthCalledWith(1, 12345, 'pass', 'key-uid-1');
    expect(loginAccount).toHaveBeenNthCalledWith(2, 12345, 'pass', 'key-uid-1');
    // messenger starts only after the restart — once.
    expect(startMessenger).toHaveBeenCalledTimes(1);
  });

  it('ждёт остановки ноды ДО повторного входа', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([network(1, 'Ethereum')]);

    const order: string[] = [];
    // Model of the real signal: the wait is registered in advance and resolves
    // only after the node has actually stopped.
    let resolveStopped: () => void = () => {};
    (waitForNodeStopped as any).mockImplementation(
      () => new Promise<void>((resolve) => {
        order.push('wait-registered');
        resolveStopped = () => { order.push('stopped'); resolve(); };
      })
    );
    (logout as any).mockImplementation(async () => {
      order.push('logout');
      resolveStopped();
    });
    (loginAccount as any).mockImplementation(async () => { order.push('login'); });

    await login('pass', 'key-uid-1');

    // The wait is registered before logout (otherwise the signal could be
    // missed), but re-login happens strictly after the stop.
    expect(order).toEqual(['login', 'wait-registered', 'logout', 'stopped', 'login']);
  });

  it('не перезапускает ноду, если провайдер уже на месте', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([
      network(1, 'Ethereum', {
        rpcProviders: [{
          type: 'user', name: 'stauri-rpc', enabled: true,
          url: proxyUrl(1),
        }],
      }),
    ]);

    await login('pass', 'key-uid-1');

    expect(logout).not.toHaveBeenCalled();
    expect(waitForNodeStopped).not.toHaveBeenCalled();
    expect(loginAccount).toHaveBeenCalledTimes(1);
    expect(startMessenger).toHaveBeenCalledTimes(1);
  });

  it('пропускает перезапуск при создании аккаунта без keyUid', async () => {
    // createAccountAndLogin may not return a key-uid: re-login without one is
    // impossible, so the previous path applies — providers and messenger.
    statusState.accountKeyUid = '';
    (getFlatEthereumChains as any).mockResolvedValue([network(1, 'Ethereum')]);
    (createAccountAndLogin as any).mockResolvedValue({});

    await createAccount('pass');

    expect(logout).not.toHaveBeenCalled();
    expect(setChainUserRpcProvider).toHaveBeenCalled();
    expect(startMessenger).toHaveBeenCalledTimes(1);
  });

  it('перезапускает ноду при создании аккаунта, когда keyUid известен', async () => {
    statusState.accountKeyUid = 'key-uid-1';
    (getFlatEthereumChains as any).mockResolvedValue([network(1, 'Ethereum')]);
    (createAccountAndLogin as any).mockResolvedValue({});

    await createAccount('pass');

    expect(createAccountAndLogin).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledTimes(1);
    expect(loginAccount).toHaveBeenCalledTimes(1);
    expect(startMessenger).toHaveBeenCalledTimes(1);
  });
});
