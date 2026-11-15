<script lang="ts">
  /**
   * Right panel for entering a foreign invite: a channel, a community or a contact.
   *
   * The link is parsed by `joinByInput`; this panel only holds the input field and
   * reports the outcome.
   */
  import { i18n } from '$lib/i18n';
  import { chatsState, joinByInput, setRightPanel } from '$lib/stores/chatsStore.svelte';

  let value = $state('');
  let message = $state<{ kind: 'ok' | 'pending' | 'error'; text: string } | null>(null);

  async function submit() {
    if (!value.trim() || chatsState.isJoining) return;
    message = null;
    const result = await joinByInput(value);
    if (result.status === 'joined') {
      message = { kind: 'ok', text: i18n.t('Joined') + ': ' + result.name };
      value = '';
    } else if (result.status === 'requested') {
      message = { kind: 'pending', text: i18n.t('Request sent') + ': ' + result.name };
      value = '';
    } else if (result.status === 'spectated') {
      // The channel opens by itself: go to the conversation.
      value = '';
      setRightPanel('chat');
    } else if (result.status === 'contact') {
      // The request is sent: the rest happens in contacts (the request row and
      // Accept), not in this form. Contact search opens on the right.
      value = '';
      setRightPanel('contacts');
    } else {
      message = { kind: 'error', text: result.error };
    }
  }
</script>

<div class="flex-1 flex flex-col items-center justify-center p-6 gap-4">
  <h2 class="text-lg font-semibold text-foreground">{i18n.t('Join by invite')}</h2>
  <p class="text-xs text-muted-foreground text-center max-w-md">
    {i18n.t('Paste an invite link: a channel (status.app/cc/…) or a contact (status.app/u/…).')}
  </p>

  <div class="w-full max-w-xl flex flex-col gap-2">
    <textarea
      bind:value
      rows="3"
      placeholder="status.app/cc/…"
      class="w-full border border-input rounded-md px-3 py-2 text-sm bg-background font-mono"
      aria-label={i18n.t('Invite link')}
    ></textarea>
    <button
      onclick={submit}
      disabled={chatsState.isJoining || !value.trim()}
      class="h-9 rounded-md bg-primary text-primary-foreground text-sm disabled:opacity-50"
    >
      {chatsState.isJoining ? i18n.t('Connecting...') : i18n.t('Connect')}
    </button>
  </div>

  {#if message}
    <div
      class="w-full max-w-xl px-3 py-2 text-sm rounded-md {message.kind === 'error'
        ? 'bg-destructive/10 text-destructive'
 : message.kind === 'pending'
          ? 'bg-orange-100 text-orange-700'
   : 'bg-secondary text-foreground'}"
    >
      {message.text}
    </div>
  {/if}
</div>
