/**
 * Author–Channel–Comments (AKK) scheme on top of status-go.
 *
 * A user creates a channel and writes entries into it; comments are replies to
 * entries. The word "community" does not appear in the interface.
 *
 * status-go only keeps a channel inside a community, so each channel gets its
 * own community holding exactly that one channel. The channel-to-community link
 * is not stored anywhere: it is derived from `Community.chats` (see
 * `communityChannels` in `messaging.ts`).
 *
 * @remarks
 * `wakuext_createCommunity` always creates a channel named `general`, so the
 * name the author enters becomes the community name and is displayed as the
 * channel name. Community names are limited to 30 bytes and descriptions to
 * 140; both are checked here to avoid an internal backend error.
 *
 * Replies rely on `responseTo` rather than threads: threads are disabled in this
 * build and `responseTo` works without a feature flag. The full scheme is
 * described in `docs/ru/akk_scheme.md`.
 *
 * Joining order matters: this build has no
 * `wakuext_requestCommunityInfoFromMailserver`, so history is never backfilled
 * and entries posted before a member joins are never delivered to them.
 */

import { statusFetch } from './http';
import { KIND_JOINS_BY_REQUEST, withKindPrefix, type ChannelKind } from './channelKind';
import { CommunityAccessValue, normalizeHex, sendChatMessage } from './messaging';

export const CHANNEL_NAME_MAX = 30;
export const CHANNEL_DESCRIPTION_MAX = 140;

export interface CreateChannelParams {
  /** Channel name, which is also the name of the backing community. */
  name: string;
  /** Short channel description. */
  description: string;
  /**
   * Channel kind, which decides who may join and who may post.
   *
   * - `news` — open: anyone may join; only the author posts, members comment;
   * - `request` — joining needs approval; only the author posts, members comment.
   *
   * Entries and comments are the same entity for status-go, so "only the author
   * posts entries" is enforced by the client, not by the backend.
   */
  kind: ChannelKind;
}

export interface CreatedChannel {
  /** Id of the community that holds the channel (`0x`-hex). */
  communityId: string;
  /** Full chat id for `sendChatMessage` (`communityId` + `channelId`). */
  chatId: string;
}

/**
 * Validates a channel name and description before they reach status-go.
 *
 * @param name - Channel name as entered by the author.
 * @param description - Channel description as entered by the author.
 * @returns An error message to show to the user, or `null` when the input is
 * valid.
 * @remarks
 * Length is measured in UTF-8 bytes because status-go compares `len(c.Name)`: a
 * Cyrillic or emoji name can pass a JavaScript character count here and still be
 * rejected by the backend as `create-community: invalid name`.
 */
export function validateChannelInput(name: string, description: string): string | null {
  const n = name.trim();
  const d = description.trim();
  if (!n) return 'Enter a channel name';
  // A channel link pasted into the name field: point at the search field
  // instead of reporting an over-long name.
  if (/status\.app\//i.test(n) || /^0x[0-9a-fA-F]{32,}/.test(n)) {
    return 'This looks like an invite link. Paste it in the search field to join the channel.';
  }
  if (utf8Length(n) > CHANNEL_NAME_MAX) {
    return `Name is longer than ${CHANNEL_NAME_MAX} bytes`;
  }
  if (!d) return 'Enter a description';
  if (utf8Length(d) > CHANNEL_DESCRIPTION_MAX) {
    return `Description is longer than ${CHANNEL_DESCRIPTION_MAX} bytes`;
  }
  return null;
}

/**
 * Byte length of a string in UTF-8, the unit status-go uses for `len(c.Name)`.
 *
 * Cyrillic characters take 2 bytes and emoji 4, so `.length` undercounts and a
 * name accepted here can still fail in status-go.
 *
 * @param s - String to measure.
 * @returns Length of its UTF-8 encoding in bytes.
 */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Creates a channel as a community that holds a single channel.
 *
 * @param params - Name, description and kind of the new channel.
 * @returns The community id and the full chat id of the created channel.
 * @throws When status-go returns an error or yields no community or channel.
 * @remarks
 * The kind travels as a prefix inside the description (`withKindPrefix`) and
 * decides the membership mode: `news` is accepted automatically, `request` and
 * `issues` wait for the author. The returned chat is the `general` channel the
 * backend creates.
 */
