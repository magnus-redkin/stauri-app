<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { i18n } from "$lib/i18n";
  import { checkForUpdate, installUpdate, restartApp } from "$lib/stores/updater";
  import {
    uiState,
    setFontSize,
    setTheme,
    FONT_MIN,
    FONT_MAX,
  } from "$lib/stores/uiStore.svelte";

  /**
   * Theme and font size live in `uiStore`.
   *
   * The store applies them at startup; this screen only displays and changes the current
   * values, so the interface looks right before Settings has ever been opened.
   */
  const theme = $derived(uiState.theme);
  const fontSize = $derived(uiState.fontSize);

  /**
   * Update check state.
   *
   * `idle` means nothing has been checked yet: opening Settings does not hit the network, so
   * no requests are spent and the screen appears without delay.
   */
  const updateState = $state<{
    status: 'idle' | 'checking' | 'available' | 'uptodate' | 'installing' | 'installed' | 'error';
    currentVersion: string | null;
    version: string | null;
    notes: string | null;
    error: string | null;
  }>({
    status: 'idle',
    currentVersion: null,
    version: null,
    notes: null,
    error: null,
  });

  onMount(() => {
    // Theme and font size were applied by `loadUiPreferences` at startup, so only the
    // version is fetched here.

    // The version comes from the app manifest rather than package.json: the bundle carries
    // the value from tauri.conf.json, and that is the one the update server compares against.
    getVersion()
      .then((v) => { updateState.currentVersion = v; })
      .catch(() => { updateState.currentVersion = 'unknown'; });
  });

  async function handleCheckUpdate() {
    updateState.status = 'checking';
    updateState.error = null;

    const { update, error } = await checkForUpdate();

    if (error) {
      updateState.status = 'error';
      updateState.error = error;
    } else if (update) {
      updateState.status = 'available';
      updateState.version = update.version;
      updateState.notes = update.notes;
      if (!updateState.currentVersion) updateState.currentVersion = update.currentVersion;
    } else {
      updateState.status = 'uptodate';
      updateState.version = null;
      updateState.notes = null;
    }
  }

  async function handleInstallUpdate() {
    updateState.status = 'installing';
    updateState.error = null;
    try {
      await installUpdate();
      // The binary is replaced in place on Linux: the running process keeps executing the
      // old code, so a restart is requested explicitly.
      updateState.status = 'installed';
    } catch (e) {
      updateState.status = 'error';
      updateState.error = String(e);
    }
  }

  async function handleRestart() {
    // Control does not return: the process exits and starts again. The restart goes
    // through Rust rather than `location.reload()`, which would not swap the binary and
    // would skip the exit handler that shuts the backend down.
    try {
      await restartApp();
    } catch (e) {
      updateState.status = 'error';
      updateState.error = String(e);
    }
  }

  function changeLanguage(newLocale: string) {
    i18n.locale = newLocale;
    localStorage.setItem('stauri-locale', newLocale);
  }
</script>

<div class="h-full overflow-y-auto p-8 bg-background">
  <div class="max-w-2xl mx-auto space-y-8">
    <h1 class="text-3xl font-bold text-primary">{i18n.t('Settings')}</h1>

    <div class="space-y-2">
      <label class="font-medium text-foreground">{i18n.t('Language')}</label>
      <div class="flex gap-2">
        <button
          class="px-4 py-2 rounded-md border border-border {i18n.locale === 'en' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary'}"
          onclick={() => changeLanguage('en')}
        >
          English
        </button>
        <button
          class="px-4 py-2 rounded-md border border-border {i18n.locale === 'ru' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary'}"
          onclick={() => changeLanguage('ru')}
        >
          Русский
        </button>
        <button
          class="px-4 py-2 rounded-md border border-border {i18n.locale === 'zh' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary'}"
          onclick={() => changeLanguage('zh')}
        >
          中文
        </button>
        <button
          class="px-4 py-2 rounded-md border border-border {i18n.locale === 'es' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary'}"
          onclick={() => changeLanguage('es')}
          >
          Español
        </button>
      </div>
    </div>

    <div class="space-y-2">
      <label class="font-medium text-foreground">{i18n.t('Theme')}</label>
      <div class="flex gap-2">
        <button
          class="px-4 py-2 rounded-md border border-border {theme === 'maroon' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary'}"
          onclick={() => setTheme('maroon')}
        >
          {i18n.t('Maroon')}
        </button>
        <button
          class="px-4 py-2 rounded-md border border-border {theme === 'light' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary'}"
          onclick={() => setTheme('light')}
        >
          {i18n.t('Light')}
        </button>
        <button
          class="px-4 py-2 rounded-md border border-border {theme === 'dark' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary'}"
          onclick={() => setTheme('dark')}
        >
          {i18n.t('Dark')}
        </button>
        <button
          class="px-4 py-2 rounded-md border border-border {theme === 'green' ? 'bg-primary text-primary-foreground' : 'bg-card hover:bg-secondary'}"
          onclick={() => setTheme('green')}
        >
          {i18n.t('Green')}
        </button>
      </div>
    </div>

    <div class="space-y-2">
      <label class="font-medium text-foreground">{i18n.t('Font Size')}</label>
      <div class="flex items-center gap-4">
        <input
          type="range"
          min={FONT_MIN}
          max={FONT_MAX}
          value={fontSize}
          oninput={(e) => setFontSize(Number((e.target as HTMLInputElement).value))}
          class="w-full accent-primary"
        />
        <span class="font-mono text-sm">{fontSize}px</span>
      </div>
    </div>

    <div class="space-y-2">
      <label class="font-medium text-foreground" for="app-version">{i18n.t('Version')}</label>
      <div class="flex items-center gap-4 flex-wrap">
        <span id="app-version" class="font-mono text-sm text-muted-foreground">
          {(updateState.currentVersion ?? '…')}
        </span>
        <button
          class="px-4 py-2 rounded-md border border-border bg-card hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={updateState.status === 'checking' || updateState.status === 'installing'}
          onclick={handleCheckUpdate}
        >
          {updateState.status === 'checking' ? i18n.t('Checking...') : i18n.t('Check for updates')}
        </button>
        {#if updateState.status === 'available'}
          <button
            class="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90"
            onclick={handleInstallUpdate}
          >
            {i18n.t('Install')} {updateState.version}
          </button>
        {/if}
      </div>

      {#if updateState.status === 'available'}
        <p class="text-sm text-foreground">{i18n.t('Update available')}: {updateState.version}</p>
        {#if updateState.notes}
          <pre class="text-xs text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto">{updateState.notes}</pre>
        {/if}
      {:else if updateState.status === 'uptodate'}
        <p class="text-sm text-muted-foreground">{i18n.t('You are up to date')}</p>
      {:else if updateState.status === 'installing'}
        <p class="text-sm text-foreground">{i18n.t('Installing...')}</p>
      {:else if updateState.status === 'installed'}
        <div class="flex items-center gap-4 flex-wrap">
          <p class="text-sm text-foreground">{i18n.t('Restart required')}</p>
          <button
            class="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90"
            onclick={handleRestart}
          >
            {i18n.t('Restart')}
          </button>
        </div>
      {:else if updateState.status === 'error'}
        <p class="text-sm text-destructive break-words">{updateState.error}</p>
        <button
          class="px-3 py-1 rounded-md border border-border bg-card hover:bg-secondary text-sm"
          onclick={handleCheckUpdate}
        >
          {i18n.t('Retry')}
        </button>
      {/if}
    </div>
  </div>
</div>
