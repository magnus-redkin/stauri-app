/**
 * Communities section: catalog, preview and joining.
 *
 * It is separate from `chatsStore` because the two answer different questions: chats are "what I
 * already have", communities are "what exists and how to get in". Merging them would put
 * preview-only fields (catalog, access, request state) into `ChatItem` and chat fields into the
 * catalog.
 *
 * @remarks
 * `wakuext_curatedCommunities` returns descriptions only for communities already cached, plus a
 * separate list of ids it fetches in the background. A first call therefore often yields an empty
 * map with a non-empty id list: that is a normal state, not a failure. Such entries are shown
 * unnamed until status-go delivers the description.
 */

import { statusState } from './statusStore.svelte';
import {
  communityAccess,
  getCuratedCommunities,
  getCommunities,
  fetchCommunity,
  spectateCommunity,
  checkPermissionsToJoinCommunity,
  generateJoiningRequestsForSigning,
  signJoinRequestData,
  requestToJoinCommunity,
  communityChatId,
} from '$lib/status/messaging';
import { getAccounts } from '$lib/status/api';
import { chatsState, loadChats } from './chatsStore.svelte';
import { debug, info, warn } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';
import type { Community, CommunityAccess, CommunityChat } from '$lib/status/types';

/** Catalog entry; its description may not be loaded yet. */
export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  access: CommunityAccess;
  /** Featured in the contract; SIM lists these first. */
  featured: boolean;
  /** Description received; otherwise only the id is available. */
  loaded: boolean;
  joined: boolean;
  spectated: boolean;
  activeMembersCount?: number;
  community?: Community;
}

/**
 * A catalog tree node: a category (or "uncategorized") and its channels.
 *
 * Categories are `Community.categories` with a `position`, and a channel references its category
 * through `categoryID`. An empty `categoryID` means the channel sits outside any category; SIM
 * groups those at the top, and so does this module.
 */
export interface ChannelGroup {
  id: string;
  name: string;
  channels: CommunityChatNode[];
}

export interface CommunityChatNode {
  id: string;
  name: string;
  canView: boolean;
  canPost: boolean;
  tokenGated: boolean;
  /** The chat is already in the chat list, so there is nothing to add. */
  added: boolean;
}

export const communitiesState = $state({
  entries: [] as CatalogEntry[],
  /** Catalog search text. Filtering is client-side: the catalog arrives whole. */
  query: '',
  isLoading: false,
  loaded: false,
  /** Community open in the preview. */
  selected: null as CatalogEntry | null,
  /** Spectating or joining in progress. */
  isBusy: false,
  /** Error from the last action, shown in the preview. */
  error: '',
  /** Result of the join-permission check. */
  eligibility: null as null | {
    checked: boolean;
    satisfied: boolean;
    addresses: string[];
    networksNotSupported: boolean;
  },
  /** Wallet addresses of the profile (candidates to reveal). */
  walletAddresses: [] as string[],
});

/** Maps a `Community` from status-go to a catalog entry. */
function toEntry(community: Community, featured: boolean): CatalogEntry {
  return {
    id: community.id,
    name: community.name || community.id.slice(0, 10),
    description: community.description || '',
    access: communityAccess(community),
    featured,
    loaded: true,
    joined: community.joined === true,
    spectated: community.spectated === true,
    activeMembersCount: community.activeMembersCount,
    community,
  };
}

/**
 * Loads the catalog and merges it with locally known communities.
 *
 * Two sources, because neither is complete alone: the catalog is limited to Directory-contract
 * entries but carries `featured`, while `wakuext_communities` holds everything known locally,
 * including joined and spectated communities the contract may omit.
 *
 * @param force - when true, reloads even if already loaded.
 */
