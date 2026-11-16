import { SvelteSet } from 'svelte/reactivity';
import type { StatusEvent, NodeLoginEvent, MessagesNewEvent, GenericEvent } from '$lib/status/types';
import { logout as apiLogout } from '$lib/status/api';
import { info } from '$lib/utils/log';

export const statusState = $state({
  isConnected: false,
  isConnecting: false,
  isLoggedIn: false,
  accountKeyUid: '',
  publicKey: '',
  /** Compressed `zQ3…` key (base58btc, multicodec) that a profile link is built from. */
  compressedKey: '',
  alias: '',
  chainId: 1,
  /** True while status-go runs in this process (set by connect, cleared on disconnect). */
  backendRunning: false,
  backendDataDir: '',
  networkName: 'mainnet',
  rpcUrl: '',
  wakuFleet: 'status.prod',
  isTestnet: false,
  accounts: [] as any[],
  events: [] as StatusEvent[],
  errorMsg: '',
  /// Temporary bridge marker (B.2): which status-go calls went through.
  probe: '',
  pendingRequestsCount: 0,
  lastMessageSignal: 0,
  /**
   * Chats that delivered messages since the last signal was processed.
   * Lets the list skip a full reload for messages from a chat it does not contain (for instance,
   * a channel that was hidden).
   */
  pendingChatIds: new SvelteSet<string>(),
  isSeedSaved: false,
});

let loginResolver: (() => void) | null = null;
let loginTimeoutId: ReturnType<typeof setTimeout> | null = null;
let stoppedResolver: (() => void) | null = null;
let stoppedTimeoutId: ReturnType<typeof setTimeout> | null = null;

/**
 * One-line summary of a signal for the trace: counts and flags only.
 *
 * @param parsed - Signal as it arrived from status-go.
 * @returns Text to log, or an empty string when the type needs no summary.
 *
 * @remarks
 * No message text, public keys or addresses are included: the log is written to
 * disk and shared when something goes wrong. The chat id is left out too, but
 * its presence is reported, which is enough to tell a contact request from a
 * message in an existing chat.
 */
function signalSummary(parsed: StatusEvent): string {
  if (parsed.type === 'messages.new') {
    const messages: any[] = (parsed as MessagesNewEvent).event?.messages ?? [];
    const request = messages[0] ?? {};
    const fields = Object.keys(messages[0] ?? {}).join(',');
    return `count=${messages.length} hasChatId=${messages.some((m) => !!m?.chatId)} contactRequest=${request.contactRequestState ?? 'n/a'} fields=[${fields}]`;
  }
  if (parsed.type === 'waku.connection.status.change') {
    const event = (parsed as GenericEvent).event ?? {};
    return `state=${event.state ?? '?'} online=${event.isOnline ?? '?'}`;
  }
  if (parsed.type === 'envelope.sent' || parsed.type === 'history.request.completed') {
    return `count=${(parsed as GenericEvent).event?.messages?.length ?? (parsed as GenericEvent).event?.count ?? 0}`;
  }
  return '';
}

export function processSignal(rawJson: string) {
  if (!rawJson) return;
  try {
    const parsed = JSON.parse(rawJson) as StatusEvent;
    // Summary only (see signalSummary): the payload can carry profile data.
    const summary = signalSummary(parsed);
    info(`[signal] ${parsed.type ?? 'unknown'}${summary ? ` ${summary}` : ''}`);
    statusState.events.push(parsed);
    if (statusState.events.length > 100) statusState.events.shift();

    if (parsed.type === 'node.login') {
      const loginEvent = parsed as NodeLoginEvent;
      if (loginEvent.event?.error) {
        statusState.errorMsg = `Login failed: ${loginEvent.event.error}`;
        return;
      }
      statusState.accountKeyUid = loginEvent.event?.settings?.['key-uid'] || statusState.accountKeyUid;
      statusState.publicKey = loginEvent.event?.settings?.['public-key'] || statusState.publicKey;
      statusState.compressedKey = loginEvent.event?.settings?.['compressedKey'] || statusState.compressedKey;
      statusState.alias = loginEvent.event?.settings?.['alias'] || statusState.alias;
      statusState.isLoggedIn = true;
      statusState.errorMsg = '';

      if (loginResolver) {
        if (loginTimeoutId) clearTimeout(loginTimeoutId);
        loginResolver();
        loginResolver = null;
        loginTimeoutId = null;
      }

      // startMessenger is deliberately NOT called here.
      // status-go RPC clients are cached per chainID and not invalidated when providers change, so
      // providers must be set before the first network call. The messenger starts from
      // connectionStore.login() after configureWalletRpc().
    }

    if (parsed.type === 'node.stopped') {
      // The node stopped: `isLoggedIn` no longer reflects reality. Without this a repeated
      // `waitForLogin()` would resolve at once on the stale flag, and a node restart would
      // "succeed" without waiting for anything.
      statusState.isLoggedIn = false;
      if (stoppedResolver) {
        if (stoppedTimeoutId) clearTimeout(stoppedTimeoutId);
        stoppedResolver();
        stoppedResolver = null;
        stoppedTimeoutId = null;
      }
    }

    if (parsed.type === 'messages.new') {
      statusState.lastMessageSignal++;
      for (const m of parsed.event?.messages ?? []) {
        if (m?.chatId) statusState.pendingChatIds.add(m.chatId);
      }
    }
  } catch (e) {
    console.warn("Failed to parse signal:", rawJson);
  }
}

