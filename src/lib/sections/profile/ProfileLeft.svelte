<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
  import { User } from "lucide-svelte";
  import { getVersion } from '@tauri-apps/api/app';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import { ensState } from '$lib/stores/ensStore.svelte';
  import { profileAvatarState } from '$lib/stores/profileStore.svelte';
  import { updateState, runUpdateCheck } from '$lib/stores/updaterState.svelte';
  import NetworkInfo from './NetworkInfo.svelte';

  let {
    displayName = "Tauri User",
    /** Narrow layout: the shell header already carries the title and the pencil. */
    compact = false,
    onDisconnect,
    onCreateSeed,
    onEditProfile,
    onSendProfile,
    onOpenSettings
  }: {
    displayName?: string,
    compact?: boolean,
    onDisconnect?: () => void,
    onCreateSeed?: () => void,
    /** Opens profile editing — the pencil in the header on a phone, a link on a wide screen. */
    onEditProfile?: () => void,
    /**
     * Opens the pairing screen as the sending side.
     *
     * @remarks
     * Sending needs a logged-in profile — the keys are what travels — so the entry point
     * lives here rather than on the login screen.
     */
    onSendProfile?: () => void,
    /** Where the update banner leads: the section that holds the install button. */
    onOpenSettings?: () => void
  } = $props();

  let copiedProfileId = $state(false);
  let copiedPubKey = $state(false);

  /**
   * Version of the running build, as compiled into the package.
   *
   * @remarks
   * Read from Tauri rather than from `package.json`: only the binary knows what it was
   * actually built as. Without it there is no way to tell an updated install from the
   * old one, which is exactly the question a silent update leaves open.
   */
  let version = $state('');

  getVersion()
    .then((v) => (version = v))
    .catch(() => {
      // Outside the Tauri host (a browser preview, a unit test) there is no version to
      // ask for; the line is simply not shown.
    });

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
  {#if !compact}
    <!--
      A phone already shows "Profile" and the pencil in the shell header; repeating them
      here produced two titles over one pane.
    -->
    <div class="p-4 border-b border-border font-bold text-lg text-primary">
      {i18n.t('Profile')}
    </div>
  {/if}

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
              ⚠️ {i18n.t('Seed phrase not saved')}
          </button>
        {/if}
      </div>
    {/if}
  </ScrollArea>

  <!--
    The bottom of the panel belongs to actions that must stay reachable: the offer to
    update, and the code that copies this profile to another device. Pairing is how a
    second device is set up, so it is never hidden behind a menu — and pinning it here
    keeps it visible however long the account block above grows.
  -->
  <div class="shrink-0 p-3 border-t border-border space-y-2 bg-card">
    {#if updateState.available}
      <button
        type="button"
        onclick={() => onOpenSettings?.()}
        class="w-full p-2 rounded-md bg-warning text-warning-foreground text-xs font-semibold text-center hover:opacity-90 transition"
      >
        {i18n.t('Update Stauri to')} {updateState.available.version}
      </button>
    {/if}
    {#if version}
      <!--
        The running version sits where the update offer appears, so "was I updated?" is
        answerable without a terminal. Clicking asks the server again: the background
        check runs once at start and then hourly, so right after a release the app can
        legitimately have nothing to show for up to an hour. The title carries the last
        check's outcome, because "current" and "check failed" look identical otherwise.
      -->
      <button
        type="button"
        onclick={() => void runUpdateCheck()}
        class="w-full text-center text-[0.6875rem] text-muted-foreground hover:text-primary transition-colors cursor-pointer"
        title={updateState.error
          ? `${i18n.t('Update check failed')}: ${updateState.error}`
          : updateState.checking
            ? i18n.t('Checking for updates…')
            : i18n.t('No newer version found')}
      >
        Stauri v. {version}
      </button>
    {/if}
    <button
      onclick={() => onSendProfile?.()}
      class="w-full p-2 border border-border rounded-md text-xs font-medium text-foreground hover:bg-secondary transition-colors"
    >
      {i18n.t('Code for sync')}
    </button>
  </div>
</div>
