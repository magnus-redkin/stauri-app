import { statusState } from './statusStore.svelte';
import { SvelteMap, SvelteSet } from 'svelte/reactivity';
import { debug, info, warn } from '$lib/utils/log';
import {
  getChats,
  getContacts,
  sendContactRequest,
  acceptContactRequest as acceptContactRequestRpc,
  declineContactRequest as declineContactRequestRpc,
  markChatRead,
  getCommunities,
  fetchCommunity,
  communityChannels,
  communityChatId,
  communityIdFromInvite,
  channelIdFromInvite,
  parseChannelInvite,
  checkPermissionsToJoinCommunity,
  generateJoiningRequestsForSigning,
  signJoinRequestData,
  requestToJoinCommunity,
  spectateCommunity,
  leaveCommunity,
  deactivateChat,
  isCommunityChat,
  isDirectMessage,
} from '$lib/status/messaging';
import {
  createChannel,
  validateChannelInput,
  type CreateChannelParams,
} from '$lib/status/akk';
import { getDisplayName } from '$lib/utils/user';
import { isMutual } from '$lib/status/contactState';
import { scenarioLog, short } from '$lib/utils/scenario';
import { parseKind } from '$lib/status/channelKind';
import { ROLE_OWNER } from '$lib/status/channelRights';
import { loadOpenedChannels, markChannelOpened } from '$lib/status/openedChannels';
import { feedChatItems } from './feedsStore.svelte';
import { formatError } from '$lib/utils/errors';
import type { ChatItem } from '$lib/sections/chat/ChatLeft.svelte';
import type { Community, CommunityChat } from '$lib/status/types';

export const chatsState = $state({
  items: [] as ChatItem[],
  contacts: [] as any[],
  communities: [] as Community[],
  selected: null as ChatItem | null,
  loaded: false,
  isLoading: false,
  /** Join in progress; blocks repeat clicks. */
  isJoining: false,
  /** Error from the last join attempt, shown in the dialog. */
  joinError: '',
  /** What the right panel shows: the conversation or one of the left-panel screens. */
  rightPanel: 'chat' as RightPanel,
});

/** Right-panel modes of the chat section. */
export type RightPanel = 'chat' | 'contacts' | 'contactInvite' | 'joinInvite' | 'newChannel';

/**
 * Outcome of connecting to a community.
 *
 * `joined` arrives only after the owner accepts and is never returned today, because the join
 * request is processed asynchronously. `requested` means the request was sent and awaits an
 * answer, `spectated` that the community is readable without joining, and `failed` that the
 * reason is in `error`.
 */
export type JoinResult =
  | { status: 'joined'; name: string }
  | { status: 'requested'; name: string }
  | { status: 'spectated'; name: string }
  | { status: 'contact'; name: string }
  | { status: 'failed'; error: string };

/**
 * Builds the chat list for the left panel.
 *
 * Only what the user deliberately keeps at hand gets in: direct messages (1-1) always, and
 * community channels only when status-go reports them active (`active`). Joining makes a channel
 * active; removing it from the list calls `deactivateChat`.
 *
 * @remarks
 * `spectateCommunity` creates `Chat` rows for every channel of a community, so messages arrive
 * and filters exist. Taking those rows for the list would turn the panel into a list of
 * communities, where ten channels of one community push direct messages aside. The rows
 * themselves stay usable: messages are still read and a channel still opens from the catalog.
 */
