/**
 * Правила записи в канал АКК (docs/ru/akk_scheme.md §7, channelKind.ts).
 *
 * Записи (сообщения без `responseTo`) и комментарии (ответы с `responseTo`) —
 * разные права. status-go видит только `canPost` и не различает их, поэтому
 * правило «записи — только автор» проверяется в интерфейсе.
 */

import { KIND_RECORDS_BY_AUTHOR_ONLY, type ChannelKind } from './channelKind';

/** `CommunityMember_ROLE_OWNER`: автор канала. */
export const ROLE_OWNER = 1;

/**
 * Может ли пользователь написать запись в канал такого типа.
 *
 * - тип требует «только автор» (news, request) — запись только у владельца;
 * - тип без такого ограничения (issues) — запись у всех, кому разрешено писать;
 * - `kind` не передан (1-1 чат) — правило канала не применяется, решает `canPost`.
 */
export function canRecord(kind: ChannelKind | undefined, memberRole: number | undefined): boolean {
  if (!kind) return true;
  if (KIND_RECORDS_BY_AUTHOR_ONLY[kind]) return memberRole === ROLE_OWNER;
  return true;
}

/**
 * Может ли пользователь комментировать.
 *
 * Комментарий доступен всем, кому status-go разрешает писать в канал
 * (`canPost`). Отдельного права на комментарий нет.
 */
export function canComment(canPost: boolean | undefined): boolean {
  return canPost !== false;
}
