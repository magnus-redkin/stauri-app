<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import { chatsState, setSelectedChat, removeChat, setRightPanel } from '$lib/stores/chatsStore.svelte';
  import { removeFeed, feedChatItems } from '$lib/stores/feedsStore.svelte';

  let { onSelectChat, compact = false }: { onSelectChat?: (chat: ChatItem) => void; compact?: boolean } = $props();


  export type ChatItem = {
    id: string;
    name: string;
    lastMessage: string;
    /**
     * `direct` — a one-to-one conversation, `community` — a channel inside a
     * community, `external` — a provider source (see docs/ru/providers_and_dapps.md).
     *
     * `channel` — a public status-go channel, kept only for chats that already
     * exist. The UI cannot create new ones: such a channel has no owner, cannot be
     * closed, renamed or found through a catalogue, and in the AKK model it does
     * not express "a channel with an author".
     */
    type: 'direct' | 'channel' | 'community' | 'external';
    isPendingRequest?: boolean;
    /** Last activity time in ms, used to sort the list by date. */
    sortTs?: number;
    unreadCount?: number;
    /**
     * For community channels: the community and category they belong to.
     *
     * `name` holds only the channel name (`general`); the community title is kept
     * separately in `communityName`.
     */
    communityId?: string;
    communityName?: string;
    categoryId?: string;
    /** Whether posting is allowed. A channel without posting rights shows no input. */
    canPost?: boolean;
    /** AKK channel kind (news / request / issues); see channelKind.ts. */
    kind?: 'news' | 'request' | 'issues';
    /** External source: whose item this is and where it came from. */
    source?: string;
    sourceUrl?: string;
  };

  /** Chats by activity date, newest first. A copy, so the store is not mutated. */
  const filteredItems = $derived(
    [...chatsState.items].sort((a, b) => (b.sortTs ?? 0) - (a.sortTs ?? 0))
  );

  /**
   * Subscriptions to external feeds, shaped as chat list rows.
   *
   * They live apart from `chatsState.items` because they come from
   * `localStorage`, not from status-go. They are merged here rather than in
   * `chatsStore`, which answers for what the backend returned. Newest first, so a
   * freshly added feed is visible right away instead of at the end of the list.
   */
  const feedItems = $derived.by(() => {
    // Row shape is built by `feedsStore`, which is also needed by `selectChat`
    // when a feed is opened by id from another section.
    const items: ChatItem[] = feedChatItems();

    return items;
  });

  /**
   * List rows: subscriptions on top, then chats.
   *
   * @remarks
   * The order is fixed here, not by the source (docs §9.3): subscriptions form a
   * separate block that a community channel cannot push aside.
   */
  const allItems = $derived([...feedItems, ...filteredItems]);

  /**
   * A flat list without community headings.
   *
   * In the AKK model the user sees channels, not communities: each channel is a
   * separate technical community, so its name is not shown in the list.
   */
  const groupedItems = $derived(allItems.map((item) => ({ kind: 'item' as const, item })));
  function select(item: ChatItem) {
    setSelectedChat(item);
    onSelectChat?.(item);
  }

  /** Row awaiting removal confirmation. Removal is irreversible for history. */
  let confirmRemove = $state<ChatItem | null>(null);

  async function doRemove() {
    const item = confirmRemove;
    if (!item) return;
    confirmRemove = null;

    // An external subscription lives here, not in the backend: `removeChat` would
    // send `deactivateChat` with an unknown id and remove nothing.
    if (item.type === 'external') {
      if (item.sourceUrl) removeFeed(item.sourceUrl);
      if (chatsState.selected?.id === item.id) setSelectedChat(null);
      return;
    }

    const res = await removeChat(item);
    if (!res.ok) {
      console.warn(`[chat] remove failed: ${res.error || 'unknown'}`);
    }
  }

</script>

