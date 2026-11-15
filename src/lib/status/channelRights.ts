/**
 * Posting rules for AKK channels (see `channelKind.ts`).
 *
 * Entries (messages without `responseTo`) and comments (replies carrying
 * `responseTo`) are governed by different rules. status-go only exposes
 * `canPost` and does not tell them apart, so "entries are written by the author
 * only" is enforced in the interface.
 */

import { KIND_RECORDS_BY_AUTHOR_ONLY, type ChannelKind } from './channelKind';

/** `CommunityMember_ROLE_OWNER`: the channel author. */
export const ROLE_OWNER = 1;

/**
 * Whether the user may post an entry to a channel of this kind.
 *
 * @param kind - Channel kind, or `undefined` for a direct message.
 * @param memberRole - Current user's role in the community.
 * @returns `false` when the kind restricts entries to the owner and the user is
 * not the owner.
 * @remarks
 * Kinds such as `news` and `request` allow entries for the owner only; `issues`
 * allows them for anyone allowed to post. Without a kind (a 1-1 chat) the
 * channel rule does not apply and `canPost` decides.
 */
export function canRecord(kind: ChannelKind | undefined, memberRole: number | undefined): boolean {
  if (!kind) return true;
  if (KIND_RECORDS_BY_AUTHOR_ONLY[kind]) return memberRole === ROLE_OWNER;
  return true;
}

/**
 * Whether the user may comment.
 *
 * @param canPost - `canPost` from status-go for the channel.
 * @returns `false` only when status-go explicitly denies posting.
 * @remarks
 * There is no separate comment right: anyone allowed to post in the channel may
 * comment. An absent `canPost` is treated as permission.
 */
export function canComment(canPost: boolean | undefined): boolean {
  return canPost !== false;
}
