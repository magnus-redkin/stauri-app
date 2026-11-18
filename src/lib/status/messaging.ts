/**
 * status-go boundary for messaging.
 *
 * Stauri takes only networking and the wallet from status-go and moves the rest
 * out. Messaging still runs on status-go, but the boundary is fixed: every
 * `wakuext_*` method related to chats and communities lives here and nowhere
 * else. When status-go goes away, this file and its callers change, not the whole
 * frontend.
 *
 * All methods go through `statusFetch` and return the `result` of the JSON-RPC
 * envelope. Response shapes are described in `types.ts`: `Chat` uses `chatType`,
 * `communityId` and `categoryId`; `Community` nests `chats` and `categories`.
 *
 * @remarks
 * `chatType` is a number (see `ChatType` below), not a string. Filtering by
 * string silently finds nothing.
 */

import { invoke } from '@tauri-apps/api/core';
import { statusFetch } from './http';
import { hexToBase58Key } from './invite';
import { debug } from '$lib/utils/log';
import type {
  Chat,
  Community,
  CommunityAccess,
  CommunityChat,
  CommunityPermissions,
  CommunityTokenPermission,
} from './types';

/**
 * status-go chat types (internal/protocol/chat.go).
 *
 * Values are fixed and change only together with status-go: they are
 * `iota + 1`, so their order must not be rearranged.
 */
export const ChatType = {
  OneToOne: 1,
  Public: 2,
  PrivateGroup: 3,
  Profile: 4, // deprecated
  Timeline: 5, // deprecated
  Community: 6,
} as const;

export type ChatTypeValue = (typeof ChatType)[keyof typeof ChatType];

/** Whether the chat is a public channel. */
export function isChannel(chat: Chat): boolean {
  return chat.chatType === ChatType.Public;
}

/** Whether the chat belongs to a community. */
export function isCommunityChat(chat: Chat): boolean {
  return chat.chatType === ChatType.Community || !!chat.communityId;
}

/** Whether the chat is a one-to-one conversation. */
export function isDirectMessage(chat: Chat): boolean {
  return chat.chatType === ChatType.OneToOne;
}

// ===========================================================================
// READING
// ===========================================================================

/**
 * All chats of the profile.
 *
 * @returns Every chat, including deactivated ones.
 * @remarks
 * This uses `wakuext_chats`, not `chatsPreview`: `ChatsPreview` in this branch of
 * status-go filters the wrong way round and selects only chats with
 * `chat.Active || chat.Muted` (internal/protocol/messenger_chats.go). A normally
 * joined channel (`Active = true`, not muted) therefore never appears in its
 * output. `Chats()` applies no such filter and includes the `Active` field, so
 * the client decides what to show. The cost is full records instead of previews.
 */
export async function getChats(): Promise<Chat[]> {
  const res = await statusFetch<{ result?: Chat[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_chats',
    params: [],
  });
  return res.result || [];
}

/**
 * Lightweight chat previews.
 *
 * @param filter - `community` or `nonCommunity`, or omitted for both.
 * @returns Preview records from status-go.
 * @remarks
 * For a chat list use `getChats` instead: this method filters out normally joined
 * channels in this status-go branch.
 */
export async function getChatPreviews(
  filter?: 'community' | 'nonCommunity'
): Promise<any[]> {
  const params: any[] = [];
  if (filter === 'community') params.push(0); // ChatPreviewFilterTypeCommunity
  else if (filter === 'nonCommunity') params.push(1); // ChatPreviewFilterTypeNonCommunity

  const res = await statusFetch<{ result?: any[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_chatsPreview',
    params,
  });
  return res.result || [];
}

/** Full chat record by id, for when the list is not enough. */
export async function getChat(chatId: string): Promise<Chat | null> {
  const res = await statusFetch<{ result?: Chat | null }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_chat',
    params: [chatId],
  });
  return res.result ?? null;
}

/**
 * Messages of a chat.
 *
 * @param chatId - Chat id.
 * @param limit - Maximum number of messages in a page.
 * @param cursor - Paging cursor; an empty string means "from the newest".
 * @returns The page of messages and the cursor for the next page, if any.
 */
