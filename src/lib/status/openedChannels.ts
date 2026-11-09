/**
 * Каналы чужих сообществ, которые пользователь открыл по ссылке.
 *
 * Зачем: спектация чужого сообщества создаёт `Chat` для всех его каналов с
 * `Active: true`, и без этой отметки в списке оказались бы все каналы
 * сообщества. Status-go различать «открыл» и «просто спектирован» не умеет,
 * поэтому признак храним локально.
 *
 * Свои каналы (владелец) этим признаком не пользуются: они видны всегда.
 *
 * Ограничение: localStorage привязан к webview, а не к профилю. Перейдёт в
 * настройки профиля вместе с остальным хранилищем после миграции на Logos.
 */

const KEY = 'stauri:opened-channels';

/** Читает отметки. Ошибка чтения даёт пустой набор, а не падение списка. */
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

/** Отмечает канал открытым. Повторный вызов безопасен. */
export function markChannelOpened(chatId: string): void {
  try {
    if (typeof localStorage === 'undefined') return;
    const set = loadOpenedChannels();
    if (set.has(chatId)) return;
    set.add(chatId);
    localStorage.setItem(KEY, JSON.stringify([...set]));
  } catch {
    // Запись не удалась: канал останется видимым в этой сессии, это не ошибка.
  }
}
