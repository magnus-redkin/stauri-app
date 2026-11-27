/**
 * External sources (feeds) the user added.
 *
 * Separate from `dappsState.feeds`, which is "what I am viewing in the dApp section": this store
 * is "what I am subscribed to". A subscription survives restarts and shows up in the chat list,
 * unlike a feed opened in the panel.
 *
 * @remarks
 * The backend has no table for external sources: status-go stores only Status chats, and a foreign
 * RSS row there would misrepresent the data model. Application settings (theme, language) already
 * live in `localStorage`, and this is the same class of state. The limit is known: `localStorage`
 * is bound to the webview, so subscriptions do not survive a profile switch. They will move to the
 * app's own settings storage once it exists.
 *
 * Invariants from docs/ru/providers_and_dapps.md: an item always shows its origin (§9.2), one
 * broken source does not break the others (§13), and we set the order rather than the source
 * (§9.3).
 */

import { SvelteMap } from 'svelte/reactivity';
import { invoke } from '@tauri-apps/api/core';
import { debug, info, warn } from '$lib/utils/log';
import { formatError } from '$lib/utils/errors';

/** A feed item, shaped like what `fetch_feed` returns in Rust. */
export interface FeedItem {
  url: string;
  title: string;
  summary: string;
  /** The same excerpt with its formatting, as a safe tag subset from Rust. */
  html?: string;
  /** Publication time in milliseconds, when it could be parsed. */
  published_at: number | null;
}

/** Response of `fetch_feed`. */
export interface FeedResponse {
  title: string;
  items: FeedItem[];
  /** Whose item this is: `t.me/<name>` or the host. Always shown. */
  source: string;
}

/** A subscription: address and the last successfully fetched content. */
export interface FeedSubscription {
  /** Address the feed is fetched from. Key and chat id. */
  url: string;
  /** Channel title from the feed itself, else the host. */
  title: string;
  /** Origin: `t.me/<name>` or the host. Shown in the list. */
  source: string;
  items: FeedItem[];
  /** When it was last refreshed (ms). */
  fetchedAt: number;
  /** Error from the last refresh; empty means all is well. */
  error: string;
  /**
   * Item URLs the user has already seen.
   *
   * @remarks
   * The badge in the chat list is `items.length - seen.length`, so what counts as "new"
   * is decided when the feed is opened, not when it was fetched. A refresh that brings
   * five items shows "5"; opening the feed clears it.
   */
  seen?: string[];
}

const STORAGE_KEY = 'stauri:feeds';

/**
 * Version of the stored subscription format.
 *
 * @remarks
 * The disk may hold snippets truncated by the old parser, which appended "…" inside the string;
 * such a snippet cannot expand on click because the rest of the text is gone. Fixing the parser
 * does not repair stored records, so subscriptions read from an older version are refetched.
 * Version 2 stores snippets up to 4000 characters and lets layout do the shortening. Bump the
 * version on any `FeedItem` shape change that cannot be fixed on the fly.
 */
const STORAGE_VERSION = 3;

/** What goes to disk: the version and the subscriptions themselves. */
interface StoredFeeds {
  version: number;
  feeds: FeedSubscription[];
}

/** How many items are kept per source. Matches the limit in Rust. */
const MAX_STORED_ITEMS = 50;

/**
 * RSSHub host that `rsshub.app` addresses are rewritten to.
 *
 * @remarks
 * Public `rsshub.app` blocks programmatic access: a plain request gets `403` ("restrict access …
 * for some feed readers … intended for testing purposes only"), and a browser User-Agent gets a
 * Cloudflare "Just a moment…" page. The links in the instructions (`rsshub.app/telegram/channel/…`,
 * `/discord/channel/…`, `/twitter/user/…`) are correct, only the host changes. The mirror is
 * hardcoded on purpose: it may die the way the original domain did, and then the constant changes
 * here, in one place.
 *
 * Not every route works on the mirror: `telegram/channel/<name>` serves a feed, while
 * `twitter/user/<name>` and `discord/channel/<id>` answer `503` because they need that network's
 * keys, which the mirror does not supply. Those failures are surfaced to the user, not worked
 * around.
 */
export const RSSHUB_MIRROR = 'rsshub.rssforever.com';

/** RSSHub hosts that are rewritten to the mirror. */
const RSSHUB_HOSTS = ['rsshub.app', 'www.rsshub.app'];

/**
 * Working feeds offered as hints below the panel, to give the empty field a starting point.
 *
 * @remarks
 * All were checked with a request and answer `200` with valid RSS/Atom. The types differ
 * deliberately (a blog, a journal, news, a link aggregator) to show the format fits more than one
 * kind of site. `blog.ethereum.org/feed.xml` redirects `301` to `/en/feed.xml`; the HTTP client
 * follows it, so the habitual address is kept.
 */