export async function getChatMessages(
  chatId: string,
  limit = 20,
  cursor = ''
): Promise<{ messages: any[]; cursor?: string }> {
  const res = await statusFetch<{ result?: { messages?: any[]; cursor?: string } }>(
    'CallRPC',
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'wakuext_chatMessages',
      params: [chatId, cursor, limit],
    }
  );
  return { messages: res.result?.messages || [], cursor: res.result?.cursor };
}

// ===========================================================================
// COMMUNITIES
// ===========================================================================

/**
 * Communities the user has joined.
 *
 * @returns Joined communities, each with `chats` (channel id to channel) and
 * `categories` (category id to category).
 */
export async function getJoinedCommunities(): Promise<Community[]> {
  const res = await statusFetch<{ result?: Community[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_joinedCommunities',
    params: [],
  });
  return res.result || [];
}

/** Every known community, including ones the user has not joined. */
export async function getCommunities(): Promise<Community[]> {
  const res = await statusFetch<{ result?: Community[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_communities',
    params: [],
  });
  return res.result || [];
}

/**
 * Communities the user is spectating.
 *
 * @returns Communities with `spectated === true`.
 * @remarks
 * `wakuext_joinedCommunities` is literally `WHERE c.joined`
 * (internal/protocol/communities/persistence.go, `JoinedCommunities`), so
 * spectated communities never appear there even though their channels are in
 * `wakuext_chats` and are readable. There is no "joined or spectated" RPC:
 * `JoinedOrSpectatedCommunities` exists in `Persistence` but is not exposed in
 * `PublicAPI`. This therefore reads `wakuext_communities` (`All()`) and filters
 * on the client.
 */
export async function getSpectatedCommunities(): Promise<Community[]> {
  const all = await getCommunities();
  return all.filter((c) => c.spectated === true);
}

/**
 * Community catalogue from the Directory smart contract.
 *
 * @returns Contract community ids, the featured subset, known descriptions and
 * ids whose descriptions are still missing.
 * @remarks
 * This backs the Discover section in SIM (`messenger_curated_communities.go`,
 * `getCuratedCommunitiesFromContract`): Optimism mainnet, or Optimism Sepolia
 * when test mode is on. The response is not a list of ready communities:
 * `communities` is an id-to-description map but only for communities already in
 * the database, and `unknownCommunities` holds contract ids that are not. The map
 * can therefore be empty on the first call while status-go fetches descriptions
 * in the background; that is not an error.
 */
export async function getCuratedCommunities(
): Promise<{
  ids: string[];
  featured: string[];
  descriptions: Record<string, Community>;
  unknown: string[];
}> {
  const res = await statusFetch<{
    result?: {
      contractCommunities?: string[];
      contractFeaturedCommunities?: string[];
      communities?: Record<string, Community>;
      unknownCommunities?: string[];
    };
  }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_curatedCommunities',
    params: [],
  });

  const r = res.result;
  return {
    ids: r?.contractCommunities || [],
    featured: r?.contractFeaturedCommunities || [],
    descriptions: r?.communities || {},
    unknown: r?.unknownCommunities || [],
  };
}

// ===========================================================================
// ACCESS AND JOINING
// ===========================================================================

/** `CommunityPermissions_Access` values (protobuf/communities.pb.go). */
export const CommunityAccessValue = {
  Unknown: 0,
  AutoAccept: 1,
  /** @deprecated in the .proto itself; unused since 2022. */
  InvitationOnly: 2,
  ManualAccept: 3,
} as const;

/** `CommunityTokenPermission_Type`. */
export const TokenPermissionType = {
  Unknown: 0,
  BecomeAdmin: 1,
  BecomeMember: 2,
  CanViewChannel: 3,
  CanViewAndPostChannel: 4,
  BecomeTokenMaster: 5,
  BecomeTokenOwner: 6,
} as const;

