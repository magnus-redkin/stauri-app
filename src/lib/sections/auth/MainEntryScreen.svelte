<script lang="ts">
  import { i18n } from '$lib/i18n';
  import NetworkPicker from './NetworkPicker.svelte';
  import ProfileLoginBlock from './ProfileLoginBlock.svelte';
  import CreateProfileBlock from './CreateProfileBlock.svelte';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { error } from '$lib/utils/log';

  /** Repository with the source code, opened in the system browser. */
  const REPO_URL = 'https://github.com/magnus-redkin/stauri-app';

  async function openRepo(): Promise<void> {
    try {
      await invoke('open_external', { url: REPO_URL });
    } catch (e) {
      error(`[entry] cannot open the repository: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  let {
    onLogin,
    onCreate,
    onRecovery,
    onNetworkChange,
    hasProfiles = false,
    selectedAccountKeyUid = $bindable(''),
    selectedNetwork = $bindable('mainnet')
  }: {
    onLogin: (password: string) => void;
    onCreate: (password: string) => void;
    onRecovery: () => void;
    onNetworkChange?: (network: string) => void;
    hasProfiles: boolean;
    selectedAccountKeyUid: string;
    selectedNetwork: string;
  } = $props();

  // Separate password state for the two blocks, so switching between them does not carry a
  // value into the wrong form.
  let loginPassword = $state('');
  let createPassword = $state('');

  let showCreate = $state(false);
</script>

<div class="relative flex flex-col items-center justify-center min-h-screen gap-6 p-4 bg-background">
  <button
    onclick={openRepo}
    class="absolute top-4 right-4 p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
    title={i18n.t('Source code on GitHub')}
    aria-label={i18n.t('Source code on GitHub')}
  >
    <svg viewBox="0 0 16 16" width="22" height="22" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  </button>
  <h1 class="text-3xl font-bold text-foreground">Stauri</h1>

  <NetworkPicker
    bind:selectedNetwork
    onSelect={(net) => onNetworkChange?.(net)}
  />

  <div class="w-full max-w-md h-px bg-border my-2"></div>

  {#if hasProfiles}
    <ProfileLoginBlock
      bind:selectedAccountKeyUid
      bind:password={loginPassword}
      onLogin={() => onLogin(loginPassword)}
    />

    {#if !showCreate}
      <button
        onclick={() => showCreate = true}
        class="w-full max-w-md py-2 border border-border rounded-md text-sm font-medium hover:bg-secondary transition"
      >
        + {i18n.t('Create new profile')}
      </button>
    {/if}
  {/if}

  {#if !hasProfiles || showCreate}
    <CreateProfileBlock
      bind:password={createPassword}
      onCreate={() => onCreate(createPassword)}
    />
  {/if}

  <div class="w-full max-w-md flex flex-col gap-2 mt-2">
    <button
      onclick={onRecovery}
      class="w-full py-2 border border-border rounded-md text-sm font-medium hover:bg-secondary transition"
    >
      {i18n.t('Log in by recovery phrase')}
    </button>

    <button
      disabled
      class="w-full py-2 border border-border rounded-md text-sm font-medium opacity-50 cursor-not-allowed"
    >
      {i18n.t('Log in by sync')} (Coming Soon)
    </button>

    <button
      disabled
      class="w-full py-2 border border-border rounded-md text-sm font-medium opacity-50 cursor-not-allowed"
    >
      {i18n.t('Log in with Keycard')} (Coming Soon)
    </button>
  </div>

  {#if statusState.errorMsg}
    <p class="text-destructive text-sm text-center max-w-md">{statusState.errorMsg}</p>
  {/if}
  {#if statusState.probe}
    <p class="text-primary text-xs text-center max-w-md break-all">{statusState.probe}</p>
  {/if}
</div>