/**
 * Waits for a `node.stopped` signal.
 *
 * A node restart needs it because logout stops the node asynchronously and signing in again is only
 * possible once it has really stopped; otherwise a second `loginAccount` reaches a live node while
 * `isLoggedIn` keeps its old value, making the restart a no-op.
 *
 * @param timeoutMs - How long to wait before giving up.
 * @returns Resolves on the signal or on timeout.
 * @remarks
 * The timeout is not an error: a missing signal is better tolerated than blocking sign-in forever.
 */
export function waitForNodeStopped(timeoutMs = 15000): Promise<void> {
  return new Promise((resolve) => {
    stoppedResolver = resolve;
    stoppedTimeoutId = setTimeout(() => {
      if (stoppedResolver === resolve) {
        stoppedResolver = null;
        stoppedTimeoutId = null;
        console.warn('[status] node.stopped не пришёл за отведённое время');
      }
      resolve();
    }, timeoutMs);
  });
}

export function waitForLogin(timeoutMs = 30000): Promise<void> {
  return new Promise((resolve, reject) => {
    if (statusState.isLoggedIn) return resolve();
    loginResolver = resolve;
    loginTimeoutId = setTimeout(() => {
      if (loginResolver === resolve) {
        loginResolver = null;
        loginTimeoutId = null;
        reject(new Error("Login timeout: no response from backend"));
      }
    }, timeoutMs);
  });
}

export function setAccounts(accounts: any[]) {
  statusState.accounts = accounts;
}

export function setNetworkInfo(
  networkName: string, rpcUrl: string, wakuFleet: string, isTestnet: boolean, chainId: number
) {
  statusState.networkName = networkName;
  statusState.rpcUrl = rpcUrl;
  statusState.wakuFleet = wakuFleet;
  statusState.isTestnet = isTestnet;
  statusState.chainId = chainId;
}

export function setPendingRequestsCount(count: number) {
  statusState.pendingRequestsCount = count;
}

export function setSeedSaved(saved: boolean) {
  statusState.isSeedSaved = saved;
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem('stauri_seed_saved', saved ? 'true' : 'false');
  }
}

export async function logout() {
  if (!statusState.backendRunning) return;
  try {
    await apiLogout();
  } catch (e: any) {
    console.warn("Logout API call failed:", e);
  }
  statusState.isLoggedIn = false;
  statusState.accountKeyUid = '';
  statusState.publicKey = '';
  statusState.compressedKey = '';
  statusState.alias = '';
  statusState.events = [];
  statusState.errorMsg = '';
  statusState.pendingRequestsCount = 0;
  statusState.lastMessageSignal = 0;
  statusState.pendingChatIds.clear();
}

export function resetState() {
  statusState.isConnected = false;
  statusState.isConnecting = false;
  statusState.isLoggedIn = false;
  statusState.accountKeyUid = '';
  statusState.publicKey = '';
  statusState.compressedKey = '';
  statusState.alias = '';
  statusState.events = [];
  statusState.backendRunning = false;
  statusState.backendDataDir = '';
  statusState.errorMsg = '';
  statusState.accounts = [];
  statusState.networkName = 'mainnet';
  statusState.rpcUrl = '';
  statusState.wakuFleet = 'status.prod';
  statusState.isTestnet = false;
  statusState.chainId = 1;
  statusState.pendingRequestsCount = 0;
  statusState.lastMessageSignal = 0;
  statusState.pendingChatIds.clear();
  statusState.isSeedSaved = false;
}
