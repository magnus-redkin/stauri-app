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
import { debug, info, error, warn } from '$lib/utils/log';
import { formatError, errorTag } from '$lib/utils/errors';
import {
  startBackend,
  stopBackend,
  initializeApplication,
  loginAccount,
  createAccountAndLogin,
  restoreAccountAndLogin,
  keyUidFromMnemonic,
  deleteProfile,
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

/** Reply of the `switch_network` command; the same fields `start_backend` returns. */
interface SwitchNetworkReply {
  dataDir: string;
  networkName: string;
  chainId: number;
  rpcUrl: string;
  wakuFleet: string;
  isTestnet: boolean;
  /** Profiles found in the chosen network's directory. */
  accounts: Array<Record<string, unknown>>;
}

/**
 * Switches the network in place and replaces the profile list with the new one.
 *
 * @param network - Network preset as the picker names it: `mainnet`, `sepolia`,
 * `holesky`.
 * @remarks
 * The Rust side closes status-go's account database and re-initialises it on the chosen
 * directory, so the accounts returned here are the ones stored there. Without that step
 * the process keeps answering from the database it opened at start-up — that is the bug
 * this replaces. A rejection means nothing was switched: the network is still the old
 * one, and the caller keeps showing its profiles.
 */
export async function switchNetwork(network: string): Promise<void> {
  info(`[boot] switchNetwork(${network})`);
  const reply = await invoke<SwitchNetworkReply>('switch_network', { network });

  statusState.backendDataDir = reply.dataDir;
  statusState.backendRunning = true;
  connectionState.selectedNetwork = reply.networkName;
  setAccounts(reply.accounts ?? []);
  setNetworkInfo(
    reply.networkName,
    reply.rpcUrl,
    reply.wakuFleet,
    reply.isTestnet,
    reply.chainId
  );

  info(`[boot] switchNetwork(${network}) ok: ${reply.accounts?.length ?? 0} profiles`);
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

/**
 * Turns a restore failure into something the user can act on.
 *
 * @param reason - Message status-go reported in the `node.login` signal.
 * @returns A message for the restore screen.
 * @remarks
 * Both status-go messages mean the same thing: the profile this phrase belongs to is
 * already in this data directory, so the restore is not a restore but a second copy.
 * status-go refuses it, and rightly so — the databases are encrypted with a key that
 * only the existing password unwraps. The screen promises "set a new password", which
 * reads as if it could replace the old one; it cannot, and saying so is the whole point
 * of this mapping. Anything else is passed through unchanged.
 */
function restoreFailureHint(reason: string): string {
  if (reason.includes('keypair already added')) {
    return 'This profile is already on this device. Enter its password to log in instead of restoring it.';
  }
  if (reason.includes('invalid key-encryption key')) {
    return 'This profile is already on this device under a different password. Log in with the password you chose when the profile was created.';
  }
  return reason;
}

/**
 * Raised when the phrase belongs to a profile that is already on this device but the
 * password does not open it.
 *
 * @remarks
 * A separate type rather than a message: the screen offers a destructive action on it
 * ("remove the local copy and restore"), and matching on text would make that button
 * appear for unrelated failures.
 */
export class LocalProfileLockedError extends Error {
  /** Profile that is on the device and could not be opened. */
  readonly keyUid: string;

  constructor(keyUid: string) {
    super('The profile on this device is protected by another password');
    this.name = 'LocalProfileLockedError';
    this.keyUid = keyUid;
  }
}

/** How the restore screen ended: opened an existing profile, or created a new one. */
export type RestoreOutcome = 'opened' | 'restored';

/**
 * Whether a failed login of a local profile means its password is wrong.
 *
 * @param reason - Message status-go reported in the `node.login` signal.
 * @returns `true` for the wrong-password outcomes.
 * @remarks
 * Measured against the real library: a wrong password answers
 * `failed to open database: [keystore] incorrect password provided`, and a database
 * whose key cannot be unwrapped answers `envelope: invalid key-encryption key`.
 *
 * The distinction is what keeps the reset offer honest. It is destructive, so it must
 * appear for a forgotten password and not for an unrelated failure — a stopped node, a
 * broken library or a network problem would otherwise be answered with "delete your
 * local copy", which would not help and could not be undone.
 */
function isWrongPassword(reason: string): boolean {
  return (
    reason.includes('incorrect password') ||
    reason.includes('invalid key-encryption key')
  );
}

/**
 * Opens the profile of a seed phrase, restoring it only when it is not here yet.
 *
 * @param mnemonic - The twelve words, in order.
 * @param password - Password of the local database.
 * @returns `opened` when an existing profile was logged into, `restored` when the
 *   profile was created from the phrase on this device.
 *
 * @remarks
 * The phrase identifies the profile: the same words always derive the same key uid, so
 * a match with a profile in `statusState.accounts` means it is already here and the way
 * in is a login, not a restore. Calling `RestoreAccountAndLogin` in that case is what
 * produced `keypair already added`: it creates the account, and an existing profile
 * cannot be created twice.
 *
 * A profile that is here is encrypted with the password it was created with. The phrase
 * gives the wallet and chat keys, not the key that opens the local database, so a
 * different password cannot open it — that is why [LocalProfileLockedError] exists
 * instead of silently retrying.
 *
 * @throws LocalProfileLockedError when the profile is here and the password does not
 *   open it; the caller may offer [resetLocalProfileAndRestore].
 */
export async function restoreAccount(
  mnemonic: string,
  password: string
): Promise<RestoreOutcome> {
  const words = mnemonic.trim().split(/\s+/);
  // Length only: the phrase itself never reaches the log.
  info(`[boot] restoreAccount: words=${words.length} passwordLength=${password.length}`);
  if (!statusState.backendRunning) {
    error('[boot] restoreAccount: backend is not running, nothing sent');
    return 'restored';
  }
  if (words.length !== 12) throw new Error('A seed phrase has twelve words');
  if (!isWsOpen()) await openWs();

  // Which profile this phrase is. Without it the two cases below cannot be told apart.
  const phraseKeyUid = await keyUidFromMnemonic(mnemonic);
  const local = phraseKeyUid
    ? statusState.accounts.find((a: any) => a?.['key-uid'] === phraseKeyUid)
    : undefined;

  if (local) {
    info('[boot] restoreAccount: profile is already on this device, logging in');
    await traceSecret('restore-open', password);
    try {
      await loginAccount(password, phraseKeyUid!);
      await waitForLogin(30000);
    } catch (e) {
      // status-go reports a wrong password through the `node.login` signal; the reason
      // is in the message now that `waitForLogin` rejects with it.
      const reason = formatError(e);
      warn(`[boot] restoreAccount: local profile did not open: ${reason}`);
      if (isWrongPassword(reason)) throw new LocalProfileLockedError(phraseKeyUid!);
      // Anything else is not a password problem, and offering to delete the local copy
      // for it would destroy data without solving anything.
      throw new Error(reason);
    }
    await finishSignIn(password);
    return 'opened';
  }

  await traceSecret('restore', password);
  const result = await restoreAccountAndLogin(statusState.backendDataDir, password, mnemonic);
  if (result?.error) throw new Error(result.error);
  info('[boot] restoreAccount: RestoreAccountAndLogin ok, waiting for node.login');
  try {
    await waitForLogin(30000);
  } catch (e) {
    const reason = formatError(e);
    warn(`[boot] restoreAccount failed: ${reason}`);
    throw new Error(restoreFailureHint(reason));
  }

  await finishSignIn(password);
  return 'restored';
}

/**
 * Removes the local copy of a profile and restores it from its phrase.
 *
 * @param mnemonic - The twelve words of the profile to bring back.
 * @param password - New password for the fresh local database.
 * @returns `restored`.
 *
 * @remarks
 * This is the only way to get back into a profile whose local password is forgotten:
 * the phrase cannot open an existing database, but it can create a new one with the
 * same keys. The wallet and the profile itself come back, since they derive from the
 * phrase; the local message history and settings do not, and no code path can bring
 * them back.
 *
 * The caller asks for confirmation first — the deletion cannot be undone.
 *
 * @throws Error when the phrase does not identify a profile, or when its local copy
 *   cannot be removed.
 */
export async function resetLocalProfileAndRestore(
  mnemonic: string,
  password: string
): Promise<RestoreOutcome> {
  if (!statusState.backendRunning) {
    error('[boot] resetLocalProfileAndRestore: backend is not running, nothing sent');
    return 'restored';
  }
  const keyUid = await keyUidFromMnemonic(mnemonic);
  if (!keyUid) throw new Error('The seed phrase is not valid');

  info('[boot] resetLocalProfileAndRestore: deleting the local copy');
  // The keystore lives under the profile directory, one folder per profile; `DeleteMultiaccount`
  // removes exactly that folder together with the databases and the wrapped key.
  const keyStoreDir = `${statusState.backendDataDir}/keystore/${keyUid}`;
  await deleteProfile(keyUid, keyStoreDir);

  // The account list still contains the deleted profile: without this the next
  // `restoreAccount` would find it and try to log in again.
  setAccounts(statusState.accounts.filter((a: any) => a?.['key-uid'] !== keyUid));

  return restoreAccount(mnemonic, password);
}

/**
 * Shared tail of every sign-in: network mode, providers, messenger.
 *
 * @param password - Password used for this session, needed by a node restart.
 * @remarks
 * Kept in one place because all three entry points (login, create, restore) ended with
 * the same three steps, and they drifted apart once already.
 */
async function finishSignIn(password: string): Promise<void> {
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