export const FEED_EXAMPLES = [
  'https://blog.rust-lang.org/feed.xml',
  'https://www.nature.com/nature.rss',
  'https://blog.ethereum.org/feed.xml',
  'https://news.ycombinator.com/rss',
  'https://lwn.net/headlines/rss',
  'https://github.blog/feed/',
  'https://www.theverge.com/rss/index.xml',
  'https://changelog.com/feed',
] as const;

/**
 * Telegram channels offered in the dApp panel as a separate block.
 *
 * @remarks
 * They are ordinary `t.me` links: `normalizeFeedUrl` turns each into an RSSHub mirror route
 * (`telegram/channel/<name>`), because the ready `t.me/s/<name>` page is fragile to parse.
 * Kept apart from {@link FEED_EXAMPLES} so the panel does not mix two different kinds of
 * source under one heading.
 */
export const TG_CHANNELS = [
  'https://t.me/eveningprophet',
  'https://t.me/dovlatov_sergei',
] as const;

export const feedsState = $state({
  /**
   * Subscriptions by URL.
   *
   * `SvelteMap` rather than a plain object: the chat list template reads this map, and a plain
   * object would not be tracked reactively.
   */
  subscriptions: new SvelteMap<string, FeedSubscription>(),
  /** A new address is being checked and fetched. */
  isAdding: false,
  /** Error from the last add, for the form. */
  error: '',
  loaded: false,
});

/**
 * Reads subscriptions from disk.
 *
 * @remarks
 * A read error is not propagated: a corrupt store must not stop the app from starting. The store
 * is cleared and starts empty, because a silently broken section is worse than losing
 * subscriptions. Subscriptions from an older format version are refetched right after reading:
 * version 1 truncated snippets at 400 characters with "…" inside the string, which made them
 * unexpandable, and fixing the parser does not repair stored records.
 */
export function loadFeeds(): void {
  if (feedsState.loaded) return;
  feedsState.loaded = true;

  if (typeof localStorage === 'undefined') return;

  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    // Format 1 is a bare array, format 2 an object with a version. Both are understood: existing
    // users have the array on disk, and their subscriptions must survive the upgrade.
    const parsed = JSON.parse(raw) as StoredFeeds | FeedSubscription[];
    const version = Array.isArray(parsed) ? 1 : parsed?.version ?? 1;
    const feeds = Array.isArray(parsed) ? parsed : parsed?.feeds ?? [];

    for (const feed of feeds) {
      // Validate the shape: the file on disk may have been edited by hand, and the list template
      // reads `items` and `title` without checks.
      if (!feed || typeof feed.url !== 'string' || !Array.isArray(feed.items)) continue;
      feedsState.subscriptions.set(feed.url, {
        url: feed.url,
        title: feed.title || feed.url,
        source: feed.source || '',
        items: feed.items,
        fetchedAt: feed.fetchedAt || 0,
        error: feed.error || '',
        seen: Array.isArray(feed.seen) ? feed.seen : [],
      });
    }

    info(`[feeds] loaded ${feedsState.subscriptions.size} subscription(s), v${version}`);

    if (version < STORAGE_VERSION) {
      info('[feeds] storage is outdated, refetching subscriptions');
      // Do not await: the chat list must appear at once with the stored titles. The refresh
      // replaces the snippets underneath it.
      void refreshFeeds();
    }
  } catch (e) {
    warn('[feeds] failed to read subscriptions, starting empty:', e);
  }
}

