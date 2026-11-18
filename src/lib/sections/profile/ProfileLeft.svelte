<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { User } from "lucide-svelte";
  import { statusState } from '$lib/stores/statusStore.svelte';
  import { ensState } from '$lib/stores/ensStore.svelte';
  import { profileAvatarState } from '$lib/stores/profileStore.svelte';
  import NetworkInfo from './NetworkInfo.svelte';

  let {
    displayName = "Tauri User",
    onDisconnect,
    onCreateSeed,
    onEditProfile
  }: {
    displayName?: string,
    onDisconnect?: () => void,
    onCreateSeed?: () => void,
    /** Opens profile editing (the only route to it in the app). */
    onEditProfile?: () => void
  } = $props();

  let copiedProfileId = $state(false);
  let copiedPubKey = $state(false);

  async function copyProfileId() {
    if (!statusState.accountKeyUid) return;
    try {
      await navigator.clipboard.writeText(statusState.accountKeyUid);
      copiedProfileId = true;
      setTimeout(() => copiedProfileId = false, 2000);
    } catch (e) { console.error(e); }
  }

  async function copyPubKey() {
    if (!statusState.publicKey) return;
    try {
      await navigator.clipboard.writeText(statusState.publicKey);
      copiedPubKey = true;
      setTimeout(() => copiedPubKey = false, 2000);
    } catch (e) { console.error(e); }
  }
</script>

<div class="flex flex-col h-full border-r border-border bg-card">
  <div class="p-4 border-b border-border font-bold text-lg text-primary">
    {i18n.t('Profile')}
  </div>

  <!-- Link to editing: on a narrow screen this is the only way into the profile editor. -->
  <div class="px-4 py-2 border-b border-border">
    <button
      type="button"
      onclick={() => onEditProfile?.()}
      class="text-sm font-medium text-primary hover:underline"
    >
      {i18n.t('Edit profile')}
    </button>
  </div>

  <ScrollArea class="flex-1 min-h-0 overflow-x-hidden">
    <div class="p-4 border-b border-border bg-secondary/30">
      {#if statusState.isConnecting}
        <div class="flex items-center gap-2 text-sm text-muted-foreground">
          <div class="w-2 h-2 rounded-full bg-warning animate-pulse"></div>
          {i18n.t('Connecting...')}
        </div>
      {:else if statusState.isConnected}
        <div class="flex items-center gap-2 text-success font-semibold text-sm">
          <div class="w-2 h-2 rounded-full bg-success"></div>
          {i18n.t('Connected')}
        </div>
        <button
          onclick={onDisconnect}
          class="mt-1 text-xs text-destructive hover:underline"
        >
          {i18n.t('Disconnect')}
        </button>

        <div class="mt-3">
          <div class="text-[0.75rem] font-bold text-muted-foreground uppercase">Profile ID</div>
          <button
            onclick={copyProfileId}
            class="mt-0.5 text-[0.75rem] font-mono text-muted-foreground text-left hover:text-primary transition-colors cursor-pointer"
            title={i18n.t('Click to copy')}
          >
            {statusState.accountKeyUid ? statusState.accountKeyUid.substring(0, 6) + '...' : '...'}
            {#if copiedProfileId}<span class="ml-1 text-success font-sans font-bold">✓ Copied!</span>{/if}
          </button>
        </div>

        <div class="mt-2">
          <div class="text-[0.75rem] font-bold text-muted-foreground uppercase">Public Key (for chat)</div>
          <button
            onclick={copyPubKey}
            class="mt-0.5 text-[0.75rem] font-mono text-muted-foreground text-left hover:text-primary transition-colors cursor-pointer"
            title={i18n.t('Click to copy')}
          >
            {statusState.publicKey ? statusState.publicKey.substring(0, 6) + '...' : '(loading...)'}
            {#if copiedPubKey}<span class="ml-1 text-success font-sans font-bold">✓ Copied!</span>{/if}
          </button>
        </div>

        <NetworkInfo />
      {:else}
        <button class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium">
          {i18n.t('Connect')}
        </button>
      {/if}
    </div>

    {#if statusState.isLoggedIn}
      <div class="p-4 flex flex-col items-center gap-3">
        <!--
          The same picture the editing pane shows. Both read `profileAvatarState`: an
          upload happens in one pane, and without a shared source the other keeps the
          placeholder until the window is reloaded.
        -->
        <div
          class="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center text-primary overflow-hidden"
        >
          {#if profileAvatarState.url}
            <img src={profileAvatarState.url} alt="" class="w-full h-full object-cover" />
          {:else}
            <User size={32} />
          {/if}
        </div>
        <div class="text-center">
          <div class="font-bold text-lg">{statusState.alias || displayName}</div>
          <!--
            The ENS name under the alias. It stays empty until the profile knows about it:
            the name is read through `ens_getEnsUsernames`, not by reverse resolution, since
            the Status registrar does not create a reverse record.
          -->
          {#if ensState.profileNames.length > 0}
            <div class="text-xs text-muted-foreground font-mono break-all mt-0.5">
              {ensState.profileNames[0]}
            </div>
          {/if}
          <div class="text-xs text-muted-foreground">
            {statusState.accountKeyUid ? statusState.accountKeyUid.substring(0, 8) + '...' : ''}
          </div>
        </div>

        {#if !statusState.isSeedSaved}
          <button
            onclick={() => onCreateSeed?.()}
                                                      class="w-full p-2 bg-destructive/10 text-destructive rounded-md text-xs font-semibold text-center border border-destructive/30 hover:bg-destructive/20 transition-colors cursor-pointer"
                                                      >
              ⚠️ {i18n.t('Seed-фраза не сохранена')}
          </button>
        {/if}
      </div>
    {/if}
  </ScrollArea>
</div>