export async function loadCommunities(force = false): Promise<void> {
  if (!statusState.backendRunning) return;
  if (communitiesState.loaded && !force) return;

  communitiesState.isLoading = true;
  try {
    const [curated, known] = await Promise.all([
      getCuratedCommunities().catch((e) => {
        warn('[communities] curated failed:', e);
        return {
          ids: [] as string[],
          featured: [] as string[],
          descriptions: {} as Record<string, Community>,
          unknown: [] as string[],
        };
      }),
      getCommunities().catch((e) => {
        warn('[communities] communities failed:', e);
        return [] as Community[];
      }),
    ]);

    info(
      `[communities] curated ids=${curated.ids.length} ` +
        `described=${Object.keys(curated.descriptions).length} ` +
        `unknown=${curated.unknown.length} known=${known.length}`
    );

    // Plain Set/Map rather than the Svelte versions: these are locals inside one function and are
    // gone by the time the UI reads anything. Reactivity belongs to the final
    // `communitiesState.entries`, not to intermediate inserts.
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local cache, same call
    const featured = new Set(curated.featured);
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- local cache, same call
    const byId = new Map<string, CatalogEntry>();

    // 1. Locally known ones: they have a description and membership state.
    for (const community of known) {
      const entry = toEntry(community, featured.has(community.id));
      byId.set(community.id, entry);
    }

    // 2. Catalog: fills in and adds what is not known locally.
    for (const id of curated.ids) {
      const described = curated.descriptions[id];
      if (described) {
        const entry = toEntry(described, featured.has(id));
        // The local record is more accurate for `joined`/`spectated`: it came from the database.
        const local = byId.get(id);
        byId.set(id, local ? { ...entry, joined: local.joined, spectated: local.spectated } : entry);
      } else if (!byId.has(id)) {
        byId.set(id, {
          id,
          name: '',
          description: '',
          access: 'unknown',
          featured: featured.has(id),
          loaded: false,
          joined: false,
          spectated: false,
        });
      }
    }

    communitiesState.entries = [...byId.values()].sort((a, b) => {
      // Featured first, then by name, as SIM shows Discover.
      if (a.featured !== b.featured) return a.featured ? -1 : 1;
      return (a.name || a.id).localeCompare(b.name || b.id);
    });

    communitiesState.loaded = true;
  } catch (e) {
    warn('[communities] load failed:', e);
  } finally {
    communitiesState.isLoading = false;
  }
}

/** Catalog entries matching the search text. */
export function filteredEntries(): CatalogEntry[] {
  const q = communitiesState.query.trim().toLowerCase();
  if (!q) return communitiesState.entries;
  return communitiesState.entries.filter(
    (e) => e.name.toLowerCase().includes(q) || e.id.toLowerCase().includes(q)
  );
}

/**
 * Channel tree of the selected community: categories and the channels inside them.
 *
 * Channels are grouped and ordered by category `position` because a community is laid out like a
 * catalog, and a flat list would lose that structure; SIM shows the same thing as folders. Every
 * channel the backend returned is included, even ones that cannot be read (`canView: false`),
 * since the preview benefits from showing that closed channels exist. `added` marks channels
 * already in the chat list so a second click cannot confuse the user.
 *
 * @param community - Community to build the tree for.
 * @returns One group per non-empty category, with uncategorized channels first.
 */
export function channelTree(community: Community | null | undefined): ChannelGroup[] {
  if (!community?.chats) return [];

  const chats = Object.entries(community.chats) as [string, CommunityChat][];
  const categories = community.categories || {};

  // Order categories by `position`, the rest at the end by name.
  const cats = Object.entries(categories)
    // Take `id` from the map key: a category's own `id` field may be empty, while references to it
    // (`chat.categoryID`) are the keys.
    .map(([id, cat]) => ({ ...cat, id }))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0));

  // The map key is the channel id: status-go returns `Community.chats` as a map and the inner
  // `chat.id` may be empty, so the key is authoritative.
  const node = (channelId: string, chat: CommunityChat): CommunityChatNode => ({
    id: channelId,
    name: chat.name,
    canView: chat.canView !== false,
    canPost: chat.canPost === true,
    tokenGated: chat.tokenGated === true,
    added: false,
  });

  const byCategory = new Map<string, CommunityChatNode[]>();
  const uncategorized: CommunityChatNode[] = [];

  const sorted = chats.sort(
    (a, b) => (a[1].position ?? 0) - (b[1].position ?? 0)
  );

  for (const [channelId, chat] of sorted) {
    if (chat.categoryID && categories[chat.categoryID]) {
      const bucket = byCategory.get(chat.categoryID);
      if (bucket) bucket.push(node(channelId, chat));
      else byCategory.set(chat.categoryID, [node(channelId, chat)]);
    } else {
      uncategorized.push(node(channelId, chat));
    }
  }

  const groups: ChannelGroup[] = [];
  if (uncategorized.length) {
    groups.push({ id: '', name: 'Channels', channels: uncategorized });
  }
  for (const cat of cats) {
    const items = byCategory.get(cat.id);
    if (items?.length) groups.push({ id: cat.id, name: cat.name, channels: items });
  }
  return groups;
}

