/**
 * Scenario step markers for the logs.
 *
 * Every line starts with `[scenario <scenario>/<step>]`, so a step can be found
 * quickly in a log file:
 *
 *   grep "\[scenario" stauri.<date>.log
 *
 * The format is fixed so a report built from it can be checked automatically.
 */

import { info, warn } from './log';

export type ScenarioName = 'create-auto' | 'create-request' | 'join' | 'comment' | 'reply-sync';

/**
 * Writes one scenario step to the log, and on Android to the bridge trace.
 *
 * @param scenario - Which scenario is running.
 * @param step - Short identifier of the step.
 * @param data - Small payload of non-secret values; keys and passwords do not
 * belong here, and keys are shortened to 10 characters.
 * @param level - `info` to record progress, `warn` for a deviation.
 * @remarks Android has no frontend log on the phone, so the same line is also
 * sent to the bridge trace (`bridge-trace.log`), where `tests/scenarios` check
 * it.
 */
export function scenarioLog(
  scenario: ScenarioName,
  step: string,
  data: Record<string, unknown> = {},
  level: 'info' | 'warn' = 'info'
): void {
  const line = `[scenario ${scenario}/${step}] ${JSON.stringify(data)}`;
  if (level === 'warn') warn(line);
  else info(line);
  // Android: no frontend log on the phone, so the same line goes to the bridge
  // trace (bridge-trace.log), which tests/scenarios are checked against.
  if (isAndroidWebview()) sendToBridgeTrace(line);
}

/**
 * Chain of pending bridge-trace writes.
 *
 * Steps go out over a single promise chain because call order is not
 * guaranteed: without a queue, the "start" and "end" lines of a step could
 * swap places.
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

/**
 * Shortens a public key or id so the log does not hold the full value.
 *
 * @param value - The key or id.
 * @param n - Maximum characters kept, 10 by default.
 * @returns The shortened value with an ellipsis, or an empty string for a
 * missing one.
 */
export function short(value: string | undefined | null, n = 10): string {
  if (!value) return '';
  return value.length > n ? `${value.slice(0, n)}…` : value;
}