function buildItems(
  previews: any[],
  contacts: any[],
  communities: Community[]
): ChatItem[] {
  // A request still waits for an answer only while the contact is not accepted. After Accept the
  // chat preview may keep reporting the old state (active=false, contactRequestState=1) for a few
  // seconds; without this check the chat would stay "pending" forever.
  const isStillPending = (chat: any) => {
    const contact = contacts.find((ct: any) => ct.id === chat.id);
    if (contact && isMutual(contact)) return false;
    return chat.active === false && chat.lastMessage?.contactRequestState === 1;
  };

  const nameFor = (chat: any) => {
    const contact = contacts.find((ct: any) => ct.id === chat.id);
    return contact ? getDisplayName(contact) : getDisplayName(chat);
  };

  // Chat with oneself. status-go creates it when a request was sent to one's own key (a typo or
  // someone else's invite carrying our profile). It is useless in the list and looks like a
  // nameless contact: `0x0498b7…`.
  const ownKey = statusState.publicKey;

  // Channel metadata (name, category, post permission) comes from the communities; membership in
  // the list comes from the previews, so a channel is listed only while status-go considers it
  // active. That way `deactivateChat` removes it at once and it cannot come back on the next load.
  const channelMeta = new SvelteMap<string, CommunityChat & { owned: boolean }>();
  for (const channel of communityChannels(communities)) {
    const community = communities.find((c) => c.id === channel.communityId);
    channelMeta.set(channel.id, { ...channel, owned: community?.memberRole === ROLE_OWNER });
  }

  const items: ChatItem[] = [];
  const openedChannels = loadOpenedChannels();
  // "By date": time of the last message, else the chat's own time (ms).
  function activityTs(chat: any): number {
    return Number(chat.lastMessage?.timestamp ?? chat.timestamp ?? 0) * 1000;
  }
  for (const chat of previews) {
    if (ownKey && String(chat.id).toLowerCase() === ownKey.toLowerCase()) continue;
    // An inactive chat was removed (`deactivateChat`) and must not return to the list. The
    // exception is an incoming contact request: it also arrives inactive, yet has to be shown so
    // it can be accepted.
    const pendingContactRequest = chat.lastMessage?.contactRequestState === 1;
    if (chat.active === false && !pendingContactRequest) {
      // Inactive without a request means removed; log it so hidden chats stay visible in logs.
      if (!isCommunityChat(chat) && !isDirectMessage(chat)) continue;
      scenarioLog('reply-sync', 'hidden-inactive', { chat: short(chat.id), type: chat.chatType }, 'info');
      continue;
    }
    if (pendingContactRequest) {
      scenarioLog('reply-sync', 'incoming-request', { chat: short(chat.id), type: chat.chatType }, 'info');
    }

    if (isCommunityChat(chat)) {
      const meta = channelMeta.get(chat.id);
      // Show a foreign channel only after it was opened from a link. Spectating makes every channel
      // of a foreign community active, so without this check all of them would be listed.
      if (!meta?.owned && !openedChannels.has(chat.id)) continue;
      items.push({
        id: chat.id,
        // Own ACC channel (community owner): the community name is the channel name and the
        // service `general` stays hidden. Foreign channel: its own channel name, with the community
        // name as a suffix, otherwise every row of that community would look alike.
        name: meta?.owned
          ? meta?.communityName || chat.name
   : `${chat.name} · ${meta?.communityName ?? ''}`.replace(/ · $/, ''),
        lastMessage: chat.lastMessage?.text || '',
        sortTs: activityTs(chat),
 type: 'community',
        communityId: chat.communityId || meta?.communityId || undefined,
        communityName: meta?.communityName,
        categoryId: chat.categoryId || meta?.categoryID || undefined,
 canPost: meta?.canPost,
        kind: parseKind(meta?.description).kind,
        unreadCount: chat.unviewedMessagesCount || 0,
      });
      continue;
    }

    items.push({
      id: chat.id,
      name: nameFor(chat),
      lastMessage: chat.lastMessage?.text || '',
      sortTs: activityTs(chat),
      type: isDirectMessage(chat) ? 'direct' : 'channel',
      categoryId: chat.categoryId || undefined,
      unreadCount: chat.unviewedMessagesCount || 0,
      isPendingRequest: isStillPending(chat),
    });
  }

  // One id — one row: a duplicate must not become a second item, or removing one row would drop
  // both.
  const seen = new SvelteSet<string>();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

/**
 * Loads chats, communities and contacts (the latter for display names).
 *
 * @param force - when true, ignores the `loaded` flag.
 * @remarks
 * Callers are many and each pulls three RPCs. `messages.new` signals arrive in bursts, so without
 * protection they cascade into identical requests. While a load is running, `force` does not start
 * a second one: it only marks that another pass is needed once the current one finishes, so the
 * signal is not lost and no extra requests appear.
 */
let inFlight: Promise<void> | null = null;
let pendingReload = false;

export async function loadChats(force = false): Promise<void> {
  if (!statusState.backendPort) return;
  if (chatsState.loaded && !force) return;

  if (inFlight) {
    // Already loading: remember that another pass is needed after this one.
    if (force) pendingReload = true;
    return inFlight;
  }

  inFlight = (async () => {
    // The port was checked above, but TypeScript cannot see it: narrowing does not survive a
    // closure boundary. Capture the value once.
    const port = statusState.backendPort as number;
    chatsState.isLoading = true;
    try {
      const [previews, contactsRes, communities] = await Promise.all([
        getChats(port),
        getContacts(port),
        // `getCommunities` (`wakuext_communities` = `All()`), not `getJoinedCommunities`: the
        // latter is `WHERE c.joined`, so channels of a spectated community are absent from it.
        // Their chats do live in `wakuext_chats` and are read, so without this the channels of a
        // Logos community before joining drop out of the grouping and look like ordinary channels
        // with no community header.
        getCommunities(port).catch((e) => {
          warn('[chats] communities failed:', e);
          return [] as Community[];
        }),
      ]);

      info(
        `[chats] loaded chats=${previews.length} contacts=${contactsRes.result?.length ?? 0} ` +
          `communities=${communities.length}`
      );

      // Diagnostics: without this there is no way to tell why a channel is missing. Types and
      // activity only, never message contents.
      for (const c of previews) {
        debug(
          `[chats] chat id=${c.id} name=${c.name} type=${c.chatType} ` +
            `active=${c.active} muted=${c.muted} community=${c.communityId || '-'}`
        );
      }

      chatsState.contacts = contactsRes.result || [];
      chatsState.communities = communities;
      chatsState.items = buildItems(previews, chatsState.contacts, communities);

      info(`[chats] items after merge: ${chatsState.items.length}`);

      chatsState.loaded = true;
    } catch (e) {
      warn('Failed to load chats:', e);
    } finally {
      chatsState.isLoading = false;
    }
  })();

  try {
    await inFlight;
  } finally {
    inFlight = null;
    // A signal may have arrived while loading: process it once.
    if (pendingReload) {
      pendingReload = false;
      await loadChats(true);
    }
  }
}

/**
 * Creates an ACC channel and opens it.
 *
 * A channel is a technical community with a single channel (see `status/akk.ts`); the user never
 * sees that and can post right away.
 *
 * @param params - Channel name, description and kind.
 * @returns `ok` on success, otherwise the reason in `error`.
 * @remarks
 * The channel is marked as opened immediately: `buildItems` hides community channels that carry no
 * such mark.
 */
export async function createAndOpenChannel(
  params: CreateChannelParams
): Promise<{ ok: boolean; error?: string }> {
  const port = statusState.backendPort;
  if (!port) return { ok: false, error: 'Backend is not running' };

  const invalid = validateChannelInput(params.name, params.description);
  if (invalid) return { ok: false, error: invalid };

  const scenario = params.kind === 'news' ? 'create-auto' : 'create-request';
  scenarioLog(scenario, '1-start', { name: params.name, kind: params.kind });

  try {
    const created = await createChannel(port, params);
    scenarioLog(scenario, '2-created', {
      communityId: short(created.communityId),
      chatId: short(created.chatId),
    });
    await loadChats(true);
    const inList = chatsState.items.some((c) => c.id === created.chatId);
    scenarioLog(scenario, '3-in-list', { inList, items: chatsState.items.length },
      inList ? 'info' : 'warn');
    chatsState.selected =
      chatsState.items.find((c) => c.id === created.chatId) ?? null;
    return { ok: true };
  } catch (e) {
    scenarioLog(scenario, 'error', { error: formatError(e) }, 'warn');
    warn('[chats] create channel failed:', e);
    return { ok: false, error: formatError(e) };
  }
}

/**
 * Selects a chat by id when it is in the list.
 *
 * @param chatId - Chat id, either from the chat list or a feed subscription id.
 * @remarks
 * External subscriptions are not part of `items`; they come from `feedsStore`. Without the second
 * lookup, opening a feed from the dApp panel would select `null` and leave the chat section empty.
 */
export function selectChat(chatId: string) {
  // The chat list comes first. External subscriptions are not in `items`; they come from
  // `feedsStore`, so without the second lookup opening a feed from the dApp panel would select
  // `null` and the chat section would show nothing.
  const chat =
    chatsState.items.find((c) => c.id === chatId) ||
    feedChatItems().find((c) => c.id === chatId) ||
    null;
  chatsState.selected = chat as ChatItem | null;
}

/**
 * Accepts an incoming 1-1 request and opens that chat.
 *
 * @param item - Chat row that carried the request.
 * @param port - Backend port.
 * @param publicKey - Contact key the request came from.
 * @remarks
 * Accept makes the contact active, but neither the list nor the selection updates by itself:
 * without an explicit `setSelectedChat` the right panel would stay on the request screen while the
 * chat appeared on the left unselected.
 */
export async function acceptRequestAndOpen(item: ChatItem, port: number, publicKey: string): Promise<void> {
  await acceptContactRequestRpc(port, publicKey);
  await loadChats(true);
  const fresh = chatsState.items.find((c) => c.id === item.id) ?? null;
  setSelectedChat(fresh);
  scenarioLog('reply-sync', 'accepted', { chat: short(item.id), opened: !!fresh }, 'info');
}

/**
 * Accepts an incoming request by contact id and opens the chat on the right.
 *
 * @param contactId - Contact id of the pending request.
 * @remarks
 * Used from the contact list, which shows pending requests first.
 */
export async function acceptIncomingAndOpen(contactId: string): Promise<void> {
  if (!statusState.backendPort) return;
  await acceptContactRequestRpc(statusState.backendPort, contactId);
  await loadChats(true);
  const fresh = chatsState.items.find((c) => c.id === contactId) ?? null;
  setSelectedChat(fresh);
  if (!fresh) {
    // The chat shows up after a sync: open the conversation rather than an empty search.
    chatsState.rightPanel = 'chat';
  }
  scenarioLog('reply-sync', 'accepted-from-search', { chat: short(contactId), opened: !!fresh }, 'info');
}

/**
 * Declines an incoming request and returns the right panel to the initial "select a chat" state.
 *
 * @param item - Chat row that carried the request.
 * @param port - Backend port.
 * @param publicKey - Contact key the request came from.
 */
export async function rejectRequest(item: ChatItem, port: number, publicKey: string): Promise<void> {
  await declineContactRequestRpc(port, publicKey);
  if (chatsState.selected?.id === item.id) setSelectedChat(null);
  await loadChats(true);
  scenarioLog('reply-sync', 'rejected', { chat: short(item.id) }, 'info');
}

/** Switches the right panel of the chat section. */
export function setRightPanel(mode: RightPanel) {
  chatsState.rightPanel = mode;
}

export function setSelectedChat(chat: ChatItem | null) {
  chatsState.selected = chat;
  // Selecting a chat returns the right panel to the conversation.
  if (chat) chatsState.rightPanel = 'chat';
  // Opening a chat means it is read: reset the unread counter on the backend. Otherwise the "1"
  // stays until the list reloads and comes back with it.
  if (chat && chat.unreadCount && statusState.backendPort) {
    markChatRead(statusState.backendPort, chat.id).catch(() => {});
    chatsState.items = chatsState.items.map((c) => (c.id === chat.id ? { ...c, unreadCount: 0 } : c));
  }
}

/** Community the selected chat belongs to, or `null`. */
export function selectedCommunity(): Community | null {
  const id = chatsState.selected?.communityId;
  if (!id) return null;
  return chatsState.communities.find(c => c.id === id) || null;
}

// ===========================================================================
// JOINING
// ===========================================================================

// Public channels cannot be created from the UI on purpose.
//
// `createPublicChat` builds a channel from a name alone: no owner, no rights, no existence check
// (`CreatePublicChat.Validate` only requires a non-empty id). A typo yields an empty but valid
// chat, and a channel can be found only by exact name, since no catalog of public channels exists
// in status-go or SIM.
//
// That does not fit the ACC scheme: "a channel with an author" requires the author to restrict
// posting, and a public channel offers no such mechanism.
//
// Existing public chats (`#status` and the like) stay listed and readable; their `channel` type in
// `ChatItem` is kept. Only the creation path from the UI is gone.

/**
 * Sends a contact request to the key from a `status.app/u/…#<key>` link.
 *
 * The key is multibase base58btc, like a community key, and goes through the same parser. status-go
 * sends the request; the chat appears once the contact accepts it.
 *
 * @param rawKey - Key without the `#`, as embedded in the invite link.
 * @returns `contact` when the request was sent, `failed` with the reason otherwise.
 */
export async function requestContactById(rawKey: string): Promise<JoinResult> {
  if (!statusState.backendPort) return { status: 'failed', error: 'Backend is not running' };

  const publicKey = communityIdFromInvite(`#${rawKey}`);
  if (!/^0x[0-9a-fA-F]{66}$/.test(publicKey)) {
    return { status: 'failed', error: 'Не удалось разобрать ключ контакта' };
  }

  scenarioLog('reply-sync', 'contact-request-1-start', { contact: short(publicKey) });
  try {
    await sendContactRequest(statusState.backendPort, publicKey, '');
    scenarioLog('reply-sync', 'contact-request-2-sent', { contact: short(publicKey) });
    await loadChats(true);
    return { status: 'contact', name: short(publicKey) };
  } catch (e) {
    const error = formatError(e);
    scenarioLog('reply-sync', 'contact-request-error', { error }, 'warn');
    return { status: 'failed', error };
  }
}

/**
 * Opens a community for reading without joining (`wakuext_spectateCommunity`).
 *
 * Sets `Spectated = true`, initialises filters and creates `Chat` rows for the channels, which is
 * what makes a Logos channel visible before joining, as SIM does. Posting stays impossible:
 * `CanView` returns `false` for a non-member and the UI hides the input. The state is persisted in
 * the status-go database, so spectating survives a restart; `leaveCommunity` undoes it.
 *
 * @param rawId - Community id, hex or invite key, as typed or pasted.
 * @param channelId - UUID of a channel from a `cc/` link, if the invite names one.
 * @returns `spectated` with the community name, or `failed` with the reason.
 * @remarks
 * A channel link leads to the community, but the user expects to land in that channel, so its id
 * is selected after the list reloads. A missing channel (renamed, hidden by rights) leaves the
 * list open without an error.
 */
export async function spectateCommunityById(
  rawId: string,
  channelId?: string | null
): Promise<JoinResult> {
  if (!statusState.backendPort) return { status: 'failed', error: 'Backend is not running' };

  const communityId = rawId.trim();
  if (!communityId) return { status: 'failed', error: 'Empty community id' };

  chatsState.isJoining = true;
  chatsState.joinError = '';
  try {
    // The community must be known locally or spectate answers "not found". `waitForResponse:
    // false` skips the network: the id usually already came from the catalog.
    const community = await fetchCommunity(statusState.backendPort, communityId).catch(() => null);

    await spectateCommunity(statusState.backendPort, communityId);
    await loadChats(true);

    // Open the channel if the link names one. A list `chatId` is the concatenation of
    // `communityId + channelId` (see `communityChatId`), so look it up by the community prefix
    // rather than comparing against a bare UUID.
    if (channelId) {
      const targetId = communityChatId(communityId, channelId);
      // Mark before looking up: otherwise the "foreign channel only when opened" filter rejects
      // the channel the user just opened from a link.
      markChannelOpened(targetId);
      await loadChats(true);
      // The link points at one channel and the user wants to see it. Spectating does not bring
      // back a channel removed here (`deactivateChat`): it skips a community it already knows.
      // Leaving and spectating again recreates its channels as active. Leaving deactivates every
      // channel of the community, so it happens only when the wanted channel is not listed.
      if (!chatsState.items.some((i) => i.id === targetId)) {
        scenarioLog('create-request', 'reopen-1-leave', { community: short(communityId) });
        await leaveCommunity(statusState.backendPort, communityId);
        await spectateCommunity(statusState.backendPort, communityId);
        await loadChats(true);
      }

      const target = chatsState.items.find((i) => i.id === targetId);
      if (target) {
        // Mark as opened: after a reload the channel stays listed while the other channels of this
        // foreign community stay hidden.
        markChannelOpened(targetId);
        chatsState.selected = target;
        debug(`[chats] opened channel ${channelId} from invite link`);
      } else {
        warn(`[chats] channel ${channelId} not found in ${communityId}`);
      }
    }

    return { status: 'spectated', name: community?.name || communityId };
  } catch (e) {
    const error = formatError(e);
    chatsState.joinError = error;
    return { status: 'failed', error };
  } finally {
    chatsState.isJoining = false;
  }
}

/**
 * Addresses to reveal when joining, and the airdrop one among them.
 *
 * @remarks
 * `wakuext_requestToJoinCommunity` requires a non-empty address list with `airdropAddress` inside
 * it, so joining without picking an address is impossible. The choice therefore belongs to the UI,
 * not the store.
 */
export interface JoinAddresses {
  addressesToReveal: string[];
  airdropAddress: string;
}

/**
 * Signs the revealed addresses and sends a join request to a community.
 *
 * @param communityId - Community to join.
 * @param addresses - Addresses to reveal and the airdrop address among them.
 * @param password - Profile password needed to sign the addresses.
 * @returns `requested` when the request was sent, `failed` with the reason otherwise.
 * @remarks
 * Go through `requestToJoinCommunity`, not `wakuext_joinCommunity`, and for open communities too.
 * `Manager.JoinCommunity` only sets `Joined = true` locally (communities/manager.go) and sends
 * nothing to the owner; it is meant for a request the control node already accepted
 * (messenger_handler.go:1705) or for the owner of their own community. On a foreign community it
 * yields the flag without access, since no keys were issued. status-go wants access requested
 * every time, and `AUTO_ACCEPT` only means the control node accepts on its own. Signing happens in
 * status-go too, which verifies the password via `GetVerifiedWalletAccount`, and the owner
 * discards a request without signatures.
 */
export async function requestJoinCommunity(
  communityId: string,
  addresses: JoinAddresses,
  password: string
): Promise<JoinResult> {
  if (!statusState.backendPort) return { status: 'failed', error: 'Backend is not running' };
  if (!addresses.addressesToReveal.length) {
    return { status: 'failed', error: 'Select at least one address' };
  }
  if (!addresses.airdropAddress) {
    return { status: 'failed', error: 'Select an airdrop address' };
  }

  const port = statusState.backendPort;
  chatsState.isJoining = true;
  chatsState.joinError = '';
  scenarioLog('create-request', 'join-1-start', { community: short(communityId) });
  try {
    const community = await fetchCommunity(port, communityId).catch(() => null);
    const name = community?.name || communityId;
    scenarioLog('create-request', 'join-2-fetched', {
      name,
      access: community?.permissions?.access ?? null,
      canRequestAccess: community?.canRequestAccess ?? null,
    });

    const toSign = await generateJoiningRequestsForSigning(
      port,
      statusState.publicKey || '',
      communityId,
      addresses.addressesToReveal
    );

    // Sign only the addresses the backend returned data for. `personal.SignParams` skips chat
    // accounts and watch-only ones, so the answer may be shorter than the request, while the
    // order of signatures in the request must match the order of addresses.
    const signable = toSign.filter((p) => !!p.data);
    if (!signable.length) {
      throw new Error('No address can be revealed: watch-only and chat accounts cannot sign');
    }

    const signatures = await signJoinRequestData(port, signable, password);
    if (signatures.length !== signable.length) {
      throw new Error('Signature count does not match address count');
    }

    const revealed = signable.map((p) => p.account || '');
    // `airdropAddress` must be one of the revealed addresses; if the chosen one cannot be signed,
    // send the request with a signable address instead.
    const airdrop = revealed.includes(addresses.airdropAddress)
      ? addresses.airdropAddress
      : revealed[0];

    scenarioLog('create-request', 'join-3-signed', { addresses: revealed.length });
    const reqRes = await requestToJoinCommunity(port, communityId, revealed, signatures, airdrop);
    scenarioLog('create-request', 'join-4-sent', {
      ok: !!reqRes,
      error: reqRes?.error?.message ?? null,
    }, reqRes?.error ? 'warn' : 'info');
    await loadChats(true);

    // An open community (`AUTO_ACCEPT`) accepts on its own, but the answer arrives asynchronously
    // via a signal. Reporting `joined` here would be a lie: the result is "request sent", and the
    // channel appears once the owner (or its automation) answers.
    return { status: 'requested', name };
  } catch (e) {
    const error = formatError(e);
    scenarioLog('create-request', 'join-error', { error }, 'warn');
    chatsState.joinError = error;
    return { status: 'failed', error };
  } finally {
    chatsState.isJoining = false;
  }
}

/**
 * Checks whether the addresses meet the community's conditions.
 *
 * Supplies what the "You are eligible to join as member" and "Select address to share" screens
 * need: `satisfied` and the list of eligible addresses.
 *
 * @param communityId - Community to check.
 * @param addresses - Candidate addresses; empty lets the backend decide on its own.
 * @returns Eligibility, the eligible addresses and whether any network is unsupported.
 */
export async function checkJoinEligibility(
  communityId: string,
  addresses: string[] = []
): Promise<{ satisfied: boolean; addresses: string[]; networksNotSupported: boolean }> {
  if (!statusState.backendPort) {
    return { satisfied: false, addresses: [], networksNotSupported: false };
  }
  const res = await checkPermissionsToJoinCommunity(
    statusState.backendPort,
    communityId,
    addresses
  );
  return {
    satisfied: res.satisfied,
    addresses: res.validCombinations.map((c) => c.address),
    networksNotSupported: res.networksNotSupported,
  };
}

/**
 * Connects to a community from the text typed into the "connect" field.
 *
 * A Status invite (`status.app/c/…#zQ3…`) or a `0x…` id opens the community; anything else is
 * rejected with an explanation.
 *
 * @param raw - Raw input, a pasted link, key or id.
 * @returns `spectated` or `contact` when something was opened, `failed` with the reason otherwise.
 * @remarks
 * Input that is neither a link nor a `0x` id is refused rather than turned into a public channel:
 * such a channel has no owner, cannot be closed, renamed or write-restricted, and is findable only
 * by exact name. A typo would create an empty but "valid" chat indistinguishable from a silent one.
 * Parsing lives in `communityIdFromInvite`, where the key sits after `#` in base58btc rather than
 * after `/c/` in base64. For a community the action is spectating, not joining: joining needs
 * address choices and a password, so it lives in `requestJoinCommunity` and starts from the
 * preview screen, keeping "show what is inside" and "join" apart.
 */
export async function joinByInput(raw: string): Promise<JoinResult> {
  const value = raw.trim();
  if (!value) return { status: 'failed', error: 'Empty input' };

  // Invite links. Formats in the wild:
  //   status.app/c/<base64>#<base58btc>  — community, from "Share community";
  //   status.app/c#<key>                 — community, without the base64 part;
  //   status.app/cc/<uuid>#<key>         — channel, UUID as text;
  //   status.app/cc/<brotli>#<key>       — channel, description in compressed protobuf.
  //
  // A channel link also leads to the community: a channel is addressed by the pair "UUID + key"
  // and means nothing without its community. The user expects to land in the channel, though, so
  // the UUID is passed on and opened after the list reloads.
  //
  // The compressed form is parsed in Rust (`parseChannelInvite`): the webview cannot decode brotli.
  // Contact: a profile from "Share profile". Sends a contact request; the chat appears once the
  // contact accepts it (see docs/ru/akk_scheme.md).
  const contactMatch = value.match(/status\.app\/u\/[^#\s]*#(\S+)/i);
  if (contactMatch) {
    return await requestContactById(contactMatch[1]);
  }

  if (/status\.app\/cc\//i.test(value)) {
    const parsed = await parseChannelInvite(value).catch(() => null);
    return await spectateCommunityById(
      communityIdFromInvite(value),
      parsed?.channelId ?? channelIdFromInvite(value)
    );
  }

  if (/status\.app\/c(?:[/#])/i.test(value)) {
    return await spectateCommunityById(communityIdFromInvite(value));
  }

  // A bare contact key, as shown by "Invite a contact" (Android and SIM): base58btc with a `z`
  // prefix (zQ3sh…). It gets copied in several shapes: "zQ3…", "#zQ3…", "clean invite: #zQ3…", so
  // look for the key anywhere in the string. Channel and community links were handled above and
  // cannot reach here.
  const bareKey = value.match(/(?:^|[\s#:])(z[1-9A-HJ-NP-Za-km-z]{40,60})(?![1-9A-Za-z])/);
  if (bareKey) {
    return await requestContactById(bareKey[1]);
  }
  if (/^0x[0-9a-fA-F]{66}$/.test(value)) {
    return await requestContactById(value);
  }

  // An explicit hex community id.
  if (/^0x[0-9a-fA-F]{64,}$/.test(value)) {
    return await spectateCommunityById(value);
  }

  // A Telegram profile or channel link is deliberately not handled here: it is an external source,
  // not a Status channel. See providers_and_dapps.md §9.
  return {
    status: 'failed',
    error:
      'Вставьте ссылку на канал (status.app/cc/…). Найти канал по имени нельзя: каталога каналов нет.',
  };
}

/**
 * Removes a chat from the list.
 *
 * @param item - Chat row to remove.
 * @returns `ok` on success, otherwise the reason in `error`.
 * @remarks
 * A community channel gets `deactivateChat` without history: it stops arriving and leaves the
 * list, and its history is not fetched again, while the chat itself stays in status-go and can be
 * reopened from the catalog with history intact. So "hide" and "erase history" are separate
 * actions. For a public channel (`type: 'channel'`) `deactivateChat` is the only way to
 * unsubscribe: it has no owner, cannot be deleted for everyone, and has no membership mark. Leaving
 * the community entirely is a separate action (`leaveCommunityById`).
 */
export async function removeChat(item: ChatItem): Promise<{ ok: boolean; error?: string }> {
  // Community channel: drop the mark and rebuild the list without calling the backend.
  // `deactivateChat` here would be irreversible, since `preserveHistory` does not keep history by
  // default.
  if (item.type === 'community') {
    if (!statusState.backendPort) return { ok: false, error: 'Backend is not running' };
    // Deactivation in status-go: the channel stops arriving and leaves the list. History is not
    // kept and not fetched again.
    try {
      await deactivateChat(statusState.backendPort, item.id, false);
    } catch (e) {
      const error = formatError(e);
      scenarioLog('create-auto', 'remove-failed', { channel: short(item.id), error }, 'warn');
      return { ok: false, error };
    }
    chatsState.items = chatsState.items.filter((c) => c.id !== item.id);
    if (chatsState.selected?.id === item.id) chatsState.selected = null;
    info(`[chats] deactivated channel ${short(item.id)}`);
    return { ok: true };
  }

  if (!statusState.backendPort) return { ok: false, error: 'Backend is not running' };

  try {
    await deactivateChat(statusState.backendPort, item.id);
    // Remove at once rather than waiting for a reload: it can take long and the user expects an
    // immediate result.
    chatsState.items = chatsState.items.filter((c) => c.id !== item.id);
    if (chatsState.selected?.id === item.id) chatsState.selected = null;
    chatsState.loaded = false;
    info(`[chats] removed chat ${item.id}`);
    return { ok: true };
  } catch (e) {
    const error = formatError(e);
    warn(`[chats] failed to remove ${item.id}:`, error);
    return { ok: false, error };
  }
}

/**
 * Leaves a community entirely.
 *
 * @param communityId - Community to leave.
 * @returns `ok` on success, otherwise the reason in `error`.
 * @remarks
 * `leaveCommunity` clears both flags (`joined` and `spectated`), see `Community.Leave()` in
 * status-go. The community's channels then leave the list and the only way back is a fresh invite
 * link. This is less reversible than hiding a channel, so it has its own confirmed button rather
 * than sharing the "remove from list" action.
 */
export async function leaveCommunityById(
  communityId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!statusState.backendPort) return { ok: false, error: 'Backend is not running' };

  try {
    await leaveCommunity(statusState.backendPort, communityId);
    chatsState.items = chatsState.items.filter((c) => c.communityId !== communityId);
    if (chatsState.selected?.communityId === communityId) chatsState.selected = null;
    chatsState.loaded = false;
    info(`[chats] left community ${communityId}`);
    return { ok: true };
  } catch (e) {
    const error = formatError(e);
    warn(`[chats] failed to leave ${communityId}:`, error);
    return { ok: false, error };
  }
}

export function resetChats() {
  chatsState.items = [];
  chatsState.contacts = [];
  chatsState.communities = [];
  chatsState.selected = null;
  chatsState.loaded = false;
  chatsState.isLoading = false;
  chatsState.isJoining = false;
  chatsState.joinError = '';
}
