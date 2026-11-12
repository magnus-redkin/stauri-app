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
     * `direct` — личная переписка, `community` — канал внутри сообщества,
     * `external` — источник провайдера (см. docs/ru/providers_and_dapps.md).
     *
     * `channel` — публичный канал status-go, оставлен только для уже
     * существующих чатов. Создавать новые из интерфейса нельзя: у такого
     * канала нет владельца, его нельзя закрыть, переименовать или найти по
     * каталогу, и в модели АКК он не выражает «канал с автором».
     */
    type: 'direct' | 'channel' | 'community' | 'external';
    isPendingRequest?: boolean;
    /** Время последней активности (мс): сортировка списка «по дате». */
    sortTs?: number;
    unreadCount?: number;
    /** Для каналов сообществ: к какому сообществу и категории относятся. */
    communityId?: string;
    communityName?: string;
    categoryId?: string;
    /** Можно ли писать. Для канала без права постинга ввод не показывается. */
    canPost?: boolean;
    /** Тип канала АКК (news / request / issues); см. channelKind.ts. */
    kind?: 'news' | 'request' | 'issues';
    /** Внешний источник: чей элемент и откуда он пришёл. */
    source?: string;
    sourceUrl?: string;
  };

  /**
   * Поиск по списку чатов.
   *
   * Ищем и по имени сообщества: у канала внутри сообщества `name` — это
   * только имя канала (`general`), а название сообщества лежит в
   * `communityName`. Без этой ветки ввод `stauri-akk-test-1131` не находил
   * ничего, хотя канал видён под заголовком с этим именем.
   */
  // По дате активности, новые сверху. Копия: стор не мутируем.
  const filteredItems = $derived(
    [...chatsState.items].sort((a, b) => (b.sortTs ?? 0) - (a.sortTs ?? 0))
  );

  /**
   * Подписки на внешние ленты как элементы списка чатов.
   *
   * Живут отдельно от `chatsState.items`, потому что приходят не из
   * status-go, а из `localStorage`. Склеиваем их здесь, а не в
   * `chatsStore`: тот стор отвечает за «что вернул бэкенд», и подмешивать
   * туда чужие данные значило бы смешать два источника в одном месте.
   *
   * Новые сверху: свежедобавленная лента должна быть видна сразу, а не
   * искаться в конце списка.
   */
  const feedItems = $derived.by(() => {
    // Форму строки строит `feedsStore`: она нужна ещё и в `selectChat`,
    // который открывает ленту по id из другого раздела.
    const items: ChatItem[] = feedChatItems();

    return items;
  });

  /**
   * Строки списка: подписки сверху, затем чаты.
   *
   * Порядок задаём мы, а не источник (docs §9.3): подписки — отдельный
   * блок, и канал сообщества не может их вытеснить.
   */
  const allItems = $derived([...feedItems, ...filteredItems]);

  /**
   * Плоский список без заголовков сообществ.
   *
   * В АКК пользователь видит каналы, а не сообщества: каждый канал — отдельное
   * техническое сообщество, и его имя в списке не выводим.
   */
  const groupedItems = $derived(allItems.map((item) => ({ kind: 'item' as const, item })));
  function select(item: ChatItem) {
    setSelectedChat(item);
    onSelectChat?.(item);
  }

  /** Подтверждение удаления: действие необратимо для истории. */
  let confirmRemove = $state<ChatItem | null>(null);

  async function doRemove() {
    const item = confirmRemove;
    if (!item) return;
    confirmRemove = null;

    // Внешняя подписка живёт у нас, а не в бэкенде: `removeChat` отправил бы
    // `deactivateChat` с несуществующим id и ничего не удалил.
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
    `min-h-0` обязателен: во flex-контейнере потомок по умолчанию не может
    сжаться ниже своего содержимого (`min-height: auto`). Без него список
    каналов распирал панель и не прокручивался — весь скролл уходил за
    пределы окна.
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
                    <div class="w-8 h-8 rounded-full bg-orange-100 text-orange-600 flex items-center justify-center font-bold text-lg">!</div>
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
                        Происхождение внешнего элемента показывается всегда и не
                        отключается: по docs/ru/providers_and_dapps.md §9.2 это
                        часть строки, а не необязательный бейдж.
                      -->
                      <div class="text-[0.625rem] text-muted-foreground/70 truncate">↗ {item.source}</div>
                    {/if}
                  </div>
                </div>
              </button>

              <!--
                Убрать из списка. Показывается при наведении, но не на
                сенсорных экранах: там hover нет, поэтому кнопка должна
                быть видна всегда, если основной ввод — касание.
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
    Подтверждение удаления.

    Спрашиваем, потому что `preserveHistory: false` стирает историю чата
    безвозвратно: вернуть канал в список можно только повторным вступлением,
    а сообщения при этом уже не восстановятся.
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
