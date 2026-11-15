<script lang="ts">
  /**
   * Default right panel of the Chat section, also opened by the magnifier in the
   * left panel.
   *
   * A single flat list of contacts and channels. Search covers all contacts,
   * including unaccepted and rejected ones, which are marked with a red cross. The
   * person icon appears on contacts only.
   */
  import { onMount } from 'svelte';
  import { i18n } from '$lib/i18n';
  import {
    chatsState,
    selectChat,
    setRightPanel,
    acceptIncomingAndOpen,
    rejectRequest,
    loadChats,
  } from '$lib/stores/chatsStore.svelte';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import { isIncomingRequest } from '$lib/status/contactState';
  import { contactsState, loadContacts, selectContact } from '$lib/stores/contactsStore.svelte';
  import { getDisplayName } from '$lib/utils/user';
  import { isMutual, LOCAL_DISMISSED } from '$lib/status/contactState';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';

  let query = $state('');
  let inputEl = $state<HTMLInputElement | null>(null);

  /**
   * Whether the layout is narrow.
   *
   * A wide screen already shows accepted contacts on the left, so the right panel
   * keeps only the search field. A narrow screen (desktop ≤ 768px and Android) has a
   * single panel, so the list appears below the field.
   */
  let narrow = $state(false);
  $effect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => (narrow = mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });

  /** Incoming requests not yet accepted, shown as the first rows of the list. */
  const incoming = $derived(contactsState.items.filter((c: any) => isIncomingRequest(c)));

  const q = $derived(query.trim().toLowerCase());

  type Row =
    | { kind: 'contact'; key: string; name: string; sub: string; contact: any; accepted: boolean }
    | { kind: 'channel'; key: string; name: string; sub: string; chatId: string };

  // All contacts and channels as one flat list, sorted by name.
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

  /**
   * Rows to show for the current query.
   *
   * Without a query only accepted contacts and channels are listed: that is the
   * main list (on the left on desktop, below the search field on mobile). Rejected
   * and unaccepted contacts appear only in search results, looked up by name or key.
   */
  const matched = $derived.by<Row[]>(() => {
    const matches = (r: Row) => {
      if (r.name.toLowerCase().includes(q)) return true;
      return r.kind === 'contact' && String(r.contact.id ?? '').toLowerCase().includes(q);
    };
    if (!q) {
      return rows.filter((r) => r.kind === 'channel' || !isRejected(r.contact));
    }
    return rows.filter(matches);
  });

  /**
   * Whether the contact should be marked as not accepted (red cross).
   *
   * @remarks
   * `mutual` from status-go is more reliable than comparing the two request-state
   * fields: after accepting, the local state becomes `Sent` while the remote one
   * stays `Received`, and `isMutual` still answers correctly on that pair, but only
   * while the snapshot is fresh. A dismissed request is `Dismissed`.
   */
  function isRejected(contact: any): boolean {
    if (contact.contactRequestLocalState === LOCAL_DISMISSED) return true;
    if (typeof contact.mutual === 'boolean') return !contact.mutual;
    return !isMutual(contact);
  }

  onMount(() => {
    // force: request state changes on Accept and on incoming signals. Without a
    // reload an accepted contact keeps the red cross from a previous snapshot.
    loadContacts(true);
    queueMicrotask(() => inputEl?.focus());
  });

  function openRow(row: Row) {
    if (row.kind === 'channel') {
      setRightPanel('chat');
      selectChat(row.chatId);
      return;
    }
    // A contact maps to its chat, which carries the same id. If the chat is not in
    // the list yet, reload the list first.
    const id = row.contact.id as string;
    const open = () => {
      setRightPanel('chat');
      selectChat(id);
    };
    if (chatsState.items.some((c) => c.id === id)) open();
    else loadChats(true).then(open);
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

  {#if narrow}
  <ScrollArea class="flex-1 min-h-0">
    {#each incoming as c (c.id)}
      <div class="mx-2 mt-2 p-3 rounded-md border border-orange-300 bg-orange-50 flex items-center gap-2">
        <div class="min-w-0 flex-1">
          <div class="font-medium truncate">{getDisplayName(c)}</div>
          <div class="text-xs text-orange-700">{i18n.t('Contact request')}</div>
        </div>
        <button
          type="button"
          onclick={() => acceptIncomingAndOpen(c.id)}
          class="shrink-0 h-9 px-3 rounded-md bg-primary text-primary-foreground text-sm"
        >{i18n.t('Accept')}</button>
        <button
          type="button"
          onclick={() => statusState.backendPort && rejectRequest({ id: c.id } as any, statusState.backendPort, c.id)}
          class="shrink-0 h-9 px-3 rounded-md border border-border text-sm"
        >{i18n.t('Reject')}</button>
      </div>
    {/each}

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
  {/if}
</div>