/**
 * How a community lets people in, as a single value.
 *
 * @param community - Community record from status-go.
 * @returns `token` when a BECOME_MEMBER permission exists, otherwise `open`,
 * `request` or `unknown` from `permissions.access`.
 * @remarks
 * `canRequestAccess` cannot be used for this: it returns `false` both for an open
 * community and for one the user already belongs to, so the two are
 * indistinguishable. The distinction matters on the preview screen, where the
 * user is not a member yet.
 *
 * The token gate is checked first because `Encrypted()` in status-go means "has a
 * BECOME_MEMBER right", independent of `access`. A community can be MANUAL_ACCEPT
 * and token-gated at once, and then the token is the more useful fact.
 *
 * An absent or UNKNOWN_ACCESS value is treated as `request` rather than `open`:
 * status-go's default is that access must always be requested.
 */
export function communityAccess(community: {
  permissions?: CommunityPermissions;
  tokenPermissions?: Record<string, CommunityTokenPermission>;
}): CommunityAccess {
  const tokenGated = Object.values(community.tokenPermissions || {}).some(
    (p) => p?.type === TokenPermissionType.BecomeMember
  );
  if (tokenGated) return 'token';

  switch (community.permissions?.access) {
    case CommunityAccessValue.AutoAccept:
      return 'open';
    case CommunityAccessValue.ManualAccept:
      return 'request';
    default:
      // UNKNOWN_ACCESS or the field is absent. status-go's default is that
      // access must always be requested, so the cautious reading is `request`.
      return 'unknown';
  }
}

/**
 * Full id of a channel inside a community.
 *
 * @param communityId - Community id.
 * @param channelId - Bare channel name as it appears in `Community.chats`.
 * @returns The concatenated chat id.
 * @remarks
 * A key in `Community.chats` is a bare name (`intros`), while `Chat.id` is the
 * concatenation `communityID + channelID` (internal/protocol/communities,
 * `ChatID`). `sendChatMessage` needs the concatenated form; the bare name sends
 * the message to a chat that does not exist.
 */
export function communityChatId(communityId: string, channelId: string): string {
  return `${communityId}${channelId}`;
}

/**
 * Checks which of the user's addresses satisfy the community's token criteria.
 *
 * @param communityId - Community id, with or without a `0x` prefix.
 * @param addresses - Addresses to check; an empty array checks every active
 * wallet address.
 * @returns `satisfied` answers "you are eligible to join as member";
 * `validCombinations` lists the addresses that passed, per chain, as shown on
 * the "Select address to share" screen.
 */
export async function checkPermissionsToJoinCommunity(
  communityId: string,
  addresses: string[] = []
): Promise<{
  satisfied: boolean;
  validCombinations: Array<{ address: string; chainIds: number[] }>;
  networksNotSupported: boolean;
  roles?: any[];
  highestRole?: any;
}> {
  const res = await statusFetch<{
    result?: {
      satisfied?: boolean;
      validCombinations?: Array<{ address: string; chainIds: number[] }>;
      networksNotSupported?: boolean;
      roles?: any[];
      highestRole?: any;
    };
  }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_checkPermissionsToJoinCommunity',
    params: [{ communityId: normalizeHex(communityId), addresses }],
  });

  const r = res.result;
  return {
    satisfied: r?.satisfied ?? false,
    validCombinations: r?.validCombinations || [],
    networksNotSupported: r?.networksNotSupported ?? false,
    roles: r?.roles,
    highestRole: r?.highestRole,
  };
}

/**
 * Builds the payloads that must be signed to reveal addresses to a community.
 *
 * @param memberPublicKey - Public key of the community member.
 * @param communityId - Community id, with or without a `0x` prefix.
 * @param addressesToReveal - Addresses the user agreed to share.
 * @returns One `SignParams` per signable address, in the same order as the
 * addresses were given.
 * @remarks
 * `personal.SignParams` skips chat accounts and watch-only accounts, so the
 * result can be shorter than `addressesToReveal`; callers must drop the
 * addresses that came back without `data` rather than assume a one-to-one
 * mapping, while keeping the returned order, because the request to join
 * requires signatures in address order. An address that cannot be signed cannot
 * be revealed.
 *
 * Each payload covers `keccak256(publicKeyCompressed, communityID, requestID)`,
 * so a signature is bound to one community and one request and cannot be reused
 * elsewhere.
 */
