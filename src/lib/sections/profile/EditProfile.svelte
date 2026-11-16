<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { untrack } from 'svelte';
  import { statusState, setSeedSaved } from '$lib/stores/statusStore.svelte';
  import { ensState, loadProfileNames } from '$lib/stores/ensStore.svelte';
  import { saveSetting } from '$lib/status/wallet';
  import { sendContactUpdates } from '$lib/status/messaging';
  import { formatError } from '$lib/utils/errors';
  import { User } from 'lucide-svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';
  import CreateSeed from './CreateSeed.svelte';
  import EnsNameBlock from './EnsNameBlock.svelte';

  let { onNavigate }: { onNavigate?: (section: string) => void } = $props();

  let originalDisplayName = $state(statusState.alias || '');
  let displayName = $state(originalDisplayName);
  let userpicOpen = $state(false);
  let showCreateSeed = $state(false);

  let isChanged = $derived(displayName !== originalDisplayName);
  let saveError = $state('');

  /**
   * Saves the display name to the node and pushes it to existing contacts.
   *
   * The name must reach the node first: otherwise contact requests go out with the
   * placeholder from profile creation. Failures stay on this page and no navigation happens.
   *
   * @returns Whether the name was saved.
   */
  async function saveProfile(): Promise<boolean> {
    if (!isChanged) return true;
    if (!statusState.backendRunning) {
      saveError = i18n.t('Backend is not running');
      return false;
    }
    try {
      await saveSetting('display-name', displayName);
      await sendContactUpdates(displayName);
      statusState.alias = displayName;
      originalDisplayName = displayName;
      saveError = '';
      return true;
    } catch (e) {
      saveError = formatError(e);
      return false;
    }
  }

  function handleSeedSaved() {
    setSeedSaved(true);
    showCreateSeed = false;
  }

  /**
   * Loads the profile's ENS names when the section opens.
   *
   * The call must be wrapped in `untrack`: `loadProfileNames` writes
   * `ensState.profileNames`, and an effect that reads state it also changes would restart
   * itself.
   *
   * Names are read here rather than at login because only the profile displays them; a
   * request at login would almost never have anything to show.
   */
  $effect(() => {
    const loggedIn = statusState.isLoggedIn;
    if (!loggedIn) return;
    untrack(() => {
      loadProfileNames();
    });
  });
</script>

{#if showCreateSeed}
  <CreateSeed
    onBack={() => showCreateSeed = false}
    onSave={handleSeedSaved}
  />
{:else}
  <div class="p-8 max-w-2xl mx-auto w-full h-full flex flex-col bg-card">
    <h2 class="text-2xl font-bold text-primary mb-6">{i18n.t('Edit Profile')}</h2>

    <div class="flex flex-col gap-6 max-w-md mx-auto w-full">
      <div class="flex items-center gap-4">
        <div class="w-20 h-20 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">
          <User size={36} />
        </div>
        <button onclick={() => userpicOpen = true} class="text-sm text-primary hover:underline">
          {i18n.t('Upload Userpic')}
        </button>
      </div>

      <div>
        <label class="text-sm font-medium text-foreground">Display Name</label>
        <input
          bind:value={displayName}
          class="w-full h-10 border border-input rounded-md px-3 mt-1 bg-background"
        />
      </div>

      <EnsNameBlock />

      <!--
        The ENS name as a caption under the display name. It appears only once the profile
        knows about it (`ens_getEnsUsernames`, see `loadProfileNames`), and it is always the
        full form: the shortened one resolves in no client, so pasting it into a recipient
        field would do nothing.
      -->
      {#if ensState.profileNames.length > 0}
        <p class="text-xs text-muted-foreground font-mono break-all">
          {ensState.profileNames[0]}
        </p>
      {/if}

        {#if statusState.isSeedSaved}
          <div class="p-3 rounded-lg border bg-green-100 text-green-800 border-green-300">
            ✅ {i18n.t('Seed-фраза сохранена')}
          </div>
        {:else}
          <button
            onclick={() => showCreateSeed = true}
            class="w-full p-3 rounded-lg border bg-red-100 text-red-700 border-red-300 hover:bg-red-200 transition-colors text-left flex items-center justify-between"
            >
            <span>⚠️ {i18n.t('Создать seed-фразу')}</span>
          </button>
        {/if}
        {#if saveError}
          <p class="mt-3 text-sm text-red-600">{saveError}</p>
        {/if}
        <!-- The save button is disabled only by its own handler, so the block above it is
             retried without leaving the page. -->
          <div class="mt-4">
            <button
              onclick={async () => {
              if (await saveProfile()) onNavigate?.('home');
              }}
              class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition"
              >
              {i18n.t('Save')}
            </button>
          </div>
    </div>
  </div>

  <!-- Userpic dialog -->
  <Dialog.Root bind:open={userpicOpen}>
    <Dialog.Content class="sm:max-w-[425px]">
      <Dialog.Header>
        <Dialog.Title>{i18n.t('Upload Userpic')}</Dialog.Title>
      </Dialog.Header>
      <div class="p-4 border-2 border-dashed border-border rounded-lg text-center">
        <p class="text-sm text-muted-foreground">{i18n.t('Drag and drop image here, or click to select')}</p>
        <input type="file" accept="image/*" class="mt-2" />
      </div>
      <Dialog.Footer>
        <button onclick={() => userpicOpen = false} class="w-full py-2 bg-primary text-primary-foreground rounded-md">
          {i18n.t('Close')}
        </button>
      </Dialog.Footer>
    </Dialog.Content>
  </Dialog.Root>
{/if}
