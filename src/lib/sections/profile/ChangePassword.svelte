<script lang="ts">
  /**
   * Changes the profile password.
   *
   * @remarks
   * The old password is not asked for. The user is expected to remember the seed phrase,
   * not the string that encrypts this device's database, and the value is already in
   * memory: it was typed at login and is kept for the session (`sendState.password`).
   * status-go still needs it to unwrap the key before re-wrapping it, so it is passed
   * from there rather than typed again.
   *
   * When the session holds no password — the app was opened straight into a profile —
   * the field appears instead, so the change is never silently impossible.
   *
   * Only the encryption key is re-wrapped. The databases and the keystore are not
   * touched, so no restart is needed and the change takes effect immediately.
   */
  import { i18n } from '$lib/i18n';
  import PasswordInput from '$lib/sections/auth/PasswordInput.svelte';
  import { checkNewPassword, passwordRules, PASSWORD_MIN_LENGTH } from '$lib/utils/password';
  import { changePassword, changePasswordError } from '$lib/status/profile';
  import { getSessionPassword, setSessionPassword } from '$lib/stores/profileStore.svelte';
  import { rememberPassword } from '$lib/stores/sendStore.svelte';
  import * as Dialog from '$lib/components/ui/dialog/index.js';

  let {
    onChangePassword
  }: {
    /** Performs the change; rejects with a translation-ready message. */
    onChangePassword?: (current: string, next: string) => Promise<void>;
  } = $props();

  let open = $state(false);
  let current = $state('');
  let next = $state('');
  let confirmation = $state('');
  let busy = $state(false);
  let done = $state(false);
  let error = $state('');

  const rules = $derived(passwordRules(next));
  /**
   * The password typed at login, when this session has it.
   *
   * Read when the dialog opens rather than tracked reactively: the value is a module
   * variable precisely so it stays out of reactive graphs, and nothing needs to re-render
   * when it changes.
   */
  let sessionPassword = $state('');
  const needsCurrent = $derived(!sessionPassword);

  function reset() {
    current = '';
    next = '';
    confirmation = '';
    busy = false;
    done = false;
    error = '';
  }

  function openDialog() {
    reset();
    // Read at the moment the dialog opens: the session password is a module variable,
    // not reactive state, so it is fetched rather than tracked.
    sessionPassword = getSessionPassword();
    open = true;
  }

  async function submit() {
    error = '';
    const old = sessionPassword || current;
    if (!old) {
      error = i18n.t('Enter the current password');
      return;
    }
    const checked = checkNewPassword(next, confirmation);
    if (checked.error) {
      error = i18n.t(checked.error);
      return;
    }

    busy = true;
    try {
      await (onChangePassword ?? changePassword)(old, next);
      // The session keeps the password for signing transfers: leaving the old one
      // there would break the next send with a misleading "wrong password".
      rememberPassword(next);
      done = true;
      current = '';
      next = '';
      confirmation = '';
    } catch (e) {
      error = changePasswordError(e);
    } finally {
      busy = false;
    }
  }
</script>

<button
  onclick={openDialog}
  class="w-full p-3 rounded-lg border bg-secondary/40 border-border hover:bg-secondary transition-colors text-left flex items-center justify-between"
>
  <span class="flex items-center gap-2 text-sm font-medium">
    <span aria-hidden="true">🔑</span>
    {i18n.t('Create password')}
  </span>
  <span class="text-xs text-muted-foreground">{i18n.t('Change')}</span>
</button>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-[425px]">
    <Dialog.Header>
      <Dialog.Title>{i18n.t('Change password')}</Dialog.Title>
      <Dialog.Description>
        {i18n.t('The password encrypts the local database on this device. The seed phrase restores the profile anywhere.')}
      </Dialog.Description>
    </Dialog.Header>

    {#if done}
      <div class="p-3 rounded-lg border bg-success/10 text-success border-success/30 text-sm">
        ✅ {i18n.t('Password changed')}
      </div>
      <Dialog.Footer>
        <button
          onclick={() => (open = false)}
          class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium"
        >
          {i18n.t('Close')}
        </button>
      </Dialog.Footer>
    {:else}
      <div class="flex flex-col gap-3">
        <!--
          The current password is asked for only when the session has none. Normally it
          was typed at login and is still in memory; asking again would contradict the
          premise that the seed phrase, not the password, is what the user keeps.
        -->
        {#if needsCurrent}
          <div>
            <label class="text-sm font-medium" for="pw-current">
              {i18n.t('Current password')}
            </label>
            <PasswordInput bind:value={current} onEnter={submit} autofocus={true} />
          </div>
        {/if}
        <div>
          <label class="text-sm font-medium" for="pw-new">{i18n.t('New Password')}</label>
          <PasswordInput bind:value={next} onEnter={submit} autofocus={needsCurrent === false} />
        </div>
        <div>
          <label class="text-sm font-medium" for="pw-confirm">{i18n.t('Confirm Password')}</label>
          <PasswordInput bind:value={confirmation} onEnter={submit} />
        </div>

        {#if next.length > 0}
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

        {#if error}
          <p class="text-sm text-destructive" aria-live="polite">{error}</p>
        {/if}
      </div>

      <Dialog.Footer>
        <button
          onclick={submit}
          disabled={busy || !current || !next || !confirmation}
          class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {busy ? i18n.t('Saving…') : i18n.t('Save password')}
        </button>
      </Dialog.Footer>
    {/if}
  </Dialog.Content>
</Dialog.Root>