export async function generateJoiningRequestsForSigning(
  memberPublicKey: string,
  communityId: string,
  addressesToReveal: string[]
): Promise<Array<{ data: string; account: string }>> {
  const res = await statusFetch<{
    result?: Array<{ data: string; account: string }>;
  }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_generateJoiningCommunityRequestsForSigning',
    params: [memberPublicKey, normalizeHex(communityId), addressesToReveal],
  });
  return res.result || [];
}

/**
 * Signs the prepared payloads with the profile password.
 *
 * @param params - Payloads returned by `generateJoiningRequestsForSigning`.
 * @param password - Profile password, the same for every address.
 * @returns Signatures in the same order as `params`.
 * @remarks
 * Inside `Messenger.SignData` status-go calls
 * `m.accountsManager.GetVerifiedWalletAccount(address, param.Password)`, so it
 * verifies the password against every address; without it there are no
 * signatures, and `RequestToJoinCommunity` without signatures is discarded by
 * the control node as unverified. The password is entered in the interface
 * because there is no keystore here that could sign silently.
 *
 * One password covers all addresses, since one profile's keys share it. Signing
 * per address would need a separate call for each.
 */
export async function signJoinRequestData(
  params: Array<{ data: string; account: string }>,
  password: string
): Promise<string[]> {
  const res = await statusFetch<{ result?: string[] }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_signData',
    params: [params.map((p) => ({ ...p, password }))],
  });
  return res.result || [];
}

/**
 * Sends a request to join a community.
 *
 * @param communityId - Community id, with or without a `0x` prefix.
 * @param addressesToReveal - Addresses to reveal; must not be empty.
 * @param signatures - One signature per revealed address, in the same order.
 * @param airdropAddress - Address that receives airdrops; must be one of
 * `addressesToReveal`.
 * @param shareFutureAddresses - Whether to sign with addresses added to the wallet
 * later.
 * @returns The backend's response.
 * @remarks
 * status-go validates the following before accepting the request
 * (requests/request_to_join_community.go, `Validate`): `addressesToReveal` is
 * not empty, `airdropAddress` is set and included in it, and every signature is
 * exactly `crypto.SignatureLength` (65) bytes.
 *
 * `shareFutureAddresses` defaults to `false`: an address the user did not
 * deliberately share should not be revealed to the community automatically.
 */
export async function requestToJoinCommunity(
  communityId: string,
  addressesToReveal: string[],
  signatures: string[],
  airdropAddress: string,
  shareFutureAddresses = false
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_requestToJoinCommunity',
    params: [
      {
        communityId: normalizeHex(communityId),
        ensName: '',
        addressesToReveal,
        signatures,
        airdropAddress,
        shareFutureAddresses,
      },
    ],
  });
}

/**
 * Views a community without joining it.
 *
 * @param communityId - Community id, with or without a `0x` prefix.
 * @returns The backend's response.
 * @remarks
 * Sets `Spectated = true`, initialises the filters (subscription to the
 * community's pubsub topic) and creates `Chat` records for every channel. The
 * channels then read, but `CanView` is `false`, so posting is impossible and the
 * interface hides the composer.
 *
 * Works only for UNencrypted channels: in a token-gated community the content is
 * encrypted with a key issued on joining.
 *
 * The state is persisted, so spectating survives a restart and needs an explicit
 * `leaveCommunity` to undo.
 */
export async function spectateCommunity(communityId: string): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_spectateCommunity',
    params: [normalizeHex(communityId)],
  });
}

/**
 * Loads a community by its key: an invite link or a `0x` identifier.
 *
 * @param communityKey - Community key or invite link.
 * @param waitForResponse - Whether to block until the network answers.
 * @returns The community, or `null` when it could not be loaded.
 * @remarks
 * `waitForResponse: false` does not block on a network reply: the interface shows
 * a loading state and updates when `community.found` arrives. With `true` the
 * call can hang for tens of seconds on a slow network, so use it only where
 * waiting is genuinely required — for example when the user expands a catalogue
 * entry whose description status-go is still fetching in the background. The
 * catalogue returns descriptions only for communities already in the database and
 * otherwise shows "Loading description…" until the contract list changes, so
 * waiting for one community the user explicitly opened is the reliable path.
 */
