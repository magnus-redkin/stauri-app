<script lang="ts">
  /**
   * Profile editing: picture, name, ENS, password, seed phrase.
   *
   * @remarks
   * The blocks are ordered the way the user meets them: identity first (picture, name),
   * then the two secrets — the password that protects this device and the seed phrase
   * that restores the profile anywhere. Each secret has its own button, so saving a
   * name never implies anything about them.
   */
  import { i18n } from '$lib/i18n';
  import { untrack } from 'svelte';
  import { statusState, setSeedSaved } from '$lib/stores/statusStore.svelte';
  import { rememberProfileName } from '$lib/stores/profileNames';
  import { ensState, loadProfileNames } from '$lib/stores/ensStore.svelte';
  import { profileAvatarState, ensureProfileAvatar } from '$lib/stores/profileStore.svelte';
  import { saveSetting } from '$lib/status/wallet';
  import { sendContactUpdates } from '$lib/status/messaging';
  import { contactsState, loadContacts } from '$lib/stores/contactsStore.svelte';
  import { applyContacts } from '$lib/stores/chatsStore.svelte';
  import { formatError } from '$lib/utils/errors';
  import { displayNameError } from '$lib/utils/displayName';
  import {
    avatarProblem,
    storeAvatar,
    AVATAR_MIN_SIDE,
    AVATAR_MAX_BYTES,
    AVATAR_TYPES,
  } from '$lib/status/profile';
  import { info } from '$lib/utils/log';
  import { User } from 'lucide-svelte';
  import CreateSeed from './CreateSeed.svelte';
  import ChangePassword from './ChangePassword.svelte';
  import EnsNameBlock from './EnsNameBlock.svelte';

  let {
    onNavigate,
    compact = false,
  }: {
    onNavigate?: (section: string) => void;
    /** Narrow layout: the shell header already says "Edit Profile" and carries the pencil. */
    compact?: boolean;
  } = $props();

  let originalDisplayName = $state(statusState.alias || '');
  let displayName = $state(originalDisplayName);
  let showCreateSeed = $state(false);
  let saveError = $state('');

  /**
   * ENS name the profile had when this pane opened.
   *
   * Compared against the live value so a name registered in the block above counts as
   * a pending change. `ensSeen` guards the first load: until the names arrive there is
   * nothing to compare, and without the guard the button would light up by itself as
   * soon as they did.
   */
  let savedEns = $state('');
  let ensSeen = $state(false);
  const ensOfProfile = $derived(ensState.profileNames[0] ?? '');
  const ensChanged = $derived(ensSeen && ensOfProfile !== savedEns);

  /**
   * Whether a new picture was uploaded in this visit.
   *
   * status-go stores and publishes the picture the moment it is uploaded, so there is
   * nothing technically left to save. The flag still counts as a change: the button
   * below is the single "apply my identity" action, and pressing it re-sends the
   * contact updates, which is what makes the new picture show up for people who
   * already have this profile in their list.
   */
  let avatarChanged = $state(false);

  const isChanged = $derived(
    displayName !== originalDisplayName || ensChanged || avatarChanged
  );
  /**
   * Rule violation, translated, or `null`.
   *
   * Checked before saving: status-go refuses such a name only on the receiving
   * side, where the update is dropped without the sender noticing.
   */
  const nameProblem = $derived(displayNameError(displayName));

  /** Set while a picture is being uploaded: the button is disabled and says so. */
  let avatarBusy = $state(false);
  let avatarError = $state('');
  let avatarSaved = $state(false);
  /** File input, reset after every pick so the same file can be chosen twice. */
  let avatarInput: HTMLInputElement | undefined = $state();

  /**
   * Saves the identity and pushes it to existing contacts.
   *
   * The name must reach the node first: otherwise contact requests go out with the
   * placeholder from profile creation. Failures stay on this page and no navigation happens.
   *
   * @returns Whether the settings were saved.
   */
  async function saveProfile(): Promise<boolean> {
    if (!isChanged) return true;
    if (!statusState.backendRunning) {
      saveError = i18n.t('Backend is not running');
      return false;
    }
    if (nameProblem) {
      saveError = i18n.t(nameProblem);
      return false;
    }
    try {
      await saveSetting('display-name', displayName);
      // status-go reads the display name from settings itself, so it has to be stored
      // first. The argument here is the ENS name, not the display name.
      await sendContactUpdates(ensOfProfile);
      statusState.alias = displayName;
      // The entry screen labels profiles from this cache; a rename that stayed only in
      // session state would show the old name after the next start.
      rememberProfileName(statusState.accountKeyUid, displayName);
      // The own contact record carries the name too; reread it so the list and
      // the chat header show the new one at once.
      await loadContacts(true);
      applyContacts(contactsState.items);

      originalDisplayName = displayName;
      savedEns = ensOfProfile;
      avatarChanged = false;
      saveError = '';
      return true;
    } catch (e) {
      saveError = formatError(e);
      return false;
    }
  }

  /**
   * Validates and uploads the chosen picture.
   *
   * @param event - Change event of the file input.
   * @remarks
   * The checks run before anything crosses the IPC boundary: a wrong format or an
   * oversized file is refused with a sentence, instead of transferring megabytes to
   * Rust only to be decoded and rejected there.
   */
  async function handleAvatarPick(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Reset first: without it picking the same file again fires no change event.
    input.value = '';
    if (!file) return;

    avatarError = '';
    avatarSaved = false;
    avatarBusy = true;
    try {
      const problem = await avatarProblem(file);
      if (problem) {
        avatarError = i18n.t(problem);
        return;
      }
      const stored = await storeAvatar(file);
      info(
        `[profile] avatar stored kinds=${stored.kinds.join(',')} ${stored.width}×${stored.height}`
      );
      // The shared store is what the left column reads: refetching it here makes both
      // panes show the new picture at once, without a reload.
      await ensureProfileAvatar(true);
      avatarChanged = true;
      avatarSaved = true;
    } catch (e) {
      avatarError = formatError(e);
    } finally {
      avatarBusy = false;
    }
  }

  function handleSeedSaved() {
    setSeedSaved(true);
    showCreateSeed = false;
  }

  /**
   * Loads the picture and the profile's ENS names when the section opens.
   *
   * The calls must be wrapped in `untrack`: they write `ensState.profileNames` and
   * `profileAvatarState`, and an effect that reads state it also changes would restart
   * itself.
   *
   * Names are read here rather than at login because only the profile displays them; a
   * request at login would almost never have anything to show.
   */
  $effect(() => {
    const loggedIn = statusState.isLoggedIn;
    if (!loggedIn) return;
    untrack(async () => {
      await ensureProfileAvatar();
      await loadProfileNames();
      // Baseline for the "changed" comparison: whatever the profile has now is what
      // the user started from.
      if (!ensSeen) {
        savedEns = ensState.profileNames[0] ?? '';
        ensSeen = true;
      }
    });
  });