/**
 * Opens a channel of a community and adds it to the chat list.
 *
 * @param entry - Catalog entry of the community.
 * @param channelId - Channel id inside that community.
 * @returns `ok` with the chat id to select, `failed` with the reason otherwise.
 * @remarks
 * The channel is made readable by spectating, not joining: reading starts as soon as the community
 * is spectated (as SIM shows `#intros` before joining), since `spectateCommunity` creates the
 * `Chat` rows via `initCommunityChats`. Posting still needs membership, and joining stays a
 * separate decision because it needs addresses and a password. Switching sections stays with the
 * caller, because the active section lives in `+page.svelte`.
 */
export async function openChannel(
  entry: CatalogEntry,
  channelId: string
): Promise<{ ok: boolean; chatId?: string; error?: string }> {
  if (!statusState.backendRunning) return { ok: false, error: 'Backend is not running' };

  communitiesState.isBusy = true;
  communitiesState.error = '';
  try {
    // Idempotent: for an already spectated community status-go answers "already spectated", which
    // is no reason to stop. The stored state (`spectated`/`joined`) may be stale, for instance
    // after a node restart, so call every time and swallow the error.
    if (!entry.joined) {
      await spectateCommunity(entry.id).catch((e) => {
        debug(`[communities] spectate ${entry.id} skipped:`, e);
      });
    }

    const chatId = communityChatId(entry.id, channelId);

    // `loadChats(true)`: channels appear only after the backend initialises filters and creates
    // `Chat` rows during spectating.
    await loadChats(true);

    const found = chatsState.items.some((c) => c.id === chatId);
    if (!found) {
      // The channel is not in the list: not a join failure, but there is nothing to open either.
      return { ok: false, error: 'Channel is not readable' };
    }

    info(`[communities] opened channel ${chatId}`);
    return { ok: true, chatId };
  } catch (e) {
    const error = formatError(e);
    communitiesState.error = error;
    return { ok: false, error };
  } finally {
    communitiesState.isBusy = false;
  }
}

/**
 * Opens a community preview.
 *
 * @param entry - Catalog entry to select.
 * @remarks
 * Spectating runs immediately, since it is what makes channels readable before joining, matching
 * SIM. It is only irreversible in that it writes to the status-go database, which `leaveCommunity`
 * undoes.
 */
export async function selectCommunity(entry: CatalogEntry): Promise<void> {
  communitiesState.selected = entry;
  communitiesState.error = '';
  communitiesState.eligibility = null;

  if (!statusState.backendRunning) return;

  // Already a member or already spectating: a repeated spectate answers "already spectated or
  // joined", so there is nothing to call.
  if (entry.joined || entry.spectated) return;

  communitiesState.isBusy = true;
  try {
    // Wait for the answer: an entry from `unknownCommunities` has no cached description, so without
    // waiting status-go only starts a background fetch and returns empty. The user is already
    // looking at the catalog tree, so an explicit wait for one community beats an endless spinner.
    const fresh = await fetchCommunity(entry.id, !entry.joined);
    if (fresh) {
      const updated = toEntry(fresh, entry.featured);
      communitiesState.selected = updated;
      const idx = communitiesState.entries.findIndex((e) => e.id === entry.id);
      if (idx >= 0) communitiesState.entries[idx] = updated;
      debug(`[communities] spectating ${entry.id}`);
    } else {
      warn(`[communities] no description for ${entry.id}`);
    }
  } catch (e) {
    // Spectating is not critical: the community still opens in the preview, its channels may just
    // stay unreadable.
    warn('[communities] spectate failed:', e);
  } finally {
    communitiesState.isBusy = false;
  }
}

