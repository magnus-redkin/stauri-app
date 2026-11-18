<script lang="ts">
  import { onMount } from 'svelte';
  import { i18n } from '$lib/i18n';
  import PasswordInput from './PasswordInput.svelte';
  import { checkNewPassword, passwordRules, PASSWORD_MIN_LENGTH } from '$lib/utils/password';

  let firstWordInput: HTMLInputElement | undefined = $state();


  let {
    onBack,
    onRestore,
    onReset,
    onPassword,
  }: {
    onBack: () => void;
    /**
     * Opens the profile of the phrase, restoring it when it is not on this device.
     *
     * Rejects with a `LocalProfileLockedError` when the profile is here but the
     * password does not open it; that is what turns on the reset offer below.
     */
    onRestore?: (mnemonic: string, password: string) => Promise<void>;
    /**
     * Removes the local copy of the profile and restores it from the phrase.
     *
     * Only offered after [onRestore] reported a locked local profile, and only runs
     * after an explicit confirmation: the local data is gone for good.
     */
    onReset?: (mnemonic: string, password: string) => Promise<void>;
    /** Called with the password when the phrase is already valid: step 2. */
    onPassword?: (password: string) => void;
  } = $props();

  // Step 1 enters the words, step 2 enters the password.
  let step = $state(1);
  let words = $state(Array(12).fill(""));
  let password = $state("");
  /**
   * The password typed a second time.
   *
   * The password encrypts the local database, so a typo cannot be undone: the same
   * confirmation the profile-creation screen asks for is required here too. It was
   * missing, which is why this screen asked only once.
   */
  let confirmation = $state("");
  /** Set while the restore runs: the button is disabled and says so. */
  let busy = $state(false);
  let submitError = $state('');
  /**
   * Set when the profile is on this device but the password does not open it.
   *
   * Then the only way in is to drop the local copy and restore from the phrase, which
   * the screen offers only after this flag is set: deleting is not something to present
   * to someone whose password simply has a typo.
   */
  let locked = $state(false);
  /** Second press of the reset button: the deletion really happens. */
  let resetConfirmed = $state(false);

  onMount(() => {
    setTimeout(() => firstWordInput?.focus(), 50);
  });

  function handlePaste(e: ClipboardEvent) {
    const text = e.clipboardData?.getData('text') || '';
    const parts = text.trim().split(/\s+/);

    if (parts.length >= 12) {
      e.preventDefault();
      for (let i = 0; i < 12; i++) {
        words[i] = parts[i] || '';
      }
    }
  }

  /** Words as one string, lower case: status-go accepts any spacing. */
  function phrase(): string {
    return words.map((w) => w.trim().toLowerCase()).join(' ');
  }

  /**
   * Tells a locked local profile apart from an ordinary failure.
   *
   * The error type lives in the connection store, which the screen does not import —
   * matching the name keeps this component free of the backend wiring, and the name is
   * fixed in [LocalProfileLockedError]'s constructor.
   */
  function isLockedError(e: unknown): boolean {
    return e instanceof Error && e.name === 'LocalProfileLockedError';
  }

  /** Restores the profile; errors stay on screen instead of being swallowed. */
  async function submit(): Promise<void> {
    submitError = '';
    locked = false;
    resetConfirmed = false;
    if (!onRestore) {
      onPassword?.(password);
      return;
    }
    // Checked here as well as on the creation screen: the password encrypts the
    // restored database, so a mistyped one locks the profile behind a value the user
    // does not know. The mismatch is caught before anything reaches status-go.
    const { error } = checkNewPassword(password, confirmation);
    if (error) {
      submitError = i18n.t(error);
      return;
    }
    busy = true;
    try {
      await onRestore(phrase(), password);
    } catch (e) {
      // A profile that is here under another password is the one case with a way out,
      // so it gets its own offer instead of a red line nobody can act on.
      if (isLockedError(e)) {
        locked = true;
      } else {
        submitError = e instanceof Error ? e.message : String(e);
      }
    } finally {
      busy = false;
    }
  }

  /**
   * Removes the local copy and restores from the phrase.
   *
   * Runs only from the confirmation block: the deletion takes the local message
   * history and settings with it and cannot be undone.
   */
  async function resetProfile(): Promise<void> {
    submitError = '';
    if (!onReset) {
      submitError = i18n.t('Removing the local copy is not available');
      return;
    }
    busy = true;
    try {
      await onReset(phrase(), password);
    } catch (e) {
      submitError = e instanceof Error ? e.message : String(e);
      resetConfirmed = false;
    } finally {
      busy = false;
    }
  }

  function nextStep() {
    // Advance only when all twelve words are filled.
    if (words.every(w => w.trim().length > 0)) {
      step = 2;
    } else {
      alert(i18n.t('Please fill all 12 words.'));
    }
  }
</script>

