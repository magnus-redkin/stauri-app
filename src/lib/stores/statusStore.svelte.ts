import { SvelteSet } from 'svelte/reactivity';
import type { StatusEvent, NodeLoginEvent, MessagesNewEvent, GenericEvent } from '$lib/status/types';
import { logout as apiLogout } from '$lib/status/api';
import { info } from '$lib/utils/log';
import { rememberProfileName } from '$lib/stores/profileNames';

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
  /**
   * Contact records received in `messages.new` signals, waiting to be applied.
   *
   * A rename comes from the other side as a contact update, not as a chat message, and
   * status-go delivers it in the same `messages.new` signal under `contacts`. They are
   * queued rather than held as the latest value: two updates in one flush (two renamed
   * contacts, for instance) would otherwise overwrite each other and one rename would be
   * lost. The queue is drained by an effect in `+page.svelte`.
   */
  pendingContactUpdates: [] as any[],
  isSeedSaved: false,
});

/**
 * Pending `waitForLogin`, with both outcomes.
 *
 * The rejection is needed: status-go reports a failed login as a `node.login` signal
 * carrying `event.error`, not as a failed call. Without a way to settle the promise
 * from that signal the caller waited out the full timeout and reported "no response
 * from backend", hiding the actual reason.
 */
let loginPending: { resolve: () => void; reject: (e: Error) => void } | null = null;
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
    const event = (parsed as MessagesNewEvent).event ?? ({} as MessagesNewEvent['event']);
    const messages: any[] = event.messages ?? [];
    const request = messages[0] ?? {};
    const fields = Object.keys(messages[0] ?? {}).join(',');
    // A contact update carries no message, only the record: without the names here a
    // rename and an empty signal look the same in the trace.
    const contacts: any[] = event.contacts ?? [];
    const names = contacts.map((c: any) => c?.displayName || '-').join(',');
    return (
      `count=${messages.length} hasChatId=${messages.some((m) => !!m?.chatId)} ` +
      `contactRequest=${request.contactRequestState ?? 'n/a'} fields=[${fields}]` +
      (contacts.length ? ` contacts=${contacts.length} names=[${names}]` : '')
    );
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
        // Settle the pending wait with the real reason. Returning without this left
        // the caller waiting out the whole timeout and reporting "no response from
        // backend" 30 seconds later, hiding what status-go actually said.
        if (loginPending) {
          if (loginTimeoutId) clearTimeout(loginTimeoutId);
          const pending = loginPending;
          loginPending = null;
          loginTimeoutId = null;
          pending.reject(new Error(loginEvent.event.error));
        }
        return;
      }
      statusState.accountKeyUid = loginEvent.event?.settings?.['key-uid'] || statusState.accountKeyUid;
      statusState.publicKey = loginEvent.event?.settings?.['public-key'] || statusState.publicKey;
      statusState.compressedKey = loginEvent.event?.settings?.['compressedKey'] || statusState.compressedKey;
      // `display-name` is the name the user chose; `alias` is the three-word name
      // status-go generates from the public key ("Perfumed Fearless Marten"). Reading
      // the alias here would show a name the user never set, and the chosen one would
      // survive only until the next restart, because `EditProfile` writes it to state
      // directly. The generated alias is the fallback for a profile with no name.
      statusState.alias =
        loginEvent.event?.settings?.['display-name'] ||
        loginEvent.event?.settings?.['alias'] ||
        statusState.alias;
      // The entry screen runs before any login, so it cannot read settings: the name is
      // cached here, the moment the application knows the real value.
      rememberProfileName(statusState.accountKeyUid, statusState.alias);
      // The phrase is the same on every login, so a profile that was told to have
      // saved it keeps saying so after a restart instead of warning again.
      statusState.isSeedSaved = readSeedSaved(statusState.accountKeyUid);
      statusState.isLoggedIn = true;
      statusState.errorMsg = '';

      if (loginPending) {
        if (loginTimeoutId) clearTimeout(loginTimeoutId);
        const pending = loginPending;
        loginPending = null;
        loginTimeoutId = null;
        pending.resolve();
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

      // A contact update travels in the same signal but not as a message, so the
      // `messages` loop above skips it. Queueing the records here means the chat list
      // can show a rename from the other side at once, instead of at the next poll.
      // The names are already in the trace line (see `signalSummary`).
      const contacts = (parsed as MessagesNewEvent).event?.contacts ?? [];
      if (contacts.length > 0) {
        statusState.pendingContactUpdates.push(...contacts);
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
    loginPending = { resolve, reject };
    loginTimeoutId = setTimeout(() => {
      if (loginPending?.resolve === resolve) {
        loginPending = null;
        loginTimeoutId = null;
        reject(new Error('Login timeout: no response from backend'));
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

/**
 * `localStorage` key for the "seed phrase written down" flag of a profile.
 *
 * Keyed by key-uid: several profiles can share one installation, and a phrase
 * confirmed for one says nothing about another.
 *
 * @param keyUid - Profile identifier from settings.
 */
function seedSavedKey(keyUid: string): string {
  return `stauri_seed_saved:${keyUid}`;
}

/** Whether the phrase of the signed-in profile was confirmed, per `localStorage`. */
function readSeedSaved(keyUid: string): boolean {
  if (typeof localStorage === 'undefined' || !keyUid) return false;
  try {
    return localStorage.getItem(seedSavedKey(keyUid)) === 'true';
  } catch {
    return false;
  }
}

export function setSeedSaved(saved: boolean) {
  statusState.isSeedSaved = saved;
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(seedSavedKey(statusState.accountKeyUid), saved ? 'true' : 'false');
  } catch {
    // Storage unavailable: the flag then lives only for this session.
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
  statusState.pendingContactUpdates = [];
  statusState.isSeedSaved = false;
}
