<script lang="ts">
  /**
   * Правая панель раздела «Чат» по умолчанию (и по лупе из левой панели).
   *
   * Плоский список контактов и каналов в одном месте. Ищем по всем контактам,
   * включая не принятые и отклонённые: такие показываем с красным крестиком.
   * Человечек справа — у контакта; у канала его нет.
   */
  import { onMount } from 'svelte';
  import { i18n } from '$lib/i18n';
  import { chatsState, selectChat, setRightPanel } from '$lib/stores/chatsStore.svelte';
  import { contactsState, loadContacts, selectContact } from '$lib/stores/contactsStore.svelte';
  import { getDisplayName } from '$lib/utils/user';
  import { isMutual, LOCAL_DISMISSED } from '$lib/status/contactState';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';

  let query = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);

  const q = $derived(query.trim().toLowerCase());

  type Row =
    | { kind: 'contact'; key: string; name: string; sub: string; contact: any; accepted: boolean }
    | { kind: 'channel'; key: string; name: string; sub: string; chatId: string };

  // Все контакты и каналы — один плоский список, отсортированный по имени.
  const rows = $derived.by<Row[]>(() => {
    const contacts: Row[] = contactsState.items.map((c: any) => ({
      kind: 'contact',
      key: `c:${c.id}`,
      name: getDisplayName(c),
      sub: String(c.id ?? '').substring(0, 10) + '...',
      contact: c,
      accepted: isMutual(c),
    }));
    const channels: Row[] = chatsState.items
      .filter((c) => c.type !== 'direct')
      .map((c) => ({
        kind: 'channel',
        key: `h:${c.id}`,
        name: c.name || c.id.slice(0, 8),
        sub: c.communityName ?? '',
        chatId: c.id,
      }));
    return [...contacts, ...channels].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
  });

  const matched = $derived(
    rows.filter((r) => {
      if (!q) return true;
      if (r.name.toLowerCase().includes(q)) return true;
      return r.kind === 'contact' && String(r.contact.id ?? '').toLowerCase().includes(q);
    })
  );

  /** Крестик — не принятый или отклонённый контакт. */
  function isRejected(contact: any): boolean {
    return !isMutual(contact) || contact.contactRequestLocalState === LOCAL_DISMISSED;
  }

  onMount(() => {
    loadContacts();
    queueMicrotask(() => inputEl?.focus());
  });

  function openRow(row: Row) {
    if (row.kind === 'channel') {
      setRightPanel('chat');
      selectChat(row.chatId);
      return;
    }
    selectContact(row.contact);
  }
</script>

<div class="h-full flex flex-col bg-card">
  <div class="p-3 border-b border-border">
    <input
      bind:this={inputEl}
      bind:value={query}
      type="search"
      placeholder={i18n.t('Search contacts and channels')}
      aria-label={i18n.t('Search contacts and channels')}
      class="w-full h-10 border border-input rounded-md px-3 text-sm bg-background"
    />
  </div>

  <ScrollArea class="flex-1 min-h-0">
    {#if contactsState.isLoading}
      <p class="px-4 py-2 text-muted-foreground text-sm">{i18n.t('Loading contacts...')}</p>
    {:else if matched.length === 0}
      <p class="px-4 py-2 text-muted-foreground text-sm italic">{i18n.t('No contacts found')}</p>
    {:else}
      <div class="p-2 space-y-1">
        {#each matched as row (row.key)}
   <button
     type="button"
     onclick={() => openRow(row)}
     class="w-full text-left p-3 rounded-md hover:bg-secondary transition-colors flex items-center gap-2"
          >
     <div class="min-w-0 flex-1">
       <div class="font-medium truncate">{row.name}</div>
{#if row.sub}
         <div class="text-xs text-muted-foreground font-mono truncate">{row.sub}</div>
{/if}
     </div>
     {#if row.kind === 'contact'}
       {#if isRejected(row.contact)}
         <span class="shrink-0 text-red-600 font-bold" aria-label={i18n.t('Not accepted')} title={i18n.t('Not accepted')}>✕</span>
       {/if}
       <span class="shrink-0 text-muted-foreground" aria-label={i18n.t('Contact')} title={i18n.t('Contact')}>👤</span>
     {/if}
          </button>
        {/each}
      </div>
    {/if}
  </ScrollArea>
</div>
