/**
 * Тип канала АКК.
 *
 * Тип хранится **префиксом в описании канала**, например `[issues] Баги`.
 * Описание видят все участники и оно синхронизируется через status-go, поэтому
 * тип одинаков у всех. В status-go своего поля типа канала нет, а теги
 * сообщества принимают только фиксированный список, поэтому префикс — единственный
 * вариант без форка.
 *
 * Это соглашение Stauri, а не протокол. При переходе на Logos его нужно
 * заменить на поле канала: вся работа с типом сосредоточена в этом файле.
 */

export type ChannelKind = 'news' | 'request' | 'issues';

/** Какие типы вступают по заявке. `news` — открытый, остальные — по заявке. */
export const KIND_JOINS_BY_REQUEST: Record<ChannelKind, boolean> = {
  news: false,
  request: true,
  issues: true,
};

/** Кто пишет записи: только автор, или все вступившие. */
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

/** Добавляет тип в описание канала. */
export function withKindPrefix(kind: ChannelKind, description: string): string {
  return `${PREFIX[kind]} ${description}`.trim();
}

/**
 * Достаёт тип и чистое описание из описания канала.
 *
 * Канал без префикса (созданный не через Stauri) считаем `request`: это
 * безопаснее, чем открытый. Сами права на бэкенде при этом не меняются.
 */
export function parseKind(description: string | undefined): { kind: ChannelKind; description: string } {
  const m = (description || '').match(PREFIX_RE);
  if (!m) return { kind: 'request', description: description || '' };
  return { kind: m[1] as ChannelKind, description: (description || '').slice(m[0].length) };
}
