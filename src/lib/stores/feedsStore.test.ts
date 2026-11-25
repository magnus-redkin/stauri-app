import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeFeedUrl,
  rewriteRsshub,
  RSSHUB_MIRROR,
  feedsState,
  loadFeeds,
} from './feedsStore.svelte';

// The store touches `localStorage` only in `loadFeeds`/`persist`; the pure functions below do not
// depend on it. The module imports `invoke`, though, and its absence under happy-dom does not
// matter as long as no command is called.
const invokeMock = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invokeMock(...args) }));

describe('rewriteRsshub', () => {
  it('меняет хост rsshub.app на зеркало и сохраняет путь', () => {
    expect(rewriteRsshub('https://rsshub.app/telegram/channel/eveningprophet')).toBe(
      `https://${RSSHUB_MIRROR}/telegram/channel/eveningprophet`
    );
  });

  it('сохраняет query и хвост пути', () => {
    expect(rewriteRsshub('https://rsshub.app/twitter/user/elonmusk?limit=20')).toBe(
      `https://${RSSHUB_MIRROR}/twitter/user/elonmusk?limit=20`
    );
  });

  it('переписывает и www-вариант', () => {
    expect(rewriteRsshub('https://www.rsshub.app/discord/channel/950')).toBe(
      `https://${RSSHUB_MIRROR}/discord/channel/950`
    );
  });

  it('не трогает чужие хосты', () => {
    const other = 'https://news.ycombinator.com/rss';
    expect(rewriteRsshub(other)).toBe(other);
  });

  it('не трогает хост, который лишь заканчивается на rsshub.app', () => {
    // `evil-rsshub.app` must not count as RSSHub: the comparison is by exact host name, not by
    // suffix.
    const lookalike = 'https://evil-rsshub.app/telegram/channel/x';
    expect(rewriteRsshub(lookalike)).toBe(lookalike);
  });

  it('возвращает исходную строку, если это не URL', () => {
    expect(rewriteRsshub('rsshub.app/telegram')).toBe('rsshub.app/telegram');
  });
});

describe('normalizeFeedUrl', () => {
  it('переписывает rsshub.app на зеркало', () => {
    expect(normalizeFeedUrl('https://rsshub.app/telegram/channel/eveningprophet')).toBe(
      `https://${RSSHUB_MIRROR}/telegram/channel/eveningprophet`
    );
  });

  it('оставляет обычный RSS-адрес как есть', () => {
    const url = 'https://news.ycombinator.com/rss';
    expect(normalizeFeedUrl(url)).toBe(url);
  });

  it('превращает @name в маршрут RSSHub на зеркале', () => {
    // Not `t.me/s/name`: the ready HTML page is fragile to parse, while the RSSHub route returns
    // real RSS for any channel.
    expect(normalizeFeedUrl('@status')).toBe(
      `https://${RSSHUB_MIRROR}/telegram/channel/status`
    );
  });

  it('превращает t.me/s/name в маршрут RSSHub', () => {
    expect(normalizeFeedUrl('t.me/s/status')).toBe(
      `https://${RSSHUB_MIRROR}/telegram/channel/status`
    );
  });

  it('превращает полную ссылку t.me/name в маршрут RSSHub', () => {
    // Users copy the whole channel address from a browser, which is the most common case; such
    // input must reach RSSHub rather than `t.me/s/`, where it would be parsed as HTML.
    expect(normalizeFeedUrl('https://t.me/eveningprophet')).toBe(
      `https://${RSSHUB_MIRROR}/telegram/channel/eveningprophet`
    );
    expect(normalizeFeedUrl('https://t.me/s/eveningprophet')).toBe(
      `https://${RSSHUB_MIRROR}/telegram/channel/eveningprophet`
    );
  });

  it('не путает t.me с чужим хостом', () => {
    // `t.me.evil.com` must not count as Telegram.
    const other = 'https://t.me.evil.com/feed';
    expect(normalizeFeedUrl(other)).toBe(other);
  });

  it('отклоняет пустой ввод и мусор', () => {
    expect(normalizeFeedUrl('')).toBeNull();
    expect(normalizeFeedUrl('   ')).toBeNull();
    expect(normalizeFeedUrl('stauri')).toBeNull();
  });
});

/**
 * Storage reads.
 *
 * The main thing checked here is migration: version 1 records hold a snippet with "…" inside the
 * string, so they must be refetched. Without that the user would see the old truncated text after
 * an upgrade and conclude that expanding on click is broken.
 */
describe('loadFeeds', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    localStorage.clear();
    feedsState.subscriptions.clear();
    // The flag is set after the module's first call, so reset it by hand: otherwise every later
    // test would get an empty store.
    feedsState.loaded = false;
  });

  it('читает старый формат (голый массив) и перечитывает подписки', async () => {
    localStorage.setItem(
      'stauri:feeds',
      JSON.stringify([
        {
          url: 'https://example.com/feed',
          title: 'Old',
          source: 'example.com',
          items: [{ url: 'u', title: 't', summary: 'обрезано…', published_at: null }],
          fetchedAt: 1,
          error: '',
        },
      ])
    );
    invokeMock.mockResolvedValue({
      title: 'Fresh',
      source: 'example.com',
      items: [{ url: 'u2', title: 't2', summary: 'полный текст', published_at: null }],
    });

    loadFeeds();

    // Right after the read comes the stored state; that is what is visible before the refresh.
    expect(feedsState.subscriptions.get('https://example.com/feed')?.title).toBe('Old');

    // The refresh runs in the background: wait for the whole chain to finish, or its `invoke` call
    // lands in the next test and that test "sees" an extra call.
    await new Promise((r) => setTimeout(r, 0));

    expect(invokeMock).toHaveBeenCalledWith('fetch_feed', {
      url: 'https://example.com/feed',
    });
    expect(feedsState.subscriptions.get('https://example.com/feed')?.title).toBe('Fresh');
  });

  it('читает новый формат (с версией) и не перечитывает подписки', async () => {
    localStorage.setItem(
      'stauri:feeds',
      JSON.stringify({
        version: 3,
        feeds: [
          {
            url: 'https://example.com/feed',
            title: 'Fresh',
            source: 'example.com',
            items: [{ url: 'u', title: 't', summary: 'полный текст', published_at: null }],
            fetchedAt: 2,
            error: '',
          },
        ],
      })
    );

    loadFeeds();
    await new Promise((r) => setTimeout(r, 0));

    expect(feedsState.subscriptions.get('https://example.com/feed')?.title).toBe('Fresh');
    // `invoke` is also used by logging (`log_frontend`), so check the feed-loading calls
    // specifically rather than any call at all.
    expect(invokeMock.mock.calls.filter((c) => c[0] === 'fetch_feed')).toHaveLength(0);
  });

  it('пропускает записи неправильной формы, а не падает', () => {
    localStorage.setItem(
      'stauri:feeds',
      JSON.stringify({
        version: 2,
        feeds: [{ url: 42 }, { title: 'без url' }, null],
      })
    );

    expect(() => loadFeeds()).not.toThrow();
    expect(feedsState.subscriptions.size).toBe(0);
  });
});
