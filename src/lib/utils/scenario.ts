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
  // Android: логов фронтенда на телефоне нет, поэтому та же строка уходит в
  // трассу моста (bridge-trace.log). По ней сверяют сценарии (tests/scenarios).
  if (isAndroidWebview()) sendToBridgeTrace(line);
}

/**
 * Метки уходят в трассу по одной цепочке: порядок вызовов не гарантирован,
 * и без очереди «начало» и «конец» шага могли поменяться местами.
 */
let traceChain: Promise<unknown> = Promise.resolve();
function sendToBridgeTrace(line: string): void {
  traceChain = traceChain
    .then(() => import('@tauri-apps/api/core'))
    .then(({ invoke }) => invoke('status_call', { endpoint: 'TraceNote', body: JSON.stringify({ line }) }))
    .catch(() => {});
}

function isAndroidWebview(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
}

/** Сокращает публичный ключ или id, чтобы в логе не было полного значения. */
export function short(value: string | undefined | null, n = 10): string {
  if (!value) return '';
  return value.length > n ? `${value.slice(0, n)}…` : value;
}
