/**
 * Channel kind for the AKK scheme.
 *
 * The kind is stored as a prefix in the channel description, for example
 * `[issues] Bugs`. Every member sees the description and status-go syncs it, so
 * the kind is the same for all of them. status-go has no channel kind field, and
 * community tags accept only a fixed list, so the prefix is the only option that
 * needs no fork.
 *
 * @remarks
 * This is a Stauri convention, not a protocol one. Moving to Logos means
 * replacing it with a real channel field; all kind handling is confined to this
 * file for that reason.
 */

export type ChannelKind = 'news' | 'request' | 'issues';

/** Which kinds require an approved join request. `news` is open. */
export const KIND_JOINS_BY_REQUEST: Record<ChannelKind, boolean> = {
  news: false,
  request: true,
  issues: true,
};

/** Who may post entries: the author only, or every joined member. */
export const KIND_RECORDS_BY_AUTHOR_ONLY: Record<ChannelKind, boolean> = {
  news: true,
  request: true,
  issues: false,
};

const PREFIX: Record<ChannelKind, string> = {
  news: '[news]',
  request: '[request]',
  issues: '[issues]',
};

const PREFIX_RE = /^\[(news|request|issues)\]\s*/;

/**
 * Encodes the channel kind into its description.
 *
 * @param kind - Kind to encode.
 * @param description - Description as entered by the author.
 * @returns Description prefixed with the kind tag.
 */
export function withKindPrefix(kind: ChannelKind, description: string): string {
  return `${PREFIX[kind]} ${description}`.trim();
}

/**
 * Splits a channel description into its kind and the plain description.
 *
 * @param description - Raw channel description from status-go.
 * @returns The parsed kind and the description with the prefix removed.
 * @remarks
 * A description without a prefix, typically a channel created outside Stauri,
 * is treated as `request`: that is safer than assuming it is open. Backend
 * permissions are unaffected either way, since the kind is client-side only.
 */
export function parseKind(description: string | undefined): { kind: ChannelKind; description: string } {
  const m = (description || '').match(PREFIX_RE);
  if (!m) return { kind: 'request', description: description || '' };
  return { kind: m[1] as ChannelKind, description: (description || '').slice(m[0].length) };
}