<div class="flex flex-col h-full border-r border-border bg-card">
  {#if !compact}
  <div class="p-3 border-b border-border">
    <div class="flex items-center justify-between gap-1">
      <span class="font-bold text-lg text-primary px-1">{i18n.t('Chat')}</span>
      <div class="flex items-center gap-1">
        <button
   onclick={() => setRightPanel('contacts')}
          class="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
   title={i18n.t('Search contacts and channels')}
   aria-label={i18n.t('Search contacts and channels')}
 >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
 </button>
        <button
   onclick={() => setRightPanel('contactInvite')}
   class="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
   title={i18n.t('Invite a contact')}
   aria-label={i18n.t('Invite a contact')}
 >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1"/><path d="M19 8v6M16 11h6"/></svg>
 </button>
        <button
          onclick={() => setRightPanel('joinInvite')}
   class="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
          title={i18n.t('Join by invite')}
          aria-label={i18n.t('Join by invite')}
        >
   <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        </button>
        <button
   onclick={() => setRightPanel('newChannel')}
          class="h-8 w-8 rounded-md hover:bg-secondary flex items-center justify-center"
   title={i18n.t('+ New channel')}
   aria-label={i18n.t('+ New channel')}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
 </button>
      </div>
    </div>

  </div>
  {/if}

  <!--
    `min-h-0` is required: inside a flex container a child defaults to
    `min-height: auto` and cannot shrink below its content. Without it the channel
    list stretched the panel and never scrolled; all scrolling went outside the
    window.
  -->
  <ScrollArea class="flex-1 min-h-0">
    {#if chatsState.isLoading}
      <p class="p-4 text-muted-foreground text-sm">{i18n.t('Loading chats...')}</p>
    {:else if filteredItems.length === 0}
      <p class="p-4 text-muted-foreground text-sm italic">{i18n.t('No chats yet')}</p>
    {:else}
      <div class="p-2 space-y-1">
        {#each groupedItems as entry (entry.item.id)}
     {@const item = entry.item}
            <div class="group/row relative">
              <button
                onclick={() => select(item)}
                class="w-full text-left p-3 pr-8 rounded-md hover:bg-secondary transition-colors {chatsState.selected?.id === item.id ? 'bg-secondary' : ''}"
              >
                <div class="flex items-center gap-2">
                  {#if item.isPendingRequest}
                    <div class="w-8 h-8 rounded-full bg-warning/10 text-warning flex items-center justify-center font-bold text-lg">!</div>
                  {:else if item.type === 'channel'}
                    <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold">#</div>
                  {:else if item.type === 'community'}
                    <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold">◇</div>
                  {:else if item.type === 'external'}
                    <div class="w-8 h-8 rounded-full bg-secondary flex items-center justify-center text-muted-foreground">📡</div>
                  {:else}
                    <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold">
                      {item.name ? item.name.substring(0, 1).toUpperCase() : '?'}
                    </div>
                  {/if}
                  <div class="flex-1 min-w-0">
                    <div class="flex items-center gap-2">
                      <span class="font-medium text-foreground truncate">{item.name || item.id.slice(0, 8)}</span>
                      {#if (item.unreadCount ?? 0) > 0}
                        <span class="ml-auto shrink-0 text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5">
                          {item.unreadCount}
                        </span>
                      {/if}
                    </div>
                    <div class="text-xs text-muted-foreground truncate">{item.lastMessage || ''}</div>
                    {#if item.type === 'external' && item.source}
                      <!--
                        An external item always shows its origin; per
                        docs/ru/providers_and_dapps.md §9.2 it is part of the row,
                        not an optional badge.
                      -->
                      <div class="text-[0.625rem] text-muted-foreground/70 truncate">↗ {item.source}</div>
                    {/if}
                  </div>
                </div>
              </button>

              <!--
                Remove from list. Shown on hover, but on touch screens, where
                hover does not exist, it must stay visible when the primary input
                is touch.
              -->
              <button
                onclick={(e) => { e.stopPropagation(); confirmRemove = item; }}
                class="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:text-destructive transition-opacity"
                title={i18n.t('Remove from list')}
                aria-label={i18n.t('Remove from list')}
              >
                ×
              </button>
            </div>
        {/each}
      </div>
    {/if}
  </ScrollArea>

  <!--
    Removal confirmation.

    Removal uses `preserveHistory: false`, which wipes local history for good: the
    channel can only be restored by joining again, and its messages will not come
    back.
  -->
  {#if confirmRemove}
    <div class="p-3 border-t border-border bg-secondary/40 space-y-2">
      <p class="text-xs text-foreground">
        {i18n.t('Remove from list and delete local history?')}
      </p>
      <p class="text-[0.6875rem] text-muted-foreground truncate">
        {confirmRemove.communityName ? confirmRemove.communityName + ' / ' : ''}{confirmRemove.name}
      </p>
      <div class="flex gap-2">
        <button
          onclick={doRemove}
          class="flex-1 px-3 py-1.5 rounded-md bg-destructive text-white text-xs"
        >
          {i18n.t('Remove')}
        </button>
        <button
          onclick={() => { confirmRemove = null; }}
          class="px-3 py-1.5 rounded-md border border-border text-xs hover:bg-secondary"
        >
          {i18n.t('Cancel')}
        </button>
      </div>
    </div>
  {/if}
</div>
