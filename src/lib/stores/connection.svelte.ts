/**
 * Backend connection lifecycle: node start, login, account creation.
 *
 * Connection state and the login flows live here; RPC provider setup is in
 * `rpcConfig` and the `/signals` socket in `ws`. The public API is re-exported
 * from `connectionStore.svelte`.
 */

import {
  statusState,
  setAccounts,
  setNetworkInfo,
  waitForLogin,
  waitForNodeStopped,
} from './statusStore.svelte';
import { invoke } from '@tauri-apps/api/core';
import { debug, info, error } from '$lib/utils/log';
import { formatError, errorTag } from '$lib/utils/errors';
import {
  startBackend,
  stopBackend,
  initializeApplication,
  loginAccount,
  createAccountAndLogin,
  startMessenger,
  logout as apiLogout,
} from '$lib/status/api';
import { ensureTestNetworkMode, getSettings } from '$lib/status/wallet';
import { configureWalletRpc } from './rpcConfig';
import { isWsOpen, openWs, closeWs } from './ws';

export const connectionState = $state({
  isConnecting: false,
  selectedNetwork: 'mainnet',
});

/**
 * Starts the backend, opens the WebSocket and loads the accounts.
 *
 * @param network - Network to start the backend on; omitted, the configured
 * default is used.
 */
export async function connect(network?: string) {
  info(`[boot] connect(network=${network ?? 'default'}) connected=${statusState.isConnected} connecting=${connectionState.isConnecting}`);
  if (statusState.isConnected || connectionState.isConnecting) return;

  if (statusState.backendRunning) {
    await disconnect();
  }

  connectionState.isConnecting = true;
  statusState.errorMsg = '';

  try {
    const backendInfo = await startBackend(network);
    // status-go runs in this process, so there is no port to keep.
    statusState.backendRunning = true;
    statusState.backendDataDir = backendInfo.dataDir;
    connectionState.selectedNetwork = backendInfo.networkName;

    await new Promise(resolve => setTimeout(resolve, 1500));

    const initData = await initializeApplication(
      statusState.backendDataDir,
      backendInfo.chainId
    );

    if (initData.accounts && initData.accounts.length > 0) {
      setAccounts(initData.accounts);
    } else {
      setAccounts([]);
    }

    setNetworkInfo(
      backendInfo.networkName,
      backendInfo.rpcUrl,
      backendInfo.wakuFleet,
      backendInfo.isTestnet,
      backendInfo.chainId
    );

    info('[boot] connect: InitializeApplication done, opening ws');
    await openWs();
    statusState.isConnected = true;
    info('[boot] connect: ws open, configuring wallet rpc');

    // Providers are written right after initialization, BEFORE login. status-go
    // caches RPC clients by chainID and never invalidates them, so a client
    // created earlier (by the messenger or a background refresher) will not
    // pick up new providers.
    //
    // Test network mode CANNOT be set here: `settings_*` registers in
    // initServices, i.e. after node start, and the node starts inside
    // LoginAccount. Mode switching happens in `login` and `createAccount` —
    // see `applyNetworkMode`.
    await configureWalletRpc();

    // Networks are registered in processSignal AFTER node.login through
    // ensureNetworksConfigured; otherwise LoginAccount overwrites the settings.

  } catch (e: any) {
    statusState.errorMsg = `${errorTag(e)}Connection failed: ${formatError(e)}`;
    statusState.isConnected = false;
    error(`[boot] connect failed: ${formatError(e)}`);
  } finally {
    connectionState.isConnecting = false;
    info('[boot] connect finished');
  }
}

/**
 * Restarts the backend on another network.
 *
 * @param network - Network to reconnect to.
 */
export async function changeNetwork(network: string) {
  await disconnect();
  await connect(network);
}

/**
 * Restarts the node once so the RPC clients are rebuilt.
 *
 * status-go creates and caches an RPC client on the first network access
 * (`internal/rpc/client.go`, getClientUsingCache) and does not invalidate the
 * cache until `StatusNode.Stop()`. The node starts inside loginAccount and its
 * wallet immediately polls balances, so the client is built before providers
 * are written. On a fresh profile (first login) that means the client is built
 * from the built-in providers, and balances keep failing until a restart.
 *
 * Order: logout → wait for node.stopped → login → providers → messenger. By
 * then the providers are already in the DB, and InitEmbeddedNetworks keeps user
 * providers on start (`pkg/services/networks/network.go`), so the new client is
 * built with them.
 *
 * @param password - Profile password, reused for the second login.
 * @param keyUid - Key uid of the account being logged in.
 * @returns `true` once the restart finished; `false` when the port or key uid
 * is missing.
 * @remarks
 * Restarting happens once only: a second pass would not change the outcome, and
 * a login loop is not acceptable.
 */
async function restartNodeForProviders(password: string, keyUid: string): Promise<boolean> {
  if (!statusState.backendRunning || !keyUid) return false;

  debug('[login] провайдеры записаны после старта ноды — перезапускаю ноду');

  // Start waiting BEFORE logout: the node.stopped signal can arrive before
  // control returns from the call, and a wait set up afterwards would run for
  // the full 15s. The node stops asynchronously; logging in before it stops
  // returns the same cached client.
  const stopped = waitForNodeStopped(15000);
  await apiLogout();
  await stopped;

  // A login error is not swallowed: without the node there is nothing to
  // continue with, so let the caller surface it.
  await traceSecret('login', password);
  await loginAccount(password, keyUid);
  await waitForLoginReady(30000);

  await configureWalletRpc();
  await startMessenger();
  return true;
}

