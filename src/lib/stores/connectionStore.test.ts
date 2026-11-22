import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  configureWalletRpc,
  login,
  createAccount,
  restoreAccount,
  resetLocalProfileAndRestore,
  switchNetwork,
  LocalProfileLockedError,
} from './connectionStore.svelte';
import { invoke } from '@tauri-apps/api/core';
import {
  statusState,
  setAccounts,
  setNetworkInfo,
  waitForNodeStopped,
  waitForLogin,
} from './statusStore.svelte';
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
  restoreAccountAndLogin,
  keyUidFromMnemonic,
  deleteProfile,
} from '$lib/status/api';

vi.mock('$lib/status/api', () => ({
  startBackend: vi.fn(),
  stopBackend: vi.fn(),
  initializeApplication: vi.fn(),
  loginAccount: vi.fn(),
  createAccountAndLogin: vi.fn(),
  restoreAccountAndLogin: vi.fn(),
  keyUidFromMnemonic: vi.fn(),
  deleteProfile: vi.fn(),
  getFlatEthereumChains: vi.fn(),
  setChainUserRpcProvider: vi.fn(),
  startRpcProxy: vi.fn(),
  getRpcProxySecret: vi.fn(),
  setRpcUpstreams: vi.fn(),
  startMessenger: vi.fn(),
  logout: vi.fn(),
}));

// Signals arrive as a Tauri event now, not over a WebSocket.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

// `switchNetwork` reaches the backend through a single command. Outside Tauri the real
// `invoke` rejects, and other tests here rely on that, so the default is a rejection;
// tests that need a reply mock it explicitly.
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockRejectedValue(new Error('not running in Tauri')),
}));