</script>

{#if showCreateSeed}
  <CreateSeed
    onBack={() => (showCreateSeed = false)}
    onSave={handleSeedSaved}
  />
{:else}
  <div class="p-8 max-w-2xl mx-auto w-full h-full flex flex-col bg-card">
    {#if !compact}
      <!-- On a phone the shell header is the title, with the pencil next to it. -->
      <h2 class="text-2xl font-bold text-primary mb-6">{i18n.t('Edit Profile')}</h2>
    {/if}

    <div class="flex flex-col gap-6 max-w-md mx-auto w-full">
      <!-- Picture -->
      <div class="flex items-center gap-4">
        <div
          class="w-20 h-20 rounded-full bg-secondary flex items-center justify-center text-muted-foreground overflow-hidden shrink-0"
        >
          {#if profileAvatarState.url}
            <img src={profileAvatarState.url} alt="" class="w-full h-full object-cover" />
          {:else}
            <User size={36} />
          {/if}
        </div>
        <div class="flex flex-col gap-1">
          <button
            onclick={() => avatarInput?.click()}
            disabled={avatarBusy}
            class="text-sm text-primary hover:underline text-left disabled:opacity-50"
          >
            {avatarBusy ? i18n.t('Uploading…') : i18n.t('Upload Userpic')}
          </button>
          <!-- Requirements stated up front: the same rules are enforced on pick, so
               this is what stops a rejected file from looking arbitrary. -->
          <p class="text-xs text-muted-foreground">
            {i18n.t('PNG, JPEG or WebP, at least {side}×{side} px, up to {size} MB')
              .replace('{side}', String(AVATAR_MIN_SIDE))
              .replace('{size}', String(AVATAR_MAX_BYTES / (1024 * 1024)))}
          </p>
          {#if avatarError}
            <p class="text-xs text-destructive" aria-live="polite">{avatarError}</p>
          {:else if avatarSaved}
            <p class="text-xs text-success" aria-live="polite">{i18n.t('Picture updated')}</p>
          {/if}
        </div>
        <input
          type="file"
          accept={AVATAR_TYPES.join(',')}
          bind:this={avatarInput}
          onchange={handleAvatarPick}
          class="hidden"
        />
      </div>

      <!-- Display name. Not a local nickname: status-go sends this value to contacts
           through `wakuext_sendContactUpdates`, so everyone sees it. -->
      <div>
        <label class="text-sm font-medium text-foreground" for="display-name">
          {i18n.t('Display name')}
        </label>
        <input
          id="display-name"
          bind:value={displayName}
          aria-invalid={nameProblem ? 'true' : undefined}
          class="w-full h-10 border rounded-md px-3 mt-1 bg-background {nameProblem
            ? 'border-destructive'
            : 'border-input'}"
        />
        {#if nameProblem}
          <p class="mt-1 text-xs text-destructive" aria-live="polite">{i18n.t(nameProblem)}</p>
        {/if}
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

      {#if saveError}
        <p class="text-sm text-destructive">{saveError}</p>
      {/if}

      <!-- One button for the whole identity block: name, ENS and picture. The two
           secrets below have their own buttons. -->
      <button
        onclick={async () => {
          if (await saveProfile()) onNavigate?.('home');
        }}
        disabled={!isChanged || !!nameProblem}
        class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {i18n.t('Save name settings')}
      </button>

      <div class="border-t border-border pt-4 flex flex-col gap-3">
        <ChangePassword />

        {#if statusState.isSeedSaved}
          <!-- Green once the phrase was written down and verified: the warning in the
               left column disappears at the same time (`isSeedSaved` drives both). -->
          <div
            class="w-full p-3 rounded-lg border bg-success/10 text-success border-success/30 text-sm flex items-center gap-2"
          >
            <span aria-hidden="true">✅</span>
            {i18n.t('Seed phrase saved')}
          </div>
        {:else}
          <button
            onclick={() => (showCreateSeed = true)}
            class="w-full p-3 rounded-lg border bg-destructive/10 text-destructive border-destructive/30 hover:bg-destructive/20 transition-colors text-left flex items-center justify-between"
          >
            <span class="flex items-center gap-2 text-sm font-medium">
              <span aria-hidden="true">⚠️</span>
              {i18n.t('Create seed phrase')}
            </span>
            <span class="text-xs">{i18n.t('Required')}</span>
          </button>
        {/if}
      </div>
    </div>
  </div>
{/if}