/**
 * Brings the network mode (mainnet / testnet) in line with the launch config.
 *
 * `STAURI_NETWORK` is Rust configuration — the primary network, waku fleet and
 * data directory. status-go knows nothing about it; it has its own
 * `test-networks-enabled?` flag, and `networks.GetActiveNetworks()` filters
 * networks by it. Until the flag is set, a profile launched as "sepolia" still
 * computes balances over the mainnet chains (1, 10, 56, 8453, 42161) and the
 * user sees zeros instead of Sepolia assets.
 *
 * @returns `true` when the flag had to be rewritten.
 * @remarks
 * Runs after login, not in `connect`: `settings_*` registers in initServices,
 * i.e. after node start, and the node starts inside `loginAccount`. Changing
 * the mode changes the active network set, and the backend RPC clients are
 * cached by chainID (see `restartNodeForProviders`), so the caller must restart
 * the node — otherwise balances keep coming from the previous networks.
 */
async function applyNetworkMode(): Promise<boolean> {
  try {
    const changed = await ensureTestNetworkMode(statusState.isTestnet);
    if (changed) {
      debug(
        `[connect] test networks mode switched to ${statusState.isTestnet ? 'on' : 'off'}`
      );
    }
    return changed;
  } catch (e) {
    // Do not fail the login: the wallet shows whatever the backend computes,
    // and the message explains why the numbers look wrong.
    statusState.errorMsg = `Failed to set network mode: ${formatError(e)}`;
    console.error('[connect] ensureTestNetworkMode failed:', e);
    return false;
  }
}

/**
 * Logs into the account.
 *
 * @param password - Profile password used to unlock the key.
 * @param keyUid - Key uid of the account.
 * @remarks
 * Order matters: RPC providers are written (`configureWalletRpc`) before the
 * messenger starts. status-go caches RPC clients by chainID and never
 * invalidates them, so a messenger started earlier would create clients with
 * the previous (dead) URLs and balances would stay in `hasError`.
 *
 * If providers had to be written, the client may have been built before them —
 * typical on a fresh profile's first login — and the node is restarted once;
 * see `restartNodeForProviders`.
 */
export async function login(password: string, keyUid: string) {
  if (!statusState.backendRunning) return;
  if (!isWsOpen()) await openWs();

  await traceSecret('login', password);
  await loginAccount(password, keyUid);
  await waitForLoginReady(30000);

  // The network mode comes before the providers: it decides which networks they
  // are written for.
  const modeChanged = await applyNetworkMode();

  const { wroteProviders } = await configureWalletRpc();
  if ((modeChanged || wroteProviders) && (await restartNodeForProviders(password, keyUid))) return;

  await startMessenger();
}

/**
 * Creates a new account and logs it in.
 *
 * @param password - Profile password for the new account.
 * @remarks
 * This is always a fresh profile: no providers are in the DB yet, so
 * `configureWalletRpc` will certainly write something, while the RPC clients
 * have already been built from the built-in providers. A node restart is the
 * normal path here, not an exception — see `restartNodeForProviders`.
 */
export async function createAccount(password: string) {
  // Length only: the password itself never reaches the log.
  info(`[boot] createAccount: backendRunning=${statusState.backendRunning} passwordLength=${password.length}`);
  if (!statusState.backendRunning) {
    error('[boot] createAccount: no backend port, nothing sent');
    return;
  }
  if (!isWsOpen()) await openWs();
  await traceSecret('create', password);
  info('[boot] createAccount: calling CreateAccountAndLogin');
  const createResult = await createAccountAndLogin(statusState.backendDataDir, password);
  if (createResult?.error) throw new Error(createResult.error);
  info('[boot] createAccount: CreateAccountAndLogin ok, waiting for node.login');
  // One path on every platform: status-go runs in this process and delivers
  // `node.login` through the signal callback.
  await waitForLogin(30000);

  const keyUid = statusState.accountKeyUid;
  const modeChanged = await applyNetworkMode();
  const { wroteProviders } = await configureWalletRpc();
  if ((modeChanged || wroteProviders) && (await restartNodeForProviders(password, keyUid))) return;

  await startMessenger();
}

/** Waits for the `node.login` signal. */
async function waitForLoginReady(timeoutMs: number): Promise<void> {
  return waitForLogin(timeoutMs);
}

/** Test trace: one line in bridge-trace.log through status_call. */
async function traceNote(note: unknown): Promise<void> {
  try {
    await invoke('status_call', { endpoint: 'TraceNote', body: JSON.stringify(note) });
  } catch {
    /* tracing must not break the login */
  }
}

/**
 * Test trace: password length and a SHA-256 prefix in bridge-trace.log.
 *
 * @param kind - Trace kind, for example `login` or `create`.
 * @param password - Profile password; only its length and hash prefix are
 * written, never the password itself.
 */
async function traceSecret(kind: string, password: string): Promise<void> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(password));
    const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
    await traceNote({ kind, len: password.length, sha256_16: hex.slice(0, 16) });
  } catch {
    /* tracing must not break the login */
  }
}


/**
 * Closes the WebSocket and stops the backend.
 */
export async function disconnect() {
  await closeWs();
  if (statusState.backendRunning) {
    try { await stopBackend(); } catch {
      /* a failed stop is not critical: the next connect starts a new backend */
    }
  }
  await new Promise(r => setTimeout(r, 500));
  statusState.isConnected = false;
  statusState.backendRunning = false;
}
