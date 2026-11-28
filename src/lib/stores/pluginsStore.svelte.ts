/**
 * The dApps section: installed plugins and external dApps in one list.
 *
 * Both kinds are added from the same address field and both appear on the left. They
 * differ only in where they open: a plugin renders in the section itself (an isolated
 * frame served by Rust), an external dApp opens in its own window and has no access to
 * Stauri. See `docs/en/dapp-connect.md`.
 */
import { invoke } from '@tauri-apps/api/core';
import { formatError } from '$lib/utils/errors';
import { warn } from '$lib/utils/log';

/** One row of the section. Matches `DappEntry` in `src-tauri/src/dapps.rs`. */
export interface DappEntry {
  id: string;
  /** `plugin` runs in the section; `external` opens in its own window. */
  kind: 'plugin' | 'external';
  name: string;
  version: string | null;
  /** External dApps: the address the window opens. */
  url: string;
  has_ui: boolean;
}

export const pluginsState = $state({
  items: [] as DappEntry[],
  /** Address typed into the add field. */
  addUrl: '',
  /** What the section shows when no plugin is open: the list or the add form. */
  view: 'list' as 'list' | 'add',
  /** The plugin open in the section, or `null`. One at a time. */
  selected: null as DappEntry | null,
  /** Session address of the open plugin's page. */
  frameUrl: '',
  error: '',
  isAdding: false,
  loaded: false,
});

/** Reads plugins and external dApps. */
export async function loadDapps(): Promise<void> {
  try {
    pluginsState.items = await invoke<DappEntry[]>('dapp_list');
    pluginsState.loaded = true;
  } catch (e) {
    pluginsState.error = formatError(e);
  }
}

/** Adds whatever the address points at: a manifest installs, a page is registered. */
export async function addDapp(): Promise<boolean> {
  const url = pluginsState.addUrl.trim();
  if (!url) {
    pluginsState.error = 'Enter a dApp address';
    return false;
  }
  pluginsState.isAdding = true;
  pluginsState.error = '';
  try {
    await invoke<DappEntry>('dapp_add', { url });
    pluginsState.addUrl = '';
    pluginsState.view = 'list';
    await loadDapps();
    return true;
  } catch (e) {
    pluginsState.error = formatError(e);
    return false;
  } finally {
    pluginsState.isAdding = false;
  }
}

/** Opens a row: a plugin in the section, an external dApp in its own window. */
export async function openDapp(entry: DappEntry): Promise<void> {
  pluginsState.error = '';
  try {
    if (entry.kind === 'external') {
      await invoke('open_dapp', { url: entry.url });
      return;
    }
    pluginsState.frameUrl = '';
    pluginsState.frameUrl = await invoke<string>('dapp_open', { id: entry.id });
    pluginsState.selected = entry;
  } catch (e) {
    pluginsState.error = formatError(e);
    warn(`[dapp] open ${entry.id} failed:`, e);
  }
}

/** Closes the open plugin and returns to the list. */
export function closeDapp(): void {
  pluginsState.selected = null;
  pluginsState.frameUrl = '';
}

/** Switches the section to the add form. */
export function showAddDapp(): void {
  pluginsState.selected = null;
  pluginsState.frameUrl = '';
  pluginsState.view = 'add';
}

/** Removes a row: a plugin with its versions, or an external entry. */
export async function removeDapp(entry: DappEntry): Promise<void> {
  try {
    pluginsState.error = '';
    await invoke('dapp_remove', { id: entry.id });
    if (pluginsState.selected?.id === entry.id) closeDapp();
    await loadDapps();
  } catch (e) {
    pluginsState.error = formatError(e);
  }
}

/** Suggested plugin, offered in the add form as a one-click fill of the address field. */
export const PLUGIN_EXAMPLES: { id: string; icon: string; title: string; sub: string; url: string }[] = [
  {
    id: 'market',
    icon: '◈',
    title: 'Market',
    sub: 'Plugin: coin list with prices, 24-hour change, volume and market cap',
    url: 'https://github.com/magnus-redkin/stauri-dapps/releases/download/v0.1.3/market-manifest.json',
  },
];