export async function createChannel(
  params: CreateChannelParams
): Promise<CreatedChannel> {
  const membership =
    KIND_JOINS_BY_REQUEST[params.kind] ? CommunityAccessValue.ManualAccept : CommunityAccessValue.AutoAccept;

  const res = await statusFetch<{
    result?: {
      communities?: Array<{ id: string }>;
      chats?: Array<{ id: string }>;
    };
    error?: { message?: string };
  }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_createCommunity',
    params: [
      {
        name: params.name.trim(),
               description: withKindPrefix(params.kind, params.description.trim()),
        color: '#4360DF',
 emoji: '',
 membership,
 ensOnly: false,
        image: '',
        imageAx: 0,
        imageAy: 0,
        imageBx: 0,
        imageBy: 0,
        banner: { imagePath: '', x: 0, y: 0, width: 0, height: 0 },
      },
    ],
  });

  if (res.error) {
    throw new Error(res.error.message || 'createCommunity failed');
  }

  const community = res.result?.communities?.[0];
  const chat = res.result?.chats?.[0];
  if (!community || !chat) {
    throw new Error('createCommunity returned no community or channel');
  }

  return { communityId: community.id, chatId: chat.id };
}

// ===========================================================================
// JOIN REQUESTS (author side)
// ===========================================================================

export interface PendingJoinRequest {
  /** Request id, passed to accept and decline. */
  id: string;
  /** Public key of the account asking for access. */
  publicKey: string;
  communityId: string;
  clock: number;
}

/**
 * Join requests waiting for the channel author's decision.
 *
 * @param communityId - Community id, with or without a `0x` prefix.
 * @returns Pending requests, or an empty array when the call fails.
 * @remarks
 * Failures are reported as an empty list: a failed request and a community with
 * no pending requests look the same to the user, and the next poll shows the
 * real state.
 */
export async function pendingJoinRequests(
  communityId: string
): Promise<PendingJoinRequest[]> {
  const res = await statusFetch<{
    result?: Array<{ id: string; publicKey: string; communityId: string; clock: number }>;
    error?: { message?: string };
  }>('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_pendingRequestsToJoinForCommunity',
    params: [normalizeHex(communityId)],
  });
  if (res.error) return [];
  return res.result || [];
}

/**
 * Accepts a join request, giving the requester access to the channel.
 *
 * @param requestId - Request id from `pendingJoinRequests`.
 */
export async function acceptJoinRequest(requestId: string): Promise<void> {
  await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_acceptRequestToJoinCommunity',
    params: [{ id: normalizeHex(requestId) }],
  });
}

/**
 * Declines a join request.
 *
 * @param requestId - Request id from `pendingJoinRequests`.
 */
export async function declineJoinRequest(requestId: string): Promise<void> {
  await statusFetch('CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_declineRequestToJoinCommunity',
    params: [{ id: normalizeHex(requestId) }],
  });
}

// ===========================================================================
// COMMENTS
// ===========================================================================

/**
 * Posts a comment on a channel entry.
 *
 * @param channelChatId - Full chat id of the channel.
 * @param communityId - Community that owns the channel.
 * @param parentMessageId - Id of the entry being answered.
 * @param text - Comment body.
 * @returns The created message, as returned by status-go.
 * @remarks
 * A comment is an ordinary message carrying `responseTo`. The backend accepts a
 * `responseTo` only for a message it already holds, so the entry must be loaded
 * before it can be answered.
 */
export function sendComment(
  channelChatId: string,
  communityId: string,
  parentMessageId: string,
  text: string
): Promise<unknown> {
  return sendChatMessage(channelChatId, text, communityId, parentMessageId);
}
