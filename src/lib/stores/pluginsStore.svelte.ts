/**
 * dApp plugins installed in Stauri.
 *
 * A plugin is a WASM module plus an optional UI bundle, installed from a manifest by URL.
 * The store is thin on purpose: installing, listing and opening are Rust commands
 * (`src-tauri/src/dapps.rs`), and this only keeps what the panel shows.
 */
import { invoke } from '@tauri-apps/api/core';
import { formatError } from '$lib/utils/errors';

/** One installed dApp, as `dapp_list` reports it. */
export interface InstalledDapp {
  id: string;
  name: string;
  version: string;
  permissions: string[];
  exports: string[];
  has_ui: boolean;
}

export const pluginsState = $state({
  items: [] as InstalledDapp[],
  /** Manifest URL typed into the install field. */
  manifestUrl: '',
  isInstalling: false,
  /** Last error of install, open or remove; empty when there is none. */
  error: '',
  loaded: false,
});

/** Reads the installed dApps. */
export async function loadPlugins(): Promise<void> {
  try {
    pluginsState.items = await invoke<InstalledDapp[]>('dapp_list');
    pluginsState.loaded = true;
  } catch (e) {
    pluginsState.error = formatError(e);
  }
}

/** Installs from the typed manifest URL and refreshes the list. */
export async function installPlugin(): Promise<boolean> {
  const url = pluginsState.manifestUrl.trim();
  if (!url) {
    pluginsState.error = 'Enter a dApp manifest URL';
    return false;
  }
  pluginsState.isInstalling = true;
  pluginsState.error = '';
  try {
    await invoke<InstalledDapp>('dapp_install', { manifestUrl: url });
    pluginsState.manifestUrl = '';
    await loadPlugins();
    return true;
  } catch (e) {
    pluginsState.error = formatError(e);
    return false;
  } finally {
    pluginsState.isInstalling = false;
  }
}

/** Opens a dApp page in its own window. */
export async function openPlugin(id: string): Promise<void> {
  try {
    pluginsState.error = '';
    await invoke('dapp_open', { id });
  } catch (e) {
    pluginsState.error = formatError(e);
  }
}

/** Removes a dApp and its stored versions. */
export async function removePlugin(id: string): Promise<void> {
  try {
    pluginsState.error = '';
    await invoke('dapp_remove', { id });
    await loadPlugins();
  } catch (e) {
    pluginsState.error = formatError(e);
  }
}
