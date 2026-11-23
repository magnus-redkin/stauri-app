<script lang="ts">
  import { onMount } from 'svelte';
  import { i18n } from '$lib/i18n';
  import PasswordInput from './PasswordInput.svelte';
  import { checkNewPassword, passwordRules, PASSWORD_MIN_LENGTH } from '$lib/utils/password';
  import { pinCreationProblem } from '$lib/entry/entryFlow';

  let firstWordInput: HTMLInputElement | undefined = $state();


  let {
    onBack,
    onRestore,
    onReset,
    onCheckLocal,
    pinRules,
    onPassword,
  }: {
    onBack: () => void;
    /**
     * Opens the profile of the phrase, restoring it when it is not on this device.
     *
     * Rejects with a `LocalProfileLockedError` when the profile is here but the
     * password does not open it; the screen then switches to the "new local copy"
     * choice on its own, so the user is never left on a password field that cannot work.
     */
    onRestore?: (mnemonic: string, password: string) => Promise<void>;
    /**
     * Removes the local copy of the profile and restores it from the phrase.
     *
     * Offered as an explicit choice, not only after a refusal: a user who no longer
     * remembers the old password must be able to say so up front instead of guessing
     * until the screen gives up on them.
     */
    onReset?: (mnemonic: string, password: string) => Promise<void>;
    /**
     * Whether the phrase belongs to a profile this device already holds.
     *
     * Decides which choice to show after the words: an existing profile can only be
     * opened with its own password, so both paths are offered; a profile that is not
     * here has no old password to ask for.
     */
    onCheckLocal?: (mnemonic: string) => Promise<boolean>;
    /**
     * Platform rule set for the value being created.
     *
     * @remarks
     * The typed value is the profile's PIN on both platforms; only the policy differs —
     * digits on a phone, four classes on a desktop. Without this the phone would be held
     * to the desktop rules, the envelope would be refused by Rust, and the password would
     * be asked for on every start.
     */
    pinRules?: {
      creation_min: number;
      max_length: number;
      digits_only: boolean;
      require_classes: boolean;
    };
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
   * Which way into the profile the user picked.
   *
   * @remarks
   * `existing` enters the password the profile was created with. `new` drops the local
   * copy and restores from the phrase with a fresh password. The choice exists so a
   * forgotten password is a path, not a dead end: before it, the screen only offered the
   * reset after a failed attempt, so a user who knew they had forgotten sat guessing.
   */
  let mode = $state<'existing' | 'new'>('existing');
  /**
   * Whether the phrase belongs to a profile this device already holds.
   *
   * `null` while the check runs and when the check is unavailable; the choice is shown
   * only when the answer is known and positive.
   */
  let localExists = $state<boolean | null>(null);
  /**
   * Whether this password is a new one and has to satisfy the current rules.
   *
   * @remarks
   * An existing profile keeps whatever password it was created with: rules added later
   * must not lock a user out of their own profile. They apply only where a new local
   * database is encrypted — creating a new copy, or when it is unknown whether the
   * profile is here (the old behaviour, kept as the safe default).
   */
  const needsNewPassword = $derived(mode === 'new' || localExists === null);

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

  /**
   * What is wrong with the value being created, as an i18n key; `null` when fine.
   *
   * @remarks
   * Two policies, one code path: on a phone the PIN is digits, on a desktop a passphrase.
   * The confirmation is required in both cases — the value encrypts the local copy, and a
   * typo cannot be undone.
   */
  function newValueProblem(): string | null {
    if (pinRules) {
      const problem = pinCreationProblem(password, pinRules);
      if (problem) return problem;
      return password === confirmation ? null : 'Passwords do not match';
    }
    return checkNewPassword(password, confirmation).error;
  }

  /** Restores the profile; errors stay on screen instead of being swallowed. */
  async function submit(): Promise<void> {
    submitError = '';
    if (!onRestore) {
      onPassword?.(password);
      return;
    }
    // Rules apply to a new local database only. An existing profile keeps the password
    // it was created with, and rules added later must not refuse it — the point of this
    // path is to open the profile, not to re-certify its old password.
    if (needsNewPassword) {
      const problem = newValueProblem();
      if (problem) {
        submitError = i18n.t(problem);
        return;
      }
    } else if (password.length === 0) {
      submitError = i18n.t('Password is required');
      return;
    }
    busy = true;
    try {
      await onRestore(phrase(), password);
    } catch (e) {
      // A profile that is here under another password is the one case with a way out.
      // Switching to the "new local copy" choice turns a refusal into a next step
      // instead of a red line nobody can act on — and the screen is never left on a
      // password field that is certain not to work.
      if (isLockedError(e)) {
        localExists = true;
        mode = 'new';
        // Said in words as well as shown by the switch: the screen used to fall silent
        // here, and "nothing happened" is the one answer a password field must not give.
        submitError = i18n.t('Wrong password');
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
   * Runs only from the "new local copy" choice: the deletion takes the local message
   * history and settings with it and cannot be undone. The choice itself is the first
   * confirmation, the explicit button is the second.
   */
  async function resetProfile(): Promise<void> {
    submitError = '';
    if (!onReset) {
      submitError = i18n.t('Removing the local copy is not available');
      return;
    }
    const problem = newValueProblem();
    if (problem) {
      submitError = i18n.t(problem);
      return;
    }
    busy = true;
    try {
      await onReset(phrase(), password);
    } catch (e) {
      submitError = e instanceof Error ? e.message : String(e);
    } finally {
      busy = false;
    }
  }

  /**
   * Moves to the password step, learning first whether the profile is already here.
   *
   * @remarks
   * The answer decides what the step offers. Waiting for the check keeps the two paths
   * honest: an existing profile gets "enter its password" and "create a new local copy",
   * while a profile that is not here is simply given a password — asking for an old one
   * there would be a question with no answer.
   */
  async function nextStep(): Promise<void> {
    // Advance only when all twelve words are filled.
    if (!words.every((w) => w.trim().length > 0)) {
      alert(i18n.t('Please fill all 12 words.'));
      return;
    }
    const allWords = phrase();
    if (onCheckLocal) {
      try {
        localExists = await onCheckLocal(allWords);
      } catch {
        // The check is an optimization, not a gate: the restore path reports a locked
        // profile itself, and the screen switches to the choice then.
        localExists = null;
      }
    }
    mode = localExists === false ? 'new' : 'existing';
    step = 2;
  }
</script>

<div class="flex flex-col items-center justify-center min-h-screen gap-6 p-4 bg-background">
  <button
    onclick={() => {
      // The twelve words are the profile, in clear, in a component's state. Leaving the
      // screen is the moment to drop them: the component unmounts a moment later, but the
      // array would otherwise survive until then — and no screen needs it after this.
      words = Array(12).fill('');
      onBack();
    }}
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
    <h1 class="text-3xl font-bold text-foreground">{i18n.t('Password for this device')}</h1>

    {#if localExists}
      <!--
        Two ways in, offered before the user has to guess: the old password opens the
        profile as it is, a new one rebuilds the local copy from the phrase. Before this,
        the reset was only offered after a failed attempt — a user who knew they had
        forgotten sat retyping instead.
      -->
      <div class="w-full max-w-md grid grid-cols-2 gap-1 p-1 rounded-md bg-secondary" role="tablist">
        <button
          role="tab"
          aria-selected={mode === 'existing'}
          onclick={() => { mode = 'existing'; submitError = ''; }}
          class="py-1.5 rounded text-xs font-medium transition-colors {mode === 'existing'
            ? 'bg-card text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'}"
        >
          {i18n.t('Existing profile')}
        </button>
        <button
          role="tab"
          aria-selected={mode === 'new'}
          onclick={() => { mode = 'new'; submitError = ''; }}
          class="py-1.5 rounded text-xs font-medium transition-colors {mode === 'new'
            ? 'bg-card text-foreground shadow-sm'
            : 'text-muted-foreground hover:text-foreground'}"
        >
          {i18n.t('New local copy')}
        </button>
      </div>
    {/if}

    <p class="text-sm text-muted-foreground text-center max-w-md">
      {#if localExists && mode === 'existing'}
        {i18n.t('Enter the password you used when this profile was created on this device.')}
      {:else if localExists && mode === 'new'}
        {i18n.t('The phrase rebuilds the profile with a new password. The local message history and settings are lost; the wallet and the profile itself come back.')}
      {:else}
        {i18n.t('The phrase rebuilds the local copy on this device. The password you set now encrypts it — you can reuse the one you had before, if it meets the rules below.')}
      {/if}
    </p>

    <div class="w-full max-w-md mt-4 space-y-2">
      <PasswordInput
        bind:value={password}
        placeholder={needsNewPassword
          ? pinRules?.digits_only
            ? i18n.t('PIN')
            : i18n.t('New Password')
          : i18n.t('Password')}
        onEnter={submit}
        autofocus={true}
      />
      {#if needsNewPassword}
        <!-- A new password encrypts a new database, so a typo cannot be undone: the
             second field is what catches it. An existing password is typed once. -->
        <PasswordInput
          bind:value={confirmation}
          placeholder={i18n.t('Confirm Password')}
          onEnter={submit}
        />
      {/if}
    </div>

    {#if needsNewPassword && password.length > 0 && !pinRules?.digits_only}
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

    {#if localExists && mode === 'new'}
      <!--
        The phrase belongs to a profile already on this device. It cannot open the
        existing database — it holds the wallet and chat keys, not the key that decrypts
        the local copy — so this path rebuilds the copy, and says what that costs.
      -->
      <div
        class="w-full max-w-md rounded-md border border-warning/30 bg-warning/10 p-3 space-y-2"
        role="alert"
      >
        <p class="text-sm text-warning font-medium">
          {i18n.t('This profile is already on this device, under another password.')}
        </p>
        <p class="text-xs text-foreground">
          {i18n.t('The local message history and settings will be lost. The wallet and the profile itself come back.')}
        </p>
      </div>
    {/if}

    {#if mode === 'new'}
      <button
        onclick={resetProfile}
        disabled={busy || password.length === 0}
        class="w-full max-w-md py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy
          ? i18n.t('Restoring…')
          : localExists
            ? i18n.t('Remove the local copy and open')
            : i18n.t('Create the local copy and open')}
      </button>
    {:else}
      <button
        onclick={submit}
        disabled={busy || password.length === 0}
        class="w-full max-w-md py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition mt-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {busy ? i18n.t('Opening…') : i18n.t('Open the profile')}
      </button>
    {/if}
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
