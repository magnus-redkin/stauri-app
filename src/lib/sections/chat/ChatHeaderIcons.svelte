<script lang="ts">
  /**
   * Иконки раздела «Чат» в титульной строке мобильного режима.
   *
   * Те же четыре действия, что и в левой панели десктопа: приглашение, вступление
   * по приглашению, новый канал и лупа (поиск контактов и каналов).
   */
  import { i18n } from '$lib/i18n';
  import { setRightPanel } from '$lib/stores/chatsStore.svelte';

  const icons = [
    { mode: 'contactInvite', label: 'Invite a contact', path: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M19 8v6M22 11h-6' },
    { mode: 'joinInvite', label: 'Join by invite', path: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z' },
    { mode: 'newChannel', label: '+ New channel', path: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z' },
    { mode: 'contacts', label: 'Search contacts and channels', path: 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14M21 21l-4.3-4.3' },
  ] as const;
</script>

<div class="flex items-center gap-1">
  {#each icons as icon (icon.mode)}
    <button
      type="button"
      onclick={() => setRightPanel(icon.mode)}
      class="h-10 w-10 rounded-md bg-card flex items-center justify-center"
      title={i18n.t(icon.label)}
      aria-label={i18n.t(icon.label)}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d={icon.path} />
      </svg>
    </button>
  {/each}
</div>