/** Wallet addresses of the profile, candidates for revealing. */
export async function loadWalletAddresses(): Promise<string[]> {
  if (!statusState.backendRunning) return [];
  if (communitiesState.walletAddresses.length) return communitiesState.walletAddresses;

  try {
    const accounts = await getAccounts();
    const addresses = accounts
      .filter((a: any) => a && a.address && !a.chat)
      .map((a: any) => String(a.address));
    communitiesState.walletAddresses = addresses;
    return addresses;
  } catch (e) {
    warn('[communities] accounts failed:', e);
    return [];
  }
}

/**
 * Checks whether this profile's addresses meet the community's conditions.
 *
 * Runs when a token-gated preview opens and supplies the "You are eligible to join as member"
 * answer.
 */
export async function checkEligibility(): Promise<void> {
  const entry = communitiesState.selected;
  if (!entry || !statusState.backendRunning) return;

  communitiesState.isBusy = true;
  communitiesState.error = '';
  try {
    const addresses = await loadWalletAddresses();
    const res = await checkPermissionsToJoinCommunity(
      entry.id,
      addresses
    );
    communitiesState.eligibility = {
      checked: true,
      satisfied: res.satisfied,
      addresses: res.validCombinations.map((c) => c.address),
      networksNotSupported: res.networksNotSupported,
    };
    info(
      `[communities] eligibility ${entry.id}: satisfied=${res.satisfied} ` +
        `addresses=${res.validCombinations.length}`
    );
  } catch (e) {
    communitiesState.error = formatError(e);
  } finally {
    communitiesState.isBusy = false;
  }
}

/**
 * Joins the selected community: signs the addresses and sends the request.
 *
 * @param addressesToReveal - Addresses to reveal in the request.
 * @param airdropAddress - One of the revealed addresses that receives the airdrop.
 * @param password - Profile password needed to sign.
 * @returns `ok` with `pending: true` when the request was sent, `failed` with the reason otherwise.
 * @remarks
 * `RequestToJoinCommunity` requires a non-empty address list, an `airdropAddress` inside it and a
 * signature per address; status-go signs but verifies the password first
 * (`GetVerifiedWalletAccount`), so joining needs address selection and a password rather than a
 * single button. Even for an open community (`AUTO_ACCEPT`) acceptance arrives later as a signal,
 * so the result is always a pending request.
 */
export async function joinSelectedCommunity(
  addressesToReveal: string[],
  airdropAddress: string,
  password: string
): Promise<{ ok: boolean; pending?: boolean; error?: string }> {
  const entry = communitiesState.selected;
  if (!entry || !statusState.backendRunning) {
    return { ok: false, error: 'No community selected' };
  }
  if (!addressesToReveal.length) return { ok: false, error: 'Select at least one address' };
  if (!airdropAddress) return { ok: false, error: 'Select an airdrop address' };

  communitiesState.isBusy = true;
  communitiesState.error = '';
  try {
    const toSign = await generateJoiningRequestsForSigning(
      statusState.publicKey || '',
      entry.id,
      addressesToReveal
    );

    // Watch-only and chat accounts cannot sign, so the answer may be shorter than the request. The
    // order of signatures in the request must match the order of addresses, so filter here.
    const signable = toSign.filter((p) => !!p.data);
    if (!signable.length) {
      throw new Error('No address can be revealed: watch-only accounts cannot sign');
    }

    const signatures = await signJoinRequestData(signable, password);
    if (signatures.length !== signable.length) {
      throw new Error('Signature count does not match address count');
    }

    const revealed = signable.map((p) => p.account);
    const airdrop = revealed.includes(airdropAddress) ? airdropAddress : revealed[0];

    await requestToJoinCommunity(entry.id, revealed, signatures, airdrop);
    info(`[communities] join requested ${entry.id} addresses=${revealed.length}`);

    return { ok: true, pending: true };
  } catch (e) {
    const error = formatError(e);
    communitiesState.error = error;
    return { ok: false, error };
  } finally {
    communitiesState.isBusy = false;
  }
}

/** Clears the communities state; `leaveCommunity` already dropped both membership flags. */
export function resetCommunities() {
  communitiesState.entries = [];
  communitiesState.query = '';
  communitiesState.loaded = false;
  communitiesState.isLoading = false;
  communitiesState.selected = null;
  communitiesState.isBusy = false;
  communitiesState.error = '';
  communitiesState.eligibility = null;
  communitiesState.walletAddresses = [];
}