export async function fetchCommunity(
  communityKey: string,
  waitForResponse = false
): Promise<Community | null> {
  const res = await statusFetch<{ result?: Community | null }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_fetchCommunity',
    params: [{ communityKey, tryDatabase: true, waitForResponse }],
  });
  return res.result ?? null;
}

/**
 * Joins a community.
 *
 * @param communityId - Community id, with or without a `0x` prefix.
 * @returns The backend's response.
 * @remarks
 * `communityID` is a `cryptotypes.HexBytes`, a string with a `0x` prefix (see
 * internal/crypto/types/hex.go: `UnmarshalJSON` expects a string). An id without
 * the prefix fails to parse.
 */
export async function joinCommunity(communityId: string): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_joinCommunity',
    params: [normalizeHex(communityId)],
  });
}

/**
 * Leaves a community.
 *
 * @param communityId - Community id, with or without a `0x` prefix.
 * @returns The backend's response.
 */
export async function leaveCommunity(communityId: string): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_leaveCommunity',
    params: [normalizeHex(communityId)],
  });
}

/**
 * Removes a chat from the list (`wakuext_deactivateChat`).
 *
 * @param chatId - Chat id.
 * @param preserveHistory - Whether to keep message history.
 * @returns The backend's response.
 * @remarks
 * The request field is `id`, not `chatID`, as declared by
 * `requests.DeactivateChat` (internal/protocol/requests/deactivate_chat.go); with
 * `chatID` the backend answers "deactivate-chat: invalid id".
 *
 * `preserveHistory` defaults to `false`, which deletes the history together with
 * the chat. For a public channel this is the only way to "unsubscribe": the
 * channel has no owner, so it cannot be removed for everyone, but it can be
 * hidden locally.
 *
 * For a community channel this hides the channel, not the community; leaving the
 * community needs `leaveCommunity`.
 */
export async function deactivateChat(
  chatId: string,
  preserveHistory = false
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_deactivateChat',
    params: [{ id: chatId, preserveHistory }],
  });
}

/**
 * Joins a public channel, creating it if it does not exist yet.
 *
 * @param chatId - Channel name, with or without a leading `#`.
 * @returns The backend's response.
 * @remarks
 * status-go backs this with `CreatePublicChat`, which takes an object `{ id }`
 * (internal/protocol/requests/create_public_chat.go), not a string. `id` is the
 * channel name without the hash, for example `status`.
 */
export async function joinPublicChat(chatId: string): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_createPublicChat',
    params: [{ id: normalizeChatId(chatId) }],
  });
}

/**
 * Normalises an id to the `0x` form.
 *
 * @param id - Id with or without a `0x` prefix.
 * @returns The id with a single `0x` prefix, or the trimmed input when empty.
 * @remarks
 * status-go parses `HexBytes` only from a string with the prefix; without it
 * `UnmarshalJSON` fails and the call never happens.
 */
export function normalizeHex(id: string): string {
  const trimmed = id.trim();
  if (!trimmed) return trimmed;
  return trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
}

/**
 * Normalises a channel name to the form status-go expects.
 *
 * @param raw - User input, possibly `#status`, `t.me/status` or `status`.
 * @returns The channel name without a hash or a domain.
 */
