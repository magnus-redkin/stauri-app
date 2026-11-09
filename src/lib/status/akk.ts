/**
 * Схема АКК «Автор — Канал — Комментарии» поверх status-go.
 *
 * ## Что видит пользователь и что делает код
 *
 * Пользователь создаёт канал и пишет в него записи. Комментарии — ответы на
 * записи. Слова «сообщество» в интерфейсе нет.
 *
 * Технически status-go держит канал только внутри сообщества. Поэтому на
 * каждый канал заводится **отдельное** сообщество, в котором ровно один канал.
 * Связь «канал → сообщество» не хранится нигде: она выводится из
 * `Community.chats` (см. `communityChannels` в `messaging.ts`).
 *
 * ## Ограничения status-go, которые надо знать
 *
 * - `createCommunity` сам заводит канал с фиксированным именем `general`.
 *   Поэтому имя, которое ввёл автор, становится **именем сообщества**, а
 *   интерфейс показывает его как имя канала.
 * - Имя сообщества: не пусто, до 30 символов. Описание: не пусто, до 140.
 *   Проверяем на нашей стороне, чтобы не получать внутреннюю ошибку.
 *
 * ## Почему `responseTo`, а не threads
 *
 * См. docs/ru/akk_scheme.md §2–§4: threads в сборке выключены, а `responseTo`
 * работает без флагов.
 */

import { statusFetch } from './http';
import { KIND_JOINS_BY_REQUEST, withKindPrefix, type ChannelKind } from './channelKind';
import { CommunityAccessValue, normalizeHex, sendChatMessage } from './messaging';

export const CHANNEL_NAME_MAX = 30;
export const CHANNEL_DESCRIPTION_MAX = 140;

export interface CreateChannelParams {
  /** Имя канала (оно же имя технического сообщества). */
  name: string;
  /** Короткое описание канала. */
  description: string;
  /**
   * Тип канала (правила из docs/ru/akk_scheme.md §7):
   *
   * - `news`    — открытый: вступить может любой; записи пишет только автор,
   *        комментируют все вступившие;
   * - `request` — по заявке: вступление по заявке; записи пишет только автор,
   * комментируют вступившие.
   *
   * Записи и комментарии — одна и та же сущность для status-go (см. §4), поэтому
   * «только автор пишет записи» проверяет клиент, а сервер — нет.
   */
  kind: ChannelKind;
}

export interface CreatedChannel {
  /** id сообщества, которое содержит канал (0x-hex). */
  communityId: string;
  /** Полный id канала для `sendChatMessage` (communityId + channelId). */
  chatId: string;
}

/**
 * Проверяет имя и описание до отправки в status-go.
 *
 * Возвращает текст ошибки для пользователя или `null`, если всё в порядке.
 */
export function validateChannelInput(name: string, description: string): string | null {
  const n = name.trim();
  const d = description.trim();
  if (!n) return 'Enter a channel name';
  // Ссылку на канал вставили в поле имени: вместо «слишком длинное имя»
  // объясняем, куда её вставлять.
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
 * Длина строки в байтах UTF-8 — так status-go считает `len(c.Name)`.
 *
 * Кириллица занимает 2 байта на символ, эмодзи — 4. Счётчик символов JS
 * (`.length`) даёт меньше, и такое имя проходило бы проверку здесь, а потом
 * падало в status-go с `create-community: invalid name`.
 */
export function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Создаёт канал: техническое сообщество с одним каналом.
 *
 * @throws если status-go вернул ошибку или не отдал ни сообщество, ни канал.
 */
export async function createChannel(
  port: number,
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
  }>(port, 'CallRPC', {
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
// ЗАЯВКИ НА ВСТУПЛЕНИЕ (для автора)
// ===========================================================================

export interface PendingJoinRequest {
  /** id заявки: его передаём в accept/decline. */
  id: string;
  /** Публичный ключ того, кто просит доступ. */
  publicKey: string;
  communityId: string;
  clock: number;
}

/**
 * Заявки, которые ждут решения автора канала.
 *
 * Возвращает пустой список при ошибке: отсутствие заявок и сбой запроса
 * для пользователя выглядят одинаково (пустой список), и это приемлемо —
 * сбой будет виден при следующем обновлении.
 */
export async function pendingJoinRequests(
  port: number,
  communityId: string
): Promise<PendingJoinRequest[]> {
  const res = await statusFetch<{
    result?: Array<{ id: string; publicKey: string; communityId: string; clock: number }>;
    error?: { message?: string };
  }>(port, 'CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_pendingRequestsToJoinForCommunity',
    params: [normalizeHex(communityId)],
  });
  if (res.error) return [];
  return res.result || [];
}

/** Принять заявку: участник получает доступ к каналу. */
export async function acceptJoinRequest(port: number, requestId: string): Promise<void> {
  await statusFetch(port, 'CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_acceptRequestToJoinCommunity',
    params: [{ id: normalizeHex(requestId) }],
  });
}

/** Отклонить заявку. */
export async function declineJoinRequest(port: number, requestId: string): Promise<void> {
  await statusFetch(port, 'CallRPC', {
    jsonrpc: '2.0',
    id: 1,
    method: 'wakuext_declineRequestToJoinCommunity',
    params: [{ id: normalizeHex(requestId) }],
  });
}

// ===========================================================================
// КОММЕНТАРИИ
// ===========================================================================

/**
 * Отправляет комментарий к записи канала.
 *
 * Комментарий — обычное сообщение с `responseTo`. Бэкенд принимает `responseTo`
 * только для сообщения, которое у него уже есть в базе, поэтому запись должна
 * быть загружена до ответа на неё.
 */
export function sendComment(
  port: number,
  channelChatId: string,
  communityId: string,
  parentMessageId: string,
  text: string
): Promise<unknown> {
  return sendChatMessage(port, channelChatId, text, communityId, parentMessageId);
}
