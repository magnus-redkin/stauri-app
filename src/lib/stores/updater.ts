/**
 * Update check and install.
 *
 * The check runs through app commands rather than the JS
 * `@tauri-apps/plugin-updater` API: the latter executes in the webview and needs
 * the `updater:default` permission, which grants page-level access. Only the
 * two thin commands are exposed here; the endpoint and the install order stay in
 * Rust. The webview is the most exposed part of the app, so the fewer
 * privileges it holds, the smaller the consequences of an XSS.
 *
 * @remarks
 * The endpoint is `releases/latest/download/latest.json` on GitHub. GitHub does
 * not serve `releases/latest` for prereleases, so a prerelease build is never
 * offered as an update; only a full release is picked up.
 *
 * Installing is a separate user action by design. Signing prevents a swapped
 * binary but not a swapped moment: an explicit click leaves the decision with
 * the user, while a silent auto-update would undermine trust in an app that
 * holds keys.
 */

import { invoke } from '@tauri-apps/api/core';
import { debug } from '$lib/utils/log';

export interface UpdateInfo {
  /** Version offered by the server. */
  version: string;
  /** Currently running app version. */
  currentVersion: string;
  /** Release notes (Markdown), when the server provided them. */
  notes: string | null;
  /** Publication date, ISO 8601. */
  date: string | null;
}

export interface UpdateCheckResult {
  /** `null` when no update is available. */
  update: UpdateInfo | null;
  /**
   * Why the check produced no answer. Kept apart from `update: null`: "server
   * unreachable" and "already up to date" mean different things to the user,
   * and only the first deserves a mention in the UI.
   */
  error: string | null;
}

/**
 * Asks the server whether a newer version exists.
 *
 * Never throws: updates are not critical, and a failed check must not affect
 * application startup.
 *
 * @returns The available update, or `null` with an `error` explaining why the
 * check gave no answer.
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  try {
    const update = await invoke<UpdateInfo | null>('check_for_update');
    debug('[updater] check result:', update?.version ?? 'none');
    return { update, error: null };
  } catch (e) {
    return { update: null, error: String(e) };
  }
}

/**
 * Downloads and installs the update.
 *
 * @remarks
 * On Linux the executable is replaced in place, so the running process keeps
 * the old code until it restarts. A restart is required for the new version to
 * take effect.
 */
export async function installUpdate(): Promise<void> {
  await invoke('install_update');
}

/**
 * Restarts the application.
 *
 * @remarks
 * The restart goes through Rust so that `RunEvent::Exit` runs and both the
 * sidecar and the proxies are stopped; `location.reload()` from the webview
 * would only reload the page, not the process. Control does not return. A
 * failed restart leaves the window open, and the error is not surfaced.
 */
export async function restartApp(): Promise<void> {
  await invoke('restart_app');
}