export function normalizeChatId(raw: string): string {
  let id = raw.trim();
  // A channel link: t.me/<name> or https://t.me/<name>
  const link = id.match(/^(?:https?:\/\/)?(?:www\.)?t\.me\/([^/?#]+)/i);
  if (link) id = link[1];
  id = id.replace(/^#/, '');
  return id.trim();
}

/**
 * Extracts the channel UUID from a `status.app/cc/<uuid>#<key>` link.
 *
 * @param raw - Invite link text.
 * @returns The lowercase channel UUID, or `null` when the link carries none.
 * @remarks
 * This is the shape of `Chat.DeepLink()` in status-go, where `communityChannelID`
 * is a UUID matching `^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$`.
 * The value is returned only when it really looks like a UUID, because it is used
 * to look the channel up in `Community.chats`, where anything else finds nothing.
 * Links of other shapes (`/c/…`, `/user/…`) carry no channel.
 *
 * The second form of a channel link carries a brotli-compressed protobuf instead
 * of a UUID; it cannot be decoded in the webview and is handled by
 * `parseChannelInvite` through the Rust command. This function stays synchronous
 * and dependency-free for the plain-UUID case.
 */
export function channelIdFromInvite(raw: string): string | null {
  const m = raw.trim().match(/status\.app\/cc\/([^#?&\s]+)/i);
  if (!m) return null;

  let uuid: string;
  try {
    uuid = decodeURIComponent(m[1]).toLowerCase();
  } catch {
    // A broken percent escape must not raise.
    return null;
  }
  const re = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-5][0-9a-f]{3}-[089ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  return re.test(uuid) ? uuid : null;
}

/**
 * Parses a channel link in Rust, including the compressed payload form.
 *
 * @param raw - Link text.
 * @returns The channel id and names, or `null` when the link is not a channel
 * link or cannot be parsed.
 * @remarks
 * This path exists because of brotli: the second link form
 * (`status.app/cc/<brotli>#<key>`) carries a brotli-compressed protobuf with the
 * channel and community descriptions, and `DecompressionStream` in Chromium knows
 * gzip and deflate but not brotli, so the decoding happens in Rust. status-go has
 * its own parser (`sharedurls.Service`) but does not expose it as an RPC.
 *
 * Parsing failures do not throw: the community behind the key after `#` opens
 * regardless, just without the channel description.
 */
export async function parseChannelInvite(
  raw: string
): Promise<{ channelId: string | null; channelName: string | null; communityName: string | null } | null> {
  if (!/status\.app\/cc\//i.test(raw)) return null;

  // Try the cheap path first: a plain-text UUID, without Rust.
  const bare = channelIdFromInvite(raw);
  if (bare) return { channelId: bare, channelName: null, communityName: null };

  try {
    const parsed = await invoke<{
      channel_id: string | null;
      channel_name: string | null;
      community_name: string | null;
    } | null>('parse_invite_link', { url: raw });

    if (!parsed) return null;
    return {
      channelId: parsed.channel_id,
      channelName: parsed.channel_name,
      communityName: parsed.community_name,
    };
  } catch (e) {
    // The description is auxiliary: without it the community still opens, just
    // on its first channel.
    debug('[invite] failed to parse channel link:', e);
    return null;
  }
}

/**
 * Extracts a community id from a Status invite link.
 *
 * @param raw - Invite link or a bare community id.
 * @returns `0x`-hex community id, or the input unchanged when it cannot be
 * decoded.
 * @remarks
 * A link looks like
 *
 * ```
 * https://status.app/c/G0UAAGR0254s...==#zQ3shuaXi1bQ6iVowkgm6eUtt5PPToUUpifePDvereeupioks
 *                          └─ base64 ─┘  └─ base58btc, community key ─┘
 * ```
 *
 * The part after `/c/` is base64, while `FetchCommunityRequest.Validate` requires
 * hex. The part after `#` is multibase base58btc: a leading `z` marks base58,
 * followed by the two-byte varint multicodec prefix `0xe7 0x01` (`secp256k1-pub`)
 * and the 33-byte compressed public key. The community id is `0x` plus the hex of
 * those 33 bytes.
 *
 * When decoding fails the string is returned as is, so an already hex id is still
 * passed through and the backend reports a clear error.
 */
export function communityIdFromInvite(raw: string): string {
  const value = raw.trim();

  // The key after `#` is the main form for an invite link.
  const hashIdx = value.lastIndexOf('#');
  const candidate = hashIdx >= 0 ? value.slice(hashIdx + 1).trim() : value;

  if (/^0x[0-9a-fA-F]{64,}$/.test(candidate)) return candidate;
  if (candidate.startsWith('z')) {
    const decoded = base58ToHex(candidate);
    if (decoded) return decoded;
  }
  return candidate;
}

/**
 * Decodes multibase base58btc into the `0x`-hex compressed public key.
 *
 * @param s - Base58btc string with the `z` prefix.
 * @returns Hex key with the `0x` prefix, or `null` when the input is not a key.
 * @remarks
 * Exactly the two-byte varint multicodec prefix is removed. Its length is fixed
 * for `secp256k1-pub` (`0xe7 0x01`), so no parsing is needed: 33 key bytes must
 * remain. A longer prefix means the input is not what it claims to be, and bytes
 * are not cut off at a guess.
 */
function base58ToHex(s: string): string | null {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let num = 0n;
  for (const ch of s.slice(1)) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) return null;
    num = num * 58n + BigInt(idx);
  }
  if (num === 0n) return null;

  let hex = num.toString(16);
  if (hex.length % 2) hex = '0' + hex;
  const bytes = hex.length / 2;

  // 35 bytes is a 2-byte multicodec prefix plus a 33-byte key. Anything longer
  // means a longer prefix, and cutting at a guess would be wrong.
  const prefixLen = bytes - 33;
  if (prefixLen < 1 || prefixLen > 2) return null;

  return '0x' + hex.slice(prefixLen * 2);
}

/**
 * Flattens communities into a single list of channels.
 *
 * @param communities - Communities with their nested `chats`.
 * @returns Channels with `communityId` and `categoryId` set, so the interface can
 * build group headings.
 * @remarks
 * A key in `Community.chats` is a bare channel name (`intros`), while `Chat.id` in
 * status-go is `communityID + channelID` (internal/protocol/communities/community.go,
 * `ChatID`). The ids must match: the result of this function is what gets looked
 * up in `wakuext_chats` and passed to `sendChatMessage` as `chatId`. A bare name
 * would send messages to a chat that does not exist and would also list the
 * channel twice.
 */
export function communityChannels(communities: Community[]): CommunityChat[] {
  const out: CommunityChat[] = [];
  for (const community of communities) {
    const chats = community.chats || {};
    for (const [channelId, chat] of Object.entries(chats)) {
      out.push({
        ...chat,
        id: communityChatId(community.id, channelId),
        communityId: community.id,
        communityName: community.name,
      });
    }
  }
  return out;
}

// ===========================================================================
// SENDING
// ===========================================================================

/**
 * Sends a text message.
 *
 * @param chatId - Full chat id.
 * @param text - Message body.
 * @param communityId - Community id for messages in community channels; an empty
 * string for direct chats and public channels.
 * @param responseTo - Id of the message being answered; an empty string sends an
 * ordinary message.
 * @returns The backend's response.
 * @remarks
 * `wakuext_sendChatMessage` takes a single `*common.Message` object, not separate
 * strings — the shape here is what `Message.UnmarshalJSON` parses
 * (internal/protocol/common/message.go): `id` and `chatId` sit at the top level
 * (on the Go side they come from the embedded `protobuf.ChatMessage`), and
 * `contentType: 1` is plain text. Passing `chatId` and `text` as separate
 * arguments is not accepted.
 *
 * `responseTo` turns the message into a comment. It works without a feature flag,
 * unlike `threadId`, which the backend silently clears when
 * `featureFlags.Threads` is off (messenger.go, `message.ThreadId = nil`). The
 * backend accepts only the id of a message it already holds (`MessagesExist`,
 * `SELECT id FROM user_messages WHERE id IN (...)` with no chat filter), so the
 * parent must be loaded before it can be answered.
 *
 * A reply stays an ordinary row with the same `local_chat_id`, so it arrives in
 * the channel's general list: separating entries from comments is the client's
 * job, see `isReply`.
 */
export async function sendChatMessage(
  chatId: string,
  text: string,
  communityId = '',
  responseTo = ''
): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 3,
    method: 'wakuext_sendChatMessage',
    params: [
      {
        id: '',
        chatId,
        text,
        contentType: 1,
        communityId,
        responseTo,
      },
    ],
  });
}

/**
 * Whether a message is a comment.
 *
 * @param msg - Message record, possibly absent.
 * @returns `true` when the message carries a non-empty `responseTo`.
 * @remarks
 * status-go does not distinguish entries from replies at the channel level: a
 * comment sits in the same `user_messages` table with the same `local_chat_id`.
 * `MessageByChatID` filters on `response_to` only through `thread_id`, and that
 * filter is off when threads are disabled ("If threads are disabled, then we are
 * backwards compatible and messages in threads are treated as normal messages")
 * — so the separation is the client's, and it belongs in one place, or the channel
 * feed and the comment panel will disagree.
 */
export function isReply(msg: { responseTo?: string } | null | undefined): boolean {
  return !!msg?.responseTo && msg.responseTo.length > 0;
}

// ===========================================================================
// CONTACTS
// ===========================================================================

// Contacts share the same namespace and are used by the chat list to resolve
// display names, so they live here too.
export async function getContacts(): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_contacts',
    params: [],
  });
}

