/**
 * Метки шагов сценария для логов.
 *
 * Каждая строка начинается с `[scenario <сценарий>/<шаг>]`, поэтому по файлу
 * логов можно быстро найти нужный шаг, например:
 *
 *   grep "\[scenario" stauri.<дата>.log
 *
 * Формат фиксирован, чтобы отчёт по шаблону можно было сверять автоматически:
 * `step` — короткий идентификатор шага, `data` — небольшой объект без секретов
 * (ключи и пароли сюда не передаём; ключи сокращаем до 10 символов).
 */

import { info, warn } from './log';

export type ScenarioName = 'create-auto' | 'create-request' | 'join' | 'comment' | 'reply-sync';

export function scenarioLog(
  scenario: ScenarioName,
  step: string,
  data: Record<string, unknown> = {},
  level: 'info' | 'warn' = 'info'
): void {
  const line = `[scenario ${scenario}/${step}] ${JSON.stringify(data)}`;
  if (level === 'warn') warn(line);
  else info(line);
}

/** Сокращает публичный ключ или id, чтобы в логе не было полного значения. */
export function short(value: string | undefined | null, n = 10): string {
  if (!value) return '';
  return value.length > n ? `${value.slice(0, n)}…` : value;
}
