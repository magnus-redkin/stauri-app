<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { createAndOpenChannel } from '$lib/stores/chatsStore.svelte';

  /** Закрыть форму после успешного создания. */
  let { onDone, panel = false }: { onDone?: () => void; panel?: boolean } = $props();

  let name = $state('');
  let description = $state('');
  let kind = $state<'news' | 'request' | 'issues'>('news');
  let isSaving = $state(false);
  let error = $state('');

  async function submit() {
    if (isSaving) return;
    isSaving = true;
    error = '';
    const res = await createAndOpenChannel({ name, description, kind });
    isSaving = false;
    if (!res.ok) {
      error = res.error || i18n.t('Failed to create channel');
      return;
    }
    name = '';
    description = '';
    onDone?.();
  }
</script>

<form
  class="{panel ? 'p-6 space-y-3 w-full max-w-xl' : 'p-3 space-y-2 border-b border-border bg-secondary/40'}"
  onsubmit={(e) => { e.preventDefault(); submit(); }}
>
  <input
    bind:value={name}
    placeholder={i18n.t('Channel name')}
    aria-label={i18n.t('Channel name')}
    class="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"
  />
  <textarea
    bind:value={description}
    rows={panel ? 6 : 2}
    placeholder={i18n.t('Description (up to 140 bytes)')}
    aria-label={i18n.t('Description (up to 140 bytes)')}
    class="w-full border border-input rounded-md px-3 py-2 text-sm bg-background"
  ></textarea>
  <select
    bind:value={kind}
    aria-label={i18n.t('Who can join')}
    class="w-full h-9 border border-input rounded-md px-2 text-sm bg-background"
  >
    <option value="news">{i18n.t('News: anyone joins, only author posts')}</option>
    <option value="request">{i18n.t('By request: only author posts')}</option>
    <option value="issues">{i18n.t('Issues: by request, everyone posts')}</option>
  </select>

  {#if error}
    <p class="text-xs text-destructive">{error}</p>
  {/if}

  <div class="flex gap-2">
    <button
      type="submit"
      disabled={isSaving}
      class="flex-1 h-8 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
    >
      {isSaving ? i18n.t('Creating...') : i18n.t('Create channel')}
    </button>
    <button
      type="button"
      onclick={() => onDone?.()}
      class="h-8 px-3 rounded-md border border-border text-xs"
    >
      {i18n.t('Cancel')}
    </button>
  </div>
</form>
