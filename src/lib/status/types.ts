export interface StartBackendResponse {
  /** Real status-backend port. Internal; the frontend does not use it. */
  port: number;
  /** Authenticating proxy port, through which all traffic flows. */
  authPort: number;
  dataDir: string;
  networkName: string;
  chainId: number;
  rpcUrl: string;
  wakuFleet: string;
  isTestnet: boolean;
}

export interface InitializeResponse {
  accounts: any[] | null;
}

export interface StatusEventBase {
  type: string;
  timestamp: number;
}

export interface NodeLoginEvent extends StatusEventBase {
  type: 'node.login';
  event: {
    error?: string;
    settings?: {
      'key-uid': string;
      'display-name': string;
      'public-key': string;
      /** Compressed key, `zQ3…`, which the profile link is built from. */
      compressedKey?: string;
      mnemonic: string;
      /** Three-word alias, for example "Sarcastic Kind Eidolonhelvum". */
      alias?: string;
    };
  };
}

export interface GenericEvent extends StatusEventBase {
  event: any;
}

export type StatusEvent = NodeLoginEvent | MessagesNewEvent | GenericEvent;

export interface WalletBalance {
  symbol: string;
  balance: string; // wei or the token's smallest unit, as a string
  decimals: number;
}

export interface ChatMessage {
  id: string;
  chatId: string;
  from: string;
  text: string;
  timestamp: number;
}

/**
 * Chat record as status-go returns it.
 *
 * `chatType` is a number, not a string (see `ChatType` in `messaging.ts`), and
 * filtering by string silently finds nothing. The community fields
 * (`communityId`, `categoryId`) are set only on channels inside communities;
 * the list groups chats by them.
 */
export interface Chat {
  id: string;
  name: string;
  description?: string;
  color?: string;
  emoji?: string;
  /** Soft delete: the chat is hidden from the list. */
  active: boolean;
  chatType: number;
  timestamp: number;
  unviewedMessagesCount: number;
  unviewedMentionsCount: number;
  lastMessage?: ChatMessage | null;
  muted?: boolean;
  /** Community id, when the chat belongs to a community. */
  communityId?: string;
  /** Category id inside the community. */
  categoryId?: string;
  /** Whether posting is allowed (accounts for permissions and token gating). */
  canPost?: boolean;
}

/** A channel inside a community (`Community.chats` in a status-go response). */
export interface CommunityChat {
  id: string;
  name: string;
  color?: string;
  emoji?: string;
  description?: string;
  canPost: boolean;
  canView: boolean;
  position?: number;
  categoryID?: string;
  tokenGated?: boolean;
  /** Filled in on our side when the list is flattened. */
  communityId?: string;
  communityName?: string;
}

export interface CommunityCategory {
  id: string;
  name: string;
  position?: number;
}

/**
 * How a community lets people in (`CommunityPermissions_Access`).
 *
 * Values come from internal/protocol/protobuf/communities.pb.go. They can be
 * compared as numbers, but a string is easier to read in code:
 *   * `open`    — AUTO_ACCEPT (1), the request is accepted automatically;
 *   * `request` — MANUAL_ACCEPT (3), the owner decides;
 *   * `token`   — there is a BECOME_MEMBER right (type = 2), a token is required;
 *   * `unknown` — UNKNOWN_ACCESS (0) or the field is absent; treated as
 *                 `request`, because "access must always be requested" is the
 *                 status-go default.
 */
export type CommunityAccess = 'open' | 'request' | 'token' | 'unknown';

/**
 * Community permissions, the nested `permissions` object.
 *
 * `access` is a number from the enum. `ensOnly` arrives as `ens_only`, the JSON
 * tag on the protobuf struct.
 */
export interface CommunityPermissions {
  access?: number;
  ens_only?: boolean;
  private?: boolean;
}

/**
 * Token permission (`CommunityTokenPermission`).
 *
 * `type` is an enum: 1 BECOME_ADMIN, 2 BECOME_MEMBER, 3 CAN_VIEW_CHANNEL,
 * 4 CAN_VIEW_AND_POST_CHANNEL, 5 BECOME_TOKEN_MASTER, 6 BECOME_TOKEN_OWNER.
 */
export interface CommunityTokenPermission {
  id?: string;
  type?: number;
  token_criteria?: any[];
  chat_ids?: string[];
  is_private?: boolean;
}

/** A community with all its channels and categories. */
export interface Community {
  id: string;
  name: string;
  description?: string;
  color?: string;
  joined: boolean;
  isMember?: boolean;
  muted?: boolean;
  /** Viewing without joining (spectate). */
  spectated?: boolean;
  /** Map of channel id to channel. A map, not an array. */
  chats: Record<string, CommunityChat>;
  /** Map of category id to category. */
  categories: Record<string, CommunityCategory>;
  activeMembersCount?: number;
  /**
   * Joining requires approval (MANUAL_ACCEPT).
   *
   * `false` because the user is ALREADY a member and `false` because the
   * community is open are indistinguishable here, so this field alone is not an
   * answer: read it together with `joined`/`isMember`, or prefer
   * `permissions.access` through `communityAccess()`.
   */
  canRequestAccess?: boolean;
  /**
   * Whether the current user may decide join requests (owner or admin).
   * For AKK this marks the channel author.
   */
  canManageUsers?: boolean;
  /**
   * Role of the current user in the community (`CommunityMember_Roles`):
   * 1 is owner (channel author), 4 is admin, 0 is a regular member.
   */
  memberRole?: number;
  /** Joining needs no approval (AUTO_ACCEPT) and the user is not a member yet. */
  canJoin?: boolean;
  permissions?: CommunityPermissions;
  tokenPermissions?: Record<string, CommunityTokenPermission>;
}

export interface MessagesNewEvent extends StatusEventBase {
  type: 'messages.new';
  event: {
    messages: ChatMessage[];
  };
}
