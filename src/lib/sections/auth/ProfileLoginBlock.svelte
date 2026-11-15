<script lang="ts">
  import { i18n } from '$lib/i18n';
  import PasswordInput from './PasswordInput.svelte';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import { checkPassword } from '$lib/utils/password';

  let {
    selectedAccountKeyUid = $bindable(''),
    password = $bindable(''),
    onLogin
  }: {
    selectedAccountKeyUid: string;
    password: string;
    onLogin: () => void;
  } = $props();

  /**
   * Password rule error for the login form.
   *
   * The `LoginAccount` failure (a wrong password) is not shown here — the screen above
   * displays it.
   *
   * The rejected password is stored together with its message and the message is shown only
   * while the field still holds that password: editing the field clears the hint immediately,
   * without an `$effect` that would also hide a hint in the same tick it appeared.
   *
   * @remarks Login enforces the same rules as profile creation: a password needs at least 8
   * characters, an uppercase and a lowercase Latin letter, a digit and a symbol (a space is
   * not a symbol, Cyrillic does not count). Profiles with a weaker password therefore stop
   * opening; that is deliberate.
   */
  let failed = $state<{ password: string; error: string } | null>(null);
  const submitError = $derived(failed && failed.password === password ? failed.error : null);

  function submit() {
    const { error } = checkPassword(password);
    failed = error ? { password, error } : null;
    if (!error) onLogin();
  }
</script>

<div class="w-full max-w-md space-y-3 p-4 border border-border rounded-lg bg-card">
  <select
    bind:value={selectedAccountKeyUid}
    class="w-full px-3 py-2 border border-input rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
  >
    {#each statusState.accounts as account (account["key-uid"])}
      <option value={account["key-uid"]}>{account["key-uid"].slice(0, 16)}...</option>
    {/each}
  </select>

  <PasswordInput
    bind:value={password}
    placeholder={i18n.t('Password')}
    onEnter={submit}
    autofocus={true}
  />

  {#if submitError}
    <p class="text-destructive text-xs" aria-live="polite">{i18n.t(submitError)}</p>
  {/if}

  <button
    onclick={submit}
    class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition"
  >
    {i18n.t('Log In')}
  </button>
</div>