vi.mock('./statusStore.svelte', () => ({
  statusState: { backendRunning: true, isLoggedIn: false, accountKeyUid: 'key-uid-1' },
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

    await configureWalletRpc();

    expect(setChainUserRpcProvider).toHaveBeenCalledTimes(2);
    expect(setChainUserRpcProvider).toHaveBeenCalledWith(1, 'stauri-rpc', proxyUrl(1)
    );
    expect(setChainUserRpcProvider).toHaveBeenCalledWith(42161, 'stauri-rpc', proxyUrl(42161)
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

    await configureWalletRpc();

    expect(setChainUserRpcProvider).toHaveBeenCalledTimes(1);
    expect(setChainUserRpcProvider).toHaveBeenCalledWith(1, 'stauri-rpc', proxyUrl(1)
    );
  });

  it('передаёт таблицу upstream форвардеру при запуске', async () => {
    (getFlatEthereumChains as any).mockRejectedValue(new Error('API not ready'));

    await configureWalletRpc();

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

    await configureWalletRpc();

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

    await configureWalletRpc();

    expect(setChainUserRpcProvider).toHaveBeenCalledWith(1, 'stauri-rpc', proxyUrl(1)
    );
  });

  it('пропускает сети, для которых нет известного RPC', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([
      network(999999, 'Unknown chain'),
    ]);

    await configureWalletRpc();

    expect(setChainUserRpcProvider).not.toHaveBeenCalled();
  });

  it('сообщает, что провайдеров пришлось записывать (чистый профиль)', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([network(1, 'Ethereum')]);

    const result = await configureWalletRpc();

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

    const result = await configureWalletRpc();

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
    statusState.backendRunning = true;
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
  });

  it('перезапускает ноду, когда вход идёт на чистом профиле', async () => {
    (getFlatEthereumChains as any).mockResolvedValue([network(1, 'Ethereum')]);

    await login('pass', 'key-uid-1');

    // Logout and re-login happened exactly once.
    expect(logout).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith();
    expect(waitForNodeStopped).toHaveBeenCalledTimes(1);
    expect(loginAccount).toHaveBeenCalledTimes(2);
    expect(loginAccount).toHaveBeenNthCalledWith(1, 'pass', 'key-uid-1');
    expect(loginAccount).toHaveBeenNthCalledWith(2, 'pass', 'key-uid-1');
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

/**
 * Restore of an existing profile.
 *
 * The phrase always derives the same key uid, so a match with a profile on this device
 * means it is already here. Calling `RestoreAccountAndLogin` in that case is what
 * produced `keypair already added`; the way in is a login.
 */
describe('restoreAccount', () => {
  const PHRASE = 'one two three four five six seven eight nine ten eleven twelve';

  beforeEach(() => {
    vi.clearAllMocks();
    statusState.backendRunning = true;
    statusState.accountKeyUid = '';
    (startRpcProxy as any).mockResolvedValue(PROXY_PORT);
    (getRpcProxySecret as any).mockResolvedValue(PROXY_SECRET);
    (setRpcUpstreams as any).mockResolvedValue(undefined);
    (setChainUserRpcProvider as any).mockResolvedValue({ result: null });
    (getFlatEthereumChains as any).mockResolvedValue([
      network(1, 'Ethereum', {
        rpcProviders: [{ type: 'user', name: 'stauri-rpc', enabled: true, url: proxyUrl(1) }],
      }),
    ]);
    (loginAccount as any).mockResolvedValue({});
    (restoreAccountAndLogin as any).mockResolvedValue({});
    (waitForLogin as any).mockResolvedValue(undefined);
    (startMessenger as any).mockResolvedValue({});
  });

  /** A profile list containing the profile the phrase belongs to. */
  function profileOnDevice(keyUid = 'key-uid-1') {
    (statusState as any).accounts = [{ 'key-uid': keyUid, name: 'Existing' }];
    (statusState as any).backendDataDir = '/data/mainnet';
  }

  it('входит в существующий профиль вместо восстановления', async () => {
    profileOnDevice();
    (keyUidFromMnemonic as any).mockResolvedValue('key-uid-1');

    const outcome = await restoreAccount(PHRASE, 'Passw0rd!');

    expect(outcome).toBe('opened');
    expect(loginAccount).toHaveBeenCalledWith('Passw0rd!', 'key-uid-1');
    // The whole point: restore would be refused with `keypair already added`.
    expect(restoreAccountAndLogin).not.toHaveBeenCalled();
    expect(startMessenger).toHaveBeenCalledTimes(1);
  });

  it('восстанавливает профиль, которого на устройстве нет', async () => {
    profileOnDevice('key-uid-other');
    (keyUidFromMnemonic as any).mockResolvedValue('key-uid-1');

    const outcome = await restoreAccount(PHRASE, 'Passw0rd!');

    expect(outcome).toBe('restored');
    expect(restoreAccountAndLogin).toHaveBeenCalledWith('/data/mainnet', 'Passw0rd!', PHRASE);
    expect(loginAccount).not.toHaveBeenCalled();
  });

  it('восстанавливает профиль, когда список профилей пуст', async () => {
    (statusState as any).accounts = [];
    (keyUidFromMnemonic as any).mockResolvedValue('key-uid-1');

    await restoreAccount(PHRASE, 'Passw0rd!');

    expect(restoreAccountAndLogin).toHaveBeenCalledTimes(1);
  });

  it('идёт по пути восстановления, когда фраза не распознана', async () => {
    profileOnDevice();
    (keyUidFromMnemonic as any).mockResolvedValue(null);

    await restoreAccount(PHRASE, 'Passw0rd!');

    // Without a key uid there is nothing to match against, so the restore path is the
    // only one left; status-go answers with its own error if the phrase is bad.
    expect(restoreAccountAndLogin).toHaveBeenCalledTimes(1);
  });

  it('сообщает о запертом локальном профиле, а не о непонятной ошибке', async () => {
    profileOnDevice();
    (keyUidFromMnemonic as any).mockResolvedValue('key-uid-1');
    // The exact text the real library reports for a wrong password (measured).
    (waitForLogin as any).mockRejectedValue(
      new Error('failed to open database: [keystore] incorrect password provided')
    );

    const failure = restoreAccount(PHRASE, 'Passw0rd!');

    await expect(failure).rejects.toBeInstanceOf(LocalProfileLockedError);
    // The message is the type's, not status-go's: the screen matches on it.
    await expect(failure).rejects.toMatchObject({ name: 'LocalProfileLockedError', keyUid: 'key-uid-1' });
    expect(startMessenger).not.toHaveBeenCalled();
    expect(restoreAccountAndLogin).not.toHaveBeenCalled();
  });

  it('считает запертым профиль с неразвёрнутым ключом', async () => {
    // The second shape of the same problem: the envelope cannot be unwrapped with this
    // password at all, which happens when the profile was created by another build.
    profileOnDevice();
    (keyUidFromMnemonic as any).mockResolvedValue('key-uid-1');
    (waitForLogin as any).mockRejectedValue(
      new Error('envelope: invalid key-encryption key')
    );

    await expect(restoreAccount(PHRASE, 'Passw0rd!')).rejects.toBeInstanceOf(
      LocalProfileLockedError
    );
  });

  it('не предлагает удалить копию при посторонней ошибке входа', async () => {
    // The reset offer is destructive. A stopped node or a broken library must surface as
    // an ordinary error, not as "delete your local copy": that would destroy data and
    // leave the user in exactly the same place.
    profileOnDevice();
    (keyUidFromMnemonic as any).mockResolvedValue('key-uid-1');
    (waitForLogin as any).mockRejectedValue(new Error('node is stopping'));

    const failure = restoreAccount(PHRASE, 'Passw0rd!');

    await expect(failure).rejects.toThrow('node is stopping');
    await expect(failure).rejects.not.toBeInstanceOf(LocalProfileLockedError);
  });

  it('переводит ошибку восстановления на понятный язык', async () => {
    (statusState as any).accounts = [];
    (keyUidFromMnemonic as any).mockResolvedValue(null);
    (waitForLogin as any).mockRejectedValue(new Error('keypair already added'));

    await expect(restoreAccount(PHRASE, 'Passw0rd!')).rejects.toThrow(
      'This profile is already on this device'
    );
  });

  it('требует ровно двенадцать слов', async () => {
    await expect(restoreAccount('one two three', 'Passw0rd!')).rejects.toThrow(
      'twelve words'
    );
    expect(restoreAccountAndLogin).not.toHaveBeenCalled();
  });
});

describe('resetLocalProfileAndRestore', () => {
  const PHRASE = 'one two three four five six seven eight nine ten eleven twelve';

  beforeEach(() => {
    vi.clearAllMocks();
    statusState.backendRunning = true;
    (statusState as any).backendDataDir = '/data/mainnet';
    (statusState as any).accounts = [
      { 'key-uid': 'key-uid-1', name: 'Existing' },
      { 'key-uid': 'key-uid-2', name: 'Other' },
    ];
    // The real `setAccounts` writes the list back into the state; the restore path
    // reads it right after, so a bare spy would leave the deleted profile in place
    // and the reset would take the "profile is here, log in" branch.
    (setAccounts as any).mockImplementation((accounts: any[]) => {
      (statusState as any).accounts = accounts;
    });
    (keyUidFromMnemonic as any).mockResolvedValue('key-uid-1');
    (deleteProfile as any).mockResolvedValue(undefined);
    (restoreAccountAndLogin as any).mockResolvedValue({});
    (waitForLogin as any).mockResolvedValue(undefined);
    (setChainUserRpcProvider as any).mockResolvedValue({ result: null });
    (getFlatEthereumChains as any).mockResolvedValue([
      network(1, 'Ethereum', {
        rpcProviders: [{ type: 'user', name: 'stauri-rpc', enabled: true, url: proxyUrl(1) }],
      }),
    ]);
    (startRpcProxy as any).mockResolvedValue(PROXY_PORT);
    (getRpcProxySecret as any).mockResolvedValue(PROXY_SECRET);
    (setRpcUpstreams as any).mockResolvedValue(undefined);
    (startMessenger as any).mockResolvedValue({});
  });

  it('удаляет локальную копию и восстанавливает профиль', async () => {
    const outcome = await resetLocalProfileAndRestore(PHRASE, 'NewPass1!');

    expect(outcome).toBe('restored');
    // The keystore lives under the profile directory, one folder per profile.
    expect(deleteProfile).toHaveBeenCalledWith('key-uid-1', '/data/mainnet/keystore/key-uid-1');
    expect(restoreAccountAndLogin).toHaveBeenCalledWith('/data/mainnet', 'NewPass1!', PHRASE);
  });

  it('убирает удалённый профиль из списка до восстановления', async () => {
    await resetLocalProfileAndRestore(PHRASE, 'NewPass1!');

    // Otherwise restoreAccount would find the deleted profile and try to log into it
    // again, failing on the same locked database.
    expect(setAccounts).toHaveBeenCalledWith([{ 'key-uid': 'key-uid-2', name: 'Other' }]);
    const removed = (setAccounts as any).mock.invocationCallOrder[0];
    const restored = (restoreAccountAndLogin as any).mock.invocationCallOrder[0];
    expect(removed).toBeLessThan(restored);
  });

  it('не восстанавливает, если фраза не распознана', async () => {
    (keyUidFromMnemonic as any).mockResolvedValue(null);

    await expect(resetLocalProfileAndRestore(PHRASE, 'NewPass1!')).rejects.toThrow(
      'seed phrase is not valid'
    );
    expect(deleteProfile).not.toHaveBeenCalled();
  });

  it('останавливается, если удаление не удалось', async () => {
    // Restoring after a failed delete would hit the same locked database, and the
    // screen would show a restore error instead of "the local copy was not removed".
    (deleteProfile as any).mockRejectedValue(new Error('keystore is in use'));

    await expect(resetLocalProfileAndRestore(PHRASE, 'NewPass1!')).rejects.toThrow(
      'keystore is in use'
    );
    expect(restoreAccountAndLogin).not.toHaveBeenCalled();
  });
});

/**
 * Switching networks.
 *
 * status-go opens its account database once per process, so a switch that does not close
 * it first keeps listing the previous network's profiles while the keystore root has
 * already moved — the profile is shown but cannot be opened. The list must come from the
 * reply of the switching command and from nowhere else.
 */
describe('switchNetwork', () => {
  const SEPOLIA_REPLY = {
    dataDir: '/data/sepolia',
    networkName: 'sepolia',
    chainId: 11155111,
    rpcUrl: 'https://rpc.sepolia.org',
    wakuFleet: 'status.test',
    isTestnet: true,
    accounts: [{ 'key-uid': 'key-uid-sepolia', name: 'Test' }],
  };

  beforeEach(() => {
    vi.clearAllMocks();
    (statusState as any).backendDataDir = '/data/mainnet';
    (statusState as any).accounts = [{ 'key-uid': 'key-uid-mainnet', name: 'Main' }];
    (statusState as any).networkName = 'mainnet';
  });

  it('заменяет список профилей списком выбранной сети', async () => {
    (invoke as any).mockResolvedValue(SEPOLIA_REPLY);

    await switchNetwork('sepolia');

    // The picker's own name goes to the backend; `testnet` would be refused there.
    expect(invoke).toHaveBeenCalledWith('switch_network', { network: 'sepolia' });
    expect(setAccounts).toHaveBeenCalledWith(SEPOLIA_REPLY.accounts);
    expect(setNetworkInfo).toHaveBeenCalledWith(
      'sepolia',
      'https://rpc.sepolia.org',
      'status.test',
      true,
      11155111
    );
    expect((statusState as any).backendDataDir).toBe('/data/sepolia');
  });

  it('оставляет прежнее состояние, когда переключение отказало', async () => {
    // An unpatched library is the realistic failure: it loads and runs, and only the
    // switch reports that it cannot reopen the database.
    (invoke as any).mockRejectedValue(new Error('this libstatus does not export CloseAccounts'));

    await expect(switchNetwork('sepolia')).rejects.toThrow('CloseAccounts');

    expect(setAccounts).not.toHaveBeenCalled();
    expect(setNetworkInfo).not.toHaveBeenCalled();
    expect((statusState as any).backendDataDir).toBe('/data/mainnet');
  });
});
