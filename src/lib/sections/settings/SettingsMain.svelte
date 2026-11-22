<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { i18n } from "$lib/i18n";
  import { installUpdate, restartApp } from "$lib/stores/updater";
  import { updateState as updateCheck, runUpdateCheck } from "$lib/stores/updaterState.svelte";
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
   * Where the offer to update comes from is the shared checker (`updaterState`): it runs
   * once at start and then hourly, so by the time this screen is opened the answer is
   * already here. This screen adds only the install step, which stays a deliberate act.
   */
  const installState = $state<{
    status: 'idle' | 'installing' | 'installed' | 'error';
    error: string | null;
  }>({ status: 'idle', error: null });

  let currentVersion = $state<string | null>(null);

  onMount(() => {
    // The version comes from the app manifest rather than package.json: the bundle carries
    // the value from tauri.conf.json, and that is the one the update server compares against.
    getVersion()
      .then((v) => { currentVersion = v; })
      .catch(() => { currentVersion = 'unknown'; });
  });

  async function handleCheckUpdate() {
    // The check itself is shared: the result also lights the Settings dot in the menu and
    // the banner on the profile panel.
    await runUpdateCheck();
  }

  async function handleInstallUpdate() {
    installState.status = 'installing';
    installState.error = null;
    try {
      await installUpdate();
      // The binary is replaced in place on Linux: the running process keeps executing the
      // old code, so a restart is requested explicitly.
      installState.status = 'installed';
    } catch (e) {
      installState.status = 'error';
      installState.error = String(e);
    }
  }

  async function handleRestart() {
    // Control does not return: the process exits and starts again. The restart goes
    // through Rust rather than `location.reload()`, which would not swap the binary and
    // would skip the exit handler that shuts the backend down.
    try {
      await restartApp();
    } catch (e) {
      installState.status = 'error';
      installState.error = String(e);
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
          {(currentVersion ?? '…')}
        </span>
        <button
          class="px-4 py-2 rounded-md border border-border bg-card hover:bg-secondary disabled:opacity-50 disabled:cursor-not-allowed"
          disabled={updateCheck.checking || installState.status === 'installing'}
          onclick={handleCheckUpdate}
        >
          {updateCheck.checking ? i18n.t('Checking...') : i18n.t('Check for updates')}
        </button>
        {#if updateCheck.available && installState.status !== 'installed'}
          <button
            class="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90"
            onclick={handleInstallUpdate}
          >
            {i18n.t('Install')} {updateCheck.available.version}
          </button>
        {/if}
      </div>

      {#if updateCheck.available && installState.status !== 'installed'}
        <p class="text-sm text-foreground">{i18n.t('Update available')}: {updateCheck.available.version}</p>
        {#if updateCheck.available.notes}
          <pre class="text-xs text-muted-foreground whitespace-pre-wrap max-h-40 overflow-y-auto">{updateCheck.available.notes}</pre>
        {/if}
      {:else if !updateCheck.checking && !updateCheck.error && !updateCheck.available}
        <p class="text-sm text-muted-foreground">{i18n.t('You are up to date')}</p>
      {/if}

      {#if installState.status === 'installing'}
        <p class="text-sm text-foreground">{i18n.t('Installing...')}</p>
      {:else if installState.status === 'installed'}
        <div class="flex items-center gap-4 flex-wrap">
          <p class="text-sm text-foreground">{i18n.t('Restart required')}</p>
          <button
            class="px-4 py-2 rounded-md bg-primary text-primary-foreground hover:opacity-90"
            onclick={handleRestart}
          >
            {i18n.t('Restart')}
          </button>
        </div>
      {/if}

      {#if updateCheck.error || installState.status === 'error'}
        <p class="text-sm text-destructive break-words">{installState.error ?? updateCheck.error}</p>
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