export async function acceptContactRequest(contactPublicKey: string): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_acceptLatestContactRequestForContact',
    params: [{ id: contactPublicKey }],
  });
}

/**
 * Declines an incoming contact request.
 *
 * @param contactPublicKey - Public key of the contact.
 * @returns The backend's response.
 * @remarks
 * status-go looks the request up by `id` and, when no record has that id, falls
 * back to the deterministic `defaultContactRequestID(contactId)`. The id computed
 * here is that same value, so it matches the row stored for a request from this
 * contact.
 */
export async function declineContactRequest(contactPublicKey: string): Promise<any> {
  const id = '0x' + contactPublicKey.replace(/^0x/, '') + '20';
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_declineContactRequest',
    params: [{ id, contactId: contactPublicKey }],
  });
}

/** Marks every message in a chat as read, clearing its unread counter. */
export async function markChatRead(chatId: string): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_markAllRead',
    params: [chatId],
  });
}

/**
 * Pushes the profile's identity to contacts that were already added.
 *
 * @param ensName - The profile's ENS name; empty when it has none.
 * @returns The backend's response.
 * @remarks
 * A contact request carries the identity from settings at the time it was sent, and a
 * contact that already received it keeps the old one until an update arrives. Call this
 * after the name is saved to the profile, and after an ENS name is registered.
 *
 * The parameter is the *ENS* name, not the display name: `SendContactUpdates(ctx,
 * ensName, profileImage, …)` in status-go reads the display name from settings itself
 * (`m.settings.DisplayName()`). Passing the display name here sent it to contacts as an
 * ENS name, which is why nobody received the right value for either field.
 */