<div class="flex flex-col items-center justify-center min-h-screen gap-6 p-4 bg-background">
  <button
    onclick={onBack}
    class="self-start text-sm text-muted-foreground hover:underline flex items-center gap-1"
  >
    ← {i18n.t('Back')}
  </button>

  {#if step === 1}
    <h1 class="text-3xl font-bold text-foreground">{i18n.t('Log in by Recovery Phrase')}</h1>
    <p class="text-sm text-muted-foreground">{i18n.t('Enter your 12 words in the correct order.')}</p>

    <div class="grid grid-cols-2 gap-2 w-full max-w-md">
      {#each words as _, i (i)}
        <div class="relative">
          <span class="absolute left-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">{i + 1}.</span>

    {#if i === 0}
      <input
        bind:this={firstWordInput}
        type="text"
        bind:value={words[i]}
        onpaste={handlePaste}
        class="w-full h-10 border border-input rounded-md pl-8 pr-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring bg-background"
        />
      {:else}
        <input
          type="text"
          bind:value={words[i]}
          class="w-full h-10 border border-input rounded-md pl-8 pr-2 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring bg-background"
          />
        {/if}
      </div>
    {/each}
  </div>

    <button
      onclick={nextStep}
      class="w-full max-w-md py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition mt-2"
    >
      {i18n.t('Continue')}
    </button>

  {:else}
    <!--
      Not "set a new password": status-go encrypts the local database with this value
      and cannot replace the password of a profile that is already here — that is
      refused with `envelope: invalid key-encryption key`. Saying "new" made the screen
      promise something the backend would not do.
    -->
    <h1 class="text-3xl font-bold text-foreground">{i18n.t('Password for this device')}</h1>
    <p class="text-sm text-muted-foreground text-center max-w-md">
      {i18n.t('It encrypts the local database. If this profile is already on this device, enter the password you used before.')}
    </p>

    <div class="w-full max-w-md mt-4 space-y-2">
      <PasswordInput
        bind:value={password}
        placeholder={i18n.t('New Password')}
        onEnter={submit}
        autofocus={true}
      />
      <PasswordInput
        bind:value={confirmation}
        placeholder={i18n.t('Confirm Password')}
        onEnter={submit}
      />
    </div>

    {#if password.length > 0}
      <!-- The rules appear as soon as typing starts: a hint up front beats a refusal
           after the button is pressed. Same rules as on profile creation. -->
      <ul class="text-xs space-y-1 w-full max-w-md" aria-live="polite">
        {#each passwordRules(password) as rule (rule.id)}
          <li class={rule.ok ? 'text-primary' : 'text-muted-foreground'}>
            {rule.ok ? '✓' : '•'}
            {rule.id === 'length'
              ? `${i18n.t('At least')} ${PASSWORD_MIN_LENGTH} ${i18n.t('characters')}`
              : rule.id === 'lower'
                ? i18n.t('Lowercase Latin letter')
                : rule.id === 'upper'
                  ? i18n.t('Uppercase Latin letter')
                  : rule.id === 'digit'
                    ? i18n.t('Digit')
                    : i18n.t('Symbol')}
          </li>
        {/each}
      </ul>
    {/if}

    {#if locked}
      <!--
        The phrase belongs to a profile already on this device, and the password above
        does not open it. The phrase cannot open an existing database either: it holds
        the wallet and chat keys, not the key that decrypts the local copy. Only a
        fresh local copy can be created, so what is offered is a deletion.
      -->
      <div
        class="w-full max-w-md rounded-md border border-warning/30 bg-warning/10 p-3 space-y-2"
        role="alert"
      >
        <p class="text-sm text-warning font-medium">
          {i18n.t('This profile is already on this device, under another password.')}
        </p>
        <p class="text-xs text-foreground">
          {i18n.t('The seed phrase cannot open this local copy. Removing it and restoring from the phrase gives the profile back with a new password.')}
        </p>
        <p class="text-xs text-foreground font-medium">
          {i18n.t('The local message history and settings will be lost. The wallet and the profile itself come back.')}
        </p>
        {#if onReset}
          {#if resetConfirmed}
            <div class="flex items-center gap-2 pt-1">
              <button
                onclick={resetProfile}
                disabled={busy}
                class="px-3 py-1.5 rounded-md bg-destructive text-destructive-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {busy ? i18n.t('Removing…') : i18n.t('Remove the local copy and restore')}
              </button>
              <button
                onclick={() => (resetConfirmed = false)}
                disabled={busy}
                class="text-sm text-muted-foreground hover:underline"
              >
                {i18n.t('Cancel')}
              </button>
            </div>
          {:else}
            <button
              onclick={() => (resetConfirmed = true)}
              class="px-3 py-1.5 rounded-md border border-destructive text-destructive text-sm font-medium hover:opacity-90"
            >
              {i18n.t('Remove the local copy…')}
            </button>
          {/if}
        {/if}
      </div>
    {/if}

    <button
      onclick={submit}
      disabled={busy || password.length === 0}
      class="w-full max-w-md py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
    >
      {busy ? i18n.t('Restoring…') : i18n.t('Restore and Log In')}
    </button>
    {#if submitError}
      <p class="text-xs text-destructive text-center max-w-md" aria-live="polite">{submitError}</p>
    {/if}

    <button
      onclick={() => step = 1}
      class="text-sm text-muted-foreground hover:underline"
    >
      ← {i18n.t('Back to words')}
    </button>
  {/if}

  <p class="text-xs text-muted-foreground text-center max-w-md mt-4">
    {i18n.t('The password protects only this device; the seed phrase restores the profile on any device.')}
  </p>
</div>
