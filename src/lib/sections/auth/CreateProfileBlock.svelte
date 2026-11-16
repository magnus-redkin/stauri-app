<script lang="ts">
  import { i18n } from '$lib/i18n';
  import PasswordInput from '$lib/sections/auth/PasswordInput.svelte';
  import { checkNewPassword, passwordRules, PASSWORD_MIN_LENGTH } from '$lib/utils/password';
  import { info } from '$lib/utils/log';

  let {
    password = $bindable(''),
    onCreate
  }: {
    password: string;
    onCreate: () => void;
  } = $props();

  /**
   * Confirmation is entered here as well: the password encrypts the local database, so a
   * typo cannot be undone.
   *
   * @remarks A valid password has at least 8 characters, an uppercase and a lowercase Latin
   * letter, a digit and a symbol. A space is not a symbol, and Cyrillic satisfies neither
   * letter rule. The same rules are enforced at login, not only at creation.
   */
  let confirmation = $state('');
  /** The error is shown only after an attempt to create the profile. */
  let submitError = $state<string | null>(null);

  const rules = $derived(passwordRules(password));
  const valid = $derived(rules.every((r) => r.ok));

  // The rules appear as soon as typing starts: a hint up front beats a refusal after the
  // button is pressed.
  const showRules = $derived(password.length > 0);

  function submit() {
    info(`[boot] create submit: passwordLength=${password.length}`);
    const { error } = checkNewPassword(password, confirmation);
    submitError = error;
    if (!error) onCreate();
    else info(`[boot] create submit refused: ${error}`);
  }
</script>

<div class="w-full max-w-md space-y-3 p-4 border border-border rounded-lg bg-card">
  <h3 class="font-semibold text-foreground text-sm">{i18n.t('Create new profile')}</h3>

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

  {#if showRules}
    <ul class="text-xs space-y-1" aria-live="polite">
      {#each rules as rule (rule.id)}
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

  {#if submitError}
    <p class="text-destructive text-xs" aria-live="polite">{i18n.t(submitError)}</p>
  {/if}

  <button
    onclick={submit}
    disabled={!valid}
    class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50 disabled:cursor-not-allowed"
  >
    {i18n.t('Create Profile')}
  </button>
</div>