export async function sendContactUpdates(ensName = ''): Promise<any> {
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_sendContactUpdates',
    // status-go arguments: ensName, profileImage, customizationColor.
    params: [ensName, '', 'primary'],
  });
}

/**
 * Sends a contact request.
 *
 * @param publicKey - Contact public key, compressed `0x`-hex or multibase.
 * @param message - Greeting; empty falls back to a default.
 * @returns The backend's response.
 * @remarks
 * status-go rejects an empty message
 * (`requests.SendContactRequest.Validate`: `ErrSendContactRequestInvalidMessage`),
 * and the invite-by-key screen does not ask for one, so empty text is replaced
 * with a default greeting: without it the request never leaves.
 *
 * A compressed key must be sent in multibase form (`zQ3…`). status-go decodes
 * `0x`-hex as `f` + hex and reads the first byte `03` as a key-type code, which
 * yields `unsupported public key type '3'`. A legacy uncompressed key (132
 * characters) is accepted as is, so it is passed through unchanged.
 */
export async function sendContactRequest(
  publicKey: string,
  message = ''
): Promise<any> {
  const text = message.trim() || 'Hi! Please add me as a contact.';
  // status-go expects a multibase key (`zQ3…`). It decodes `0x`-hex as `f` + hex,
  // so the leading `03` byte reads as a key-type code and the call fails with
  // `unsupported public key type '3'`.
  let id = publicKey.trim();
  if (/^0x[0-9a-fA-F]{66}$/.test(id)) {
    id = hexToBase58Key(id);
  }
  return await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_sendContactRequest',
    params: [{ id, message: text }],
  });
}
