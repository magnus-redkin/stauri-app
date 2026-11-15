/**
 * Channels of other people's communities that the user opened by link.
 *
 * Spectating a community creates a `Chat` for every one of its channels with
 * `Active: true`, so without this marker the list would show all of them.
 * status-go cannot tell "opened" from "merely spectated", so the distinction is
 * kept locally.
 *
 * @remarks
 * Channels the user owns do not use this marker; they are always visible.
 * localStorage is scoped to the webview rather than to a profile, so the marker
 * does not follow the account.
 */

const KEY = 'stauri:opened-channels';

/**
 * Reads the set of opened channel ids.
 *
 * @returns The stored ids, or an empty set when reading fails.
 * @remarks
 * A read error yields an empty set instead of failing the whole channel list.
 */
export function loadOpenedChannels(): Set<string> {
  try {
    if (typeof localStorage === 'undefined') return new Set();
    const raw = localStorage.getItem(KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}

/**
 * Marks a channel as opened.
 *
 * @param chatId - Full chat id of the channel.
 * @remarks
 * Calling it repeatedly is safe. When writing fails the channel stays visible
 * for this session, which is not treated as an error.
 */
export function markChannelOpened(chatId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const set = loadOpenedChannels();
    if (set.has(chatId)) return;
    set.add(chatId);
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    // The write failed: the channel stays visible for this session.
  }
}