function persist(): void {
  if (typeof localStorage === 'undefined') return;
  try {
    const payload: StoredFeeds = {
      version: STORAGE_VERSION,
      feeds: [...feedsState.subscriptions.values()],
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (e) {
    // Quota overflow or a write ban: subscriptions keep working until restart but are not saved.
    // Report it to the log rather than staying silent.
    warn('[feeds] failed to persist subscriptions:', e);
  }
}

/**
 * Adds a subscription and starts fetching it in the background.
 *
 * @param raw - Address as typed or pasted; normalised before storing.
 * @returns `ok` as soon as the record exists.
 * @remarks
 * The panel must not sit on a spinner while a public mirror takes its time: the
 * RSSHub mirror intermittently drops the first connection, and waiting for the
 * retry made "connect" a minute-long operation. The subscription is stored at
 * once and the app switches to it; the fetch runs behind it, and a failure lands
 * in the same record as "Update failed: …" — which the chat row already shows —
 * and in `feedsState.error` for the panel.
 *
 * The address is normalised first, because users paste links from catalogs or
 * `@name` handles, and storing the raw input would create a second record for a
 * feed they already have.
 */
export async function addFeed(raw: string): Promise<{ ok: boolean; error?: string }> {
  const url = normalizeFeedUrl(raw);
  if (!url) {
    feedsState.error = 'Enter an RSS/Atom URL';
    return { ok: false, error: feedsState.error };
  }

  const existing = feedsState.subscriptions.get(url);
  if (!existing) {
    feedsState.subscriptions.set(url, {
      url,
      title: hostOf(url),
      source: hostOf(url),
      items: [],
      fetchedAt: 0,
      error: '',
      seen: [],
    });
    persist();
  }
  feedsState.error = '';
  info(`[feeds] added ${url}, fetching in background`);

  // Not awaited: the caller navigates to the chat immediately.
  void refreshFeed(url);
  return { ok: true };
}

/**
 * Fetches one subscription and writes the result back into it.
 *
 * @param url - Subscription address.
 * @returns `true` when the fetch succeeded.
 * @remarks
 * One source failing must not break the others (§13): the error goes into that
 * record only. A failed first fetch keeps the stored title and leaves `items`
 * empty, so the chat row says what went wrong instead of pretending to be empty.
 */
export async function refreshFeed(url: string): Promise<boolean> {
  const current = feedsState.subscriptions.get(url);
  if (!current) return false;
  try {
    const res = await invoke<FeedResponse>('fetch_feed', { url });
    if (!res.items.length) throw new Error('The feed is empty: no items found');
    feedsState.subscriptions.set(url, {
      ...current,
      title: res.title || current.title,
      source: res.source || current.source,
      items: res.items.slice(0, MAX_STORED_ITEMS),
      fetchedAt: Date.now(),
      error: '',
    });
    persist();
    return true;
  } catch (e) {
    const error = formatError(e);
    feedsState.subscriptions.set(url, { ...current, error });
    feedsState.error = error;
    warn(`[feeds] refresh ${url} failed:`, e);
    persist();
    return false;
  }
}

/**
 * Refetches every subscription.
 *
 * @remarks
 * Sequential on purpose: a burst of parallel requests to the same mirror is the
 * fastest way to be rate-limited. Each URL reports its own outcome.
 */
export async function refreshFeeds(): Promise<void> {
  for (const url of [...feedsState.subscriptions.keys()]) {
    await refreshFeed(url);
  }
}

/**
 * Age after which a subscription is refreshed without being asked.
 *
 * @remarks
 * Feeds are not push sources: without a refresh the chat row keeps the items from the
 * moment the subscription was added. Fifteen minutes is short enough that the row is
 * current during a session and long enough not to hammer a public mirror.
 */
export const FEED_REFRESH_MS = 15 * 60 * 1000;

let polling: ReturnType<typeof setInterval> | null = null;
let stalePassRunning = false;

/**
 * Refetches subscriptions not refreshed for `maxAgeMs`.
 *
 * @remarks
 * Sequential, like {@link refreshFeeds}. A pass already running is not started again: the
 * caller may be the timer and the user opening a feed at the same moment.
 */
export async function refreshStaleFeeds(maxAgeMs = FEED_REFRESH_MS): Promise<void> {
  if (stalePassRunning) return;
  stalePassRunning = true;
  try {
    const now = Date.now();
    for (const url of [...feedsState.subscriptions.keys()]) {
      const feed = feedsState.subscriptions.get(url);
      if (!feed) continue;
      if (feed.fetchedAt && now - feed.fetchedAt < maxAgeMs) continue;
      await refreshFeed(url);
    }
  } finally {
    stalePassRunning = false;
  }
}

/**
 * Starts the background refresh: stale subscriptions at once, then once per interval.
 *
 * @remarks
 * Called once when the main interface mounts. The timer lives for the session; a
 * subscription added later is picked up by the next pass.
 */
export function startFeedPolling(): void {
  if (polling !== null) return;
  void refreshStaleFeeds();
  polling = setInterval(() => void refreshStaleFeeds(), FEED_REFRESH_MS);
}

/** Stops the background refresh (tests and a full app reset). */
export function stopFeedPolling(): void {
  if (polling === null) return;
  clearInterval(polling);
  polling = null;
}

/** Removes a subscription. Its messages were never ours, so there is nothing else to delete. */
export function removeFeed(url: string): void {
  if (!feedsState.subscriptions.delete(url)) return;
  persist();
  info(`[feeds] removed ${url}`);
}

/** Chat id for a subscription: `feed:` + the address. */
export function feedChatId(url: string): string {
  return `feed:${url}`;
}

/** Subscription address for a chat id, or `null` when the id is not a subscription. */
export function feedUrlFromChatId(chatId: string): string | null {
  return chatId.startsWith('feed:') ? chatId.slice('feed:'.length) : null;
}

/**
 * A subscription rendered as a chat-list row.
 *
 * @param feed - Subscription to render.
 * @returns A structurally `ChatItem`-compatible object.
 * @remarks
 * The row is built in two places: the chat list and `selectChat`, which opens a chat by id from
 * another section. Keeping the shape only in the component would mean a feed opened from the dApp
 * panel is not found in `chatsState` and nothing gets selected. The `ChatItem` type cannot be
 * imported here, since components depend on stores and not the other way round.
 */
export function feedChatItem(feed: FeedSubscription) {
  return {
    id: feedChatId(feed.url),
    name: feed.title,
    lastMessage: feed.error
      ? `Update failed: ${feed.error}`
      : feed.items[0]?.title || '',
    type: 'external' as const,
    source: feed.source,
    sourceUrl: feed.url,
    unreadCount: feed.items.filter((item) => !(feed.seen ?? []).includes(item.url)).length,
  };
}

/**
 * Marks every item of a subscription as seen, clearing its badge.
 *
 * @param url - Subscription address.
 * @remarks
 * Called when the feed is opened. The seen list is capped so a long-lived subscription
 * cannot grow `localStorage` without bound: items beyond the stored window are no longer
 * reported as new anyway, since they are not kept.
 */
export function markFeedSeen(url: string): void {
  const feed = feedsState.subscriptions.get(url);
  if (!feed) return;
  const seen = feed.items.map((item) => item.url);
  const current = feed.seen ?? [];
  if (seen.length === current.length && seen.every((u) => current.includes(u))) return;
  feedsState.subscriptions.set(url, { ...feed, seen });
  persist();
}

/** All subscriptions as list rows, freshest first. */
export function feedChatItems() {
  return [...feedsState.subscriptions.values()]
    .sort((a, b) => b.fetchedAt - a.fetchedAt)
    .map(feedChatItem);
}

/**
 * Turns user input into a URL.
 *
 * Accepts what users actually paste: a full `http(s)` address as-is (the main path: RSSHub, the
 * user's own RSS, a site feed); a Telegram channel reference (`t.me/name`, `t.me/s/name`, `@name`),
 * which becomes an RSSHub mirror route rather than `t.me/s/…`, because the ready HTML page is
 * fragile to parse and may only be served to browsers, while the RSSHub route returns real RSS for
 * any channel; anything else is an input error rather than a silent attempt.
 *
 * @param raw - Raw user input.
 * @returns A URL, or `null` when the input cannot be turned into one.
 * @remarks
 * An `rsshub.app` address is rewritten to the mirror (see [`RSSHUB_MIRROR`]): the public domain no
 * longer serves feeds to programs, while the routes in the instructions name it, so rejecting such
 * input would be wrong.
 */
export function normalizeFeedUrl(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  if (/^https?:\/\//i.test(value)) {
    // A full Telegram channel link, `https://t.me/name` or `https://t.me/s/name`. Route it to the
    // mirror.
    const tgUrl = value.match(
      /^https?:\/\/(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]+)\/?$/i
    );
    if (tgUrl) return telegramFeedUrl(tgUrl[1]);
    return rewriteRsshub(value);
  }

  const tg = value.match(
    /^(?:www\.)?(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]+)\/?$/i
  );
  if (tg) return telegramFeedUrl(tg[1]);

  const handle = value.match(/^@([A-Za-z0-9_]{4,})$/);
  if (handle) return telegramFeedUrl(handle[1]);

  return null;
}

/** RSSHub route for a public Telegram channel, already on the mirror. */
export function telegramFeedUrl(channel: string): string {
  return `https://${RSSHUB_MIRROR}/telegram/channel/${channel}`;
}

/**
 * Replaces the `rsshub.app` host with the mirror, keeping path and query.
 *
 * @param url - Address to rewrite.
 * @returns The rewritten address, or the input when the host differs or parsing fails.
 * @remarks
 * Failing to normalise must not read as "wrong address": a non-RSSHub address is still valid, it
 * just is not RSSHub.
 */
export function rewriteRsshub(url: string): string {
  try {
    const parsed = new URL(url);
    if (!RSSHUB_HOSTS.includes(parsed.hostname.toLowerCase())) return url;
    parsed.hostname = RSSHUB_MIRROR;
    // The scheme stays as it was: the mirror serves https, but an http input is not silently
    // turned into a different address apart from the host.
    return parsed.toString();
  } catch {
    return url;
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function resetFeeds(): void {
  // Subscriptions are NOT cleared: they belong to the user and survive signing out. Only the form
  // state is reset.
  feedsState.isAdding = false;
  feedsState.error = '';
}
