<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { untrack } from 'svelte';
  import {
    getChatMessages,
    sendChatMessage,
    isReply,
  } from '$lib/status/messaging';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import { scenarioLog, short } from '$lib/utils/scenario';
  import { channelInviteLink } from '$lib/status/invite';
  import { canRecord, canComment } from '$lib/status/channelRights';
  import { chatsState, acceptRequestAndOpen, rejectRequest } from '$lib/stores/chatsStore.svelte';
  import { feedsState } from '$lib/stores/feedsStore.svelte';
  import { formatMessageText, getDisplayName, samePublicKey } from '$lib/utils/user';
  import { formatError } from '$lib/utils/errors';
  import { debug, error } from '$lib/utils/log';
  import { invoke } from '@tauri-apps/api/core';
  import {
    pendingJoinRequests,
    acceptJoinRequest,
    declineJoinRequest,
    type PendingJoinRequest,
  } from '$lib/status/akk';
  import CommentsPage from './CommentsPage.svelte';
  import ContactInvitePanel from './ContactInvitePanel.svelte';
  import JoinInvitePanel from './JoinInvitePanel.svelte';
  import CreateChannelPanel from './CreateChannelPanel.svelte';
  import ContactsSearchPanel from './ContactsSearchPanel.svelte';

  let messages = $state<any[]>([]);

  /** The node returns messages newest first; the feed renders top to bottom. */
  const byTime = (a: any, b: any) =>
    (Number(a.clock ?? 0) || Number(a.whisperTimestamp ?? 0)) -
    (Number(b.clock ?? 0) || Number(b.whisperTimestamp ?? 0));
  function setMessages(list: any[]) {
    messages = [...list].sort(byTime);
  }

  /** System events hidden in a direct chat: the request is already shown as a card. */
  const HIDDEN_CONTENT = new Set([15, 16]); // MUTUAL_EVENT_SENT, MUTUAL_EVENT_ACCEPTED
  const CONTACT_REQUEST = 11;

  /** Direct chat messages in time order, without system events. */
  const directMessages = $derived(
    messages.filter((m) => !HIDDEN_CONTENT.has(Number(m.contentType)))
  );

  /** Scrolls to the end of the feed, used on open and on new messages. */
  function scrollToEnd() {
    queueMicrotask(() => document.getElementById('chat-end')?.scrollIntoView({ block: 'end' }));
  }
  let inputText = $state('');

  /** Post whose comments are open on a separate page. `null` means the feed. */
  let openPostId = $state<string | null>(null);

  /** Join requests awaiting the author's decision. */
  let joinRequests = $state<PendingJoinRequest[]>([]);

  /**
   * Loads pending join requests for the selected channel.
   *
   * @remarks
   * Requests are only relevant to the channel author, the one who can decide them.
   * They are reloaded when the chat changes; a failure yields an empty list (see
   * akk.ts).
   */
  $effect(() => {
    const chat = chatsState.selected;
    if (!chat || chat.type !== 'community' || !chat.communityId || !statusState.backendRunning) {
      joinRequests = [];
      return;
    }
    if (!chatsState.communities.find((c) => c.id === chat.communityId)?.canManageUsers) {
      joinRequests = [];
      return;
    }
    pendingJoinRequests(chat.communityId).then((list) => (joinRequests = list));
  });

  /**
   * Accepts or declines a join request, then reloads the pending list.
   *
   * @param request - The pending join request to decide on.
   * @param accept - `true` to accept, `false` to decline.
   */
  async function decide(request: PendingJoinRequest, accept: boolean) {
    if (!statusState.backendRunning || !chatsState.selected?.communityId) return;
    try {
      const decision = accept ? 'accept' : 'decline';
      scenarioLog('create-request', `owner-${decision}`, { request: short(request.id) });
      if (accept) await acceptJoinRequest(request.id);
      else await declineJoinRequest(request.id);
      joinRequests = await pendingJoinRequests(chatsState.selected.communityId);
      scenarioLog('create-request', `owner-${decision}-done`, { left: joinRequests.length });
    } catch (e) {
      error(`[chat] decide join request failed`, e);
      statusState.errorMsg = formatError(e);
    }
  }
  let isLoading = $state(false);

  /** Whether the channel "⋯" menu is open. It opens by button, not by right click. */
  let menuOpen = $state(false);
  let menuNotice = $state('');

  /** Post whose "⋯" menu is open. */
  let postMenuId = $state<string | null>(null);

  /**
   * Copies a link to the channel.
   *
   * @remarks
   * status-go has no per-message link (`DeepLink` only knows channels), so the
   * link points to the channel as a whole: SIM opens the channel, and the post can
   * be found in Stauri by its text. This limitation is deliberate.
   */
  async function copyPostLink() {
    postMenuId = null;
    const chat = chatsState.selected;
    if (!chat?.communityId) return;
    const channelId = chat.id.slice(chat.communityId.length);
    const link = channelInviteLink(channelId, chat.communityId);
    try {
      await navigator.clipboard.writeText(link);
      menuNotice = 'Ссылка скопирована';
    } catch (e) {
      menuNotice = 'Не удалось скопировать';
      error('[chat] copy post link failed', e);
    }
    setTimeout(() => (menuNotice = ''), 2500);
  }

  /**
   * Copies the channel invite link.
   *
   * The link is built from the channel UUID and the community key
   * (`channelInviteLink`). The community key is the same one as in `communityId`:
   * an AKK channel lives in a single service community, so that community's key is
   * effectively the channel key.
   */
  async function copyInvite() {
    menuOpen = false;
    const chat = chatsState.selected;
    if (!chat?.communityId) return;
    const channelId = chat.id.slice(chat.communityId.length);
    const link = channelInviteLink(channelId, chat.communityId);
    try {
      await navigator.clipboard.writeText(link);
      menuNotice = 'Ссылка скопирована';
      scenarioLog('create-auto', 'invite-copied', { channel: short(channelId) });
    } catch (e) {
      menuNotice = 'Не удалось скопировать';
      error('[chat] copy invite failed', e);
    }
    setTimeout(() => (menuNotice = ''), 2500);
  }
  let isAccepting = $state(false);

  /**
   * Keys of feed posts that are currently expanded.
   *
   * @remarks
   * `SvelteSet` is reactive on its own, so it is neither wrapped in `$state` nor
   * reassigned: reassigning would drop the subscriptions. This state lives in the
   * component and is not persisted; it is a "view for now", not a preference.
   */
  const expandedItems = new SvelteSet<string>();

  function toggleItem(key: string) {
    if (expandedItems.has(key)) expandedItems.delete(key);
    else expandedItems.add(key);
  }

  /** Messages (channel posts and comments) whose long text is expanded. */
  const expandedMessages = new SvelteSet<string>();

  function toggleMessage(key: string) {
    if (expandedMessages.has(key)) expandedMessages.delete(key);
    else expandedMessages.add(key);
  }

  /**
   * Whether a message is long enough to be worth collapsing.
   *
   * @param text - Message body.
   * @returns `true` for long or multi-line text.
   * @remarks
   * The decision is made by length and line count rather than by measuring the
   * rendered element: a measurement would need a post-render pass per message and
   * would flicker on resize.
   */
  function isLongText(text: string | undefined): boolean {
    const value = text || '';
    return value.length > 280 || (value.match(/\n/g)?.length ?? 0) > 3;
  }

  /**
   * Opens a URL with the system handler.
   *
   * @param url - The URL to open.
   *
   * @remarks
   * Neither `<a target="_blank">` nor `plugin-shell.open` is used: WebKitGTK inside
   * a Tauri window often does nothing for such a navigation, because the webview
   * is not obliged to open windows, and `plugin-shell.open` would need the
   * `shell:allow-open` capability, which would let any XSS in the UI launch
   * arbitrary programs. The `open_external` command validates the scheme in Rust
   * and tries to open a Telegram link in Telegram itself.
   */
  async function openExternal(url: string) {
    try {
      await invoke('open_external', { url });
    } catch (e) {
      // Foreign content: a failed open must not break the feed. The full address
      // is shown next to it and can be opened manually.
      error('[chat] failed to open link', e);
    }
  }

  /**
   * Channel posts, without the comments that answer them.
   *
   * @remarks
   * Posts and comments come from the same list. A comment is an ordinary message
   * with a non-empty `responseTo`, stored in the same table under the same
   * `local_chat_id`. `MessageByChatID` filters `response_to` only through
   * `thread_id`, and that filter is off while threads are disabled:
   *
   * > If threads are disabled, then we are backwards compatible and messages
   * > in threads are treated as normal messages, so we don't filter them out.
   *
   * Verified live (docs/ru/akk_scheme.md §12): the reply arrives in the common
   * list. Without this split, comments would hang in the feed as ordinary posts.
   */
  const posts = $derived(messages.filter((m) => !isReply(m)));

  /**
   * Comments grouped by the id of their parent post.
   *
   * @remarks
   * A `SvelteMap` rather than `Map`: the map is read from the template, and a plain
   * `Map` is not tracked by Svelte reactivity (`prefer-svelte-reactivity`).
   */
  const repliesByParent = $derived.by(() => {
    const map = new SvelteMap<string, any[]>();
    for (const msg of messages) {
      if (!isReply(msg)) continue;
      const parent = msg.responseTo as string;
      const list = map.get(parent);
      if (list) list.push(msg);
      else map.set(parent, [msg]);
    }
    return map;
  });

  /**
   * Whether the selected chat accepts comments (anyone allowed to post may comment).
   *
   * @remarks
   * An external source is read-only: there is nowhere to post, so the input is absent
   * rather than disabled without explanation (docs/ru/providers_and_dapps.md §9.2).
   *
   * `canPost === false` means a community channel that this account cannot post in.
   * That is exactly the spectated community case: messages are readable, but
   * `Community.CanPost` returns `false` for a non-member. Without this check a browse
   * view would show the input and sending would fail on the server.
   *
   * Writing a post is a separate right; see `canRecordHere`.
   */
  const canWrite = $derived(
    !!chatsState.selected &&
      chatsState.selected.type !== 'external' &&
      !chatsState.selected.isPendingRequest &&
      canComment(chatsState.selected.canPost)
  );

  /**
   * Whether a new post can be written in the channel.
   *
   * Both sides write posts in a one-to-one chat, so the rule only applies to
   * channels. In a channel only the author writes posts, except for the `issues`
   * kind where every member may (`canRecord`).
   */
  const canRecordHere = $derived(
    canWrite &&
      canRecord(
        chatsState.selected?.type === 'community' ? chatsState.selected.kind : undefined,
        chatsState.communities.find((c) => c.id === chatsState.selected?.communityId)?.memberRole
      )
  );

  /** Community of the selected channel, needed to send a message. */
  const communityId = $derived(chatsState.selected?.communityId || '');

  /**
   * The subscription backing the selected external source, or `null`.
   *
   * An external chat does not exist in the backend: its id is `feed:<url>` and its
   * content lives in `feedsState`. Messages are therefore taken straight from the
   * subscription instead of `messages`, and the history load below does not run for
   * it.
   */
  const feed = $derived.by(() => {
    const chat = chatsState.selected;
    if (!chat || chat.type !== 'external') return null;
    const url = chat.sourceUrl || chat.id.replace(/^feed:/, '');
    return feedsState.subscriptions.get(url) ?? null;
  });

  // Input diagnostics: on chat selection logs which conditions open or close the
  // composer. Read-only, no side effects.
  $effect(() => {
    const chat = chatsState.selected;
    if (!chat) return;
    scenarioLog('reply-sync', 'input-state', {
      chat: short(chat.id),
      type: chat.type,
      isPendingRequest: !!chat.isPendingRequest,
      canPost: chat.canPost ?? null,
      canWrite: canWrite,
      canRecord: canRecordHere,
    });
  });

  /**
   * Polls the open conversation every 10 s.
   *
   * @remarks
   * A message that arrived before the chat was opened, or before the list poll
   * noticed it, would otherwise never reach this screen: there is no poll baseline
   * to compare against here. Requesting a single chat is cheap.
   */
  $effect(() => {
    const chat = chatsState.selected;
    if (!chat || chat.isPendingRequest || chat.type === 'external' || !statusState.backendRunning) return;
    const reload = () =>
      untrack(() => {
        getChatMessages(chat.id)
          .then((res) => {
            const next = res.messages;
            const lastNow = messages[messages.length - 1]?.id;
            const lastNext = next[next.length - 1]?.id;
            if (next.length !== messages.length || lastNow !== lastNext) {
              scenarioLog('reply-sync', 'poll-reloaded', { chat: short(chat.id), before: messages.length, after: next.length });
              setMessages(next);
              scrollToEnd();
            }
          })
          .catch(() => {});
      });
    const id = setInterval(reload, 10_000);
    return () => clearInterval(id);
  });

  $effect(() => {
    const chat = chatsState.selected;
    if (!chat || chat.isPendingRequest || chat.type === 'external' || !statusState.backendRunning) {
      messages = [];
      return;
    }
    isLoading = true;
    messages = [];

    getChatMessages(chat.id)
      .then(res => {
        setMessages(res.messages);
        scrollToEnd();
        debug(`[chat] ${chat.id}: loaded ${res.messages.length} messages`);
      })
      .catch((e) => { error(`[chat] ${chat.id}: load messages failed`, e); })
      .finally(() => isLoading = false);
  });

  /**
   * Reloads the open feed when the `messages.new` signal fires.
   *
   * @remarks
   * The reload skips the clearing step and the loading indicator so the feed does
   * not flicker. `untrack` around the write to `messages` is required: otherwise an
   * effect that both reads and writes `messages` would retrigger itself.
   */
  $effect(() => {
    const signal = statusState.lastMessageSignal;
    const chat = chatsState.selected;
    if (signal === 0 || !chat || chat.type === 'external' || chat.isPendingRequest || !statusState.backendRunning) return;

    // Reload only when the message landed in the open chat. Signals from other
    // chats arrive constantly (channels absent from the list), so without this check
    // the open feed would be reloaded for every one of them.
    if (!statusState.pendingChatIds.has(chat.id)) return;

    untrack(() => {
      statusState.pendingChatIds.delete(chat.id);
      scenarioLog('reply-sync', 'signal', { signal, chat: short(chat.id) });
      getChatMessages(chat.id)
        .then((res) => {
          const before = messages.length;
   setMessages(res.messages);
   scrollToEnd();
   scenarioLog('reply-sync', 'reloaded', {
     chat: short(chat.id),
     before,
     after: res.messages.length,
     replies: res.messages.filter((m: any) => isReply(m)).length,
          });
        })
        .catch((e) => scenarioLog('reply-sync', 'error', { error: formatError(e) }, 'warn'));
    });
  });

  /**
   * Display name of a message author.
   *
   * @param msg - Message whose author is needed.
   * @returns "You" for own messages, otherwise the contact name when known, or the
   * shortened key.
   *
   * @remarks
   * A foreign author is not necessarily a contact, so an unknown key is rendered
   * shortened rather than omitted.
   */
  function authorNameOf(msg: any): string {
    if (isOwn(msg)) return i18n.t('You');
    const contact = chatsState.contacts.find((c: any) => c.id === msg.from);
    if (contact) return getDisplayName(contact);
    return msg.from ? `${msg.from.slice(0, 10)}…` : i18n.t('Unknown');
  }

  /**
   * Whether a message was sent by this account.
   *
   * @param msg - Message to test.
   * @returns `true` when the message is outgoing.
   *
   * The backend never writes `from: 'me'`; it puts the sender's public key there, so
   * the key is compared with `statusState.publicKey`. A fallback signal is
   * `outgoingStatus`: status-go fills it only on outgoing messages
   * (`sending`/`sent`/`delivered`), which is the only reliable sign before the
   * profile key has loaded.
   */
  function isOwn(msg: any): boolean {
    if (!msg) return false;
    if (msg.from === 'me') return true;
    if (msg.outgoingStatus) return true;
    // A direct chat is keyed by the uncompressed key, settings carry the
    // uncompressed one, but a channel message's `from` is compressed. A string
    // compare therefore failed inside channels and the own message was shown as
    // a contact, under its random alias.
    return samePublicKey(msg.from, statusState.publicKey);
  }

  async function send() {
    const chat = chatsState.selected;
    if (!inputText.trim() || !chat || !canWrite || !statusState.backendRunning) return;
    const text = inputText;
    inputText = '';
    // In a channel where only the author records posts, the composer at the bottom
    // writes a comment to the last post: the user can answer there, but a new post
    // is not theirs to make.
    const lastPost = posts[posts.length - 1];
    const responseTo = !canRecordHere && lastPost ? String(lastPost.id) : '';
    try {
      const res = await sendChatMessage(
        chat.id,
 text,
        communityId,
        responseTo
      );
      scenarioLog('reply-sync', 'sent', { chat: short(chat.id), comment: !!responseTo });
      // The backend returns both the new message and its parent in
      // `result.messages`. For a regular post just append an optimistic copy; a
      // reply is picked up by the next history load.
      const sent = (res?.result?.messages || []).find(
        (m: any) => !isReply(m) && m.text === text
      );
      messages = [
        ...messages,
        sent || {
          text,
          from: statusState.publicKey || 'me',
          timestamp: Date.now(),
          outgoingStatus: 'sending',
          ...(responseTo ? { responseTo } : {}),
        },
      ];
    } catch (e) {
      error(`[chat] ${chat.id}: send failed`, e);
      statusState.errorMsg = "Failed to send message";
    }
  }

  async function declineRequest() {
    const chat = chatsState.selected;
    if (!chat || !statusState.backendRunning) return;
    isAccepting = true;
    try {
      await rejectRequest(chat, chat.id);
    } catch (e: any) {
      statusState.errorMsg = `Failed to reject request: ${formatError(e)}`;
    } finally {
      isAccepting = false;
    }
  }

  async function acceptRequest() {
    const chat = chatsState.selected;
    if (!chat || !statusState.backendRunning) return;
    isAccepting = true;
    try {
      await acceptRequestAndOpen(chat, chat.id);
    } catch (e: any) {
      statusState.errorMsg = `Failed to accept request: ${formatError(e)}`;
    } finally {
      isAccepting = false;
    }
  }
</script>

<div class="h-full flex flex-col bg-card">
  {#if chatsState.rightPanel === 'contactInvite'}
    <ContactInvitePanel />
  {:else if chatsState.rightPanel === 'joinInvite'}
    <JoinInvitePanel />
  {:else if chatsState.rightPanel === 'newChannel'}
    <CreateChannelPanel />
  {:else if chatsState.rightPanel === 'contacts' || !chatsState.selected}
    <ContactsSearchPanel />
  {:else}
    <div class="p-4 border-b border-border flex items-center gap-2">
      <span class="font-bold text-primary truncate">{chatsState.selected.name}</span>
      {#if chatsState.selected.type === 'community' && chatsState.selected.communityId}
        <div class="relative ml-auto">
          <button
            onclick={() => (menuOpen = !menuOpen)}
     class="px-2 py-1 rounded hover:bg-secondary text-muted-foreground"
     aria-label={i18n.t('Channel actions')}
     aria-haspopup="menu"
     aria-expanded={menuOpen}
          >
            ⋯
          </button>
          {#if menuOpen}
     <!--
          A Stauri channel is technically a status-go community, so Status Desktop
          shows it as a community named after the channel with a single `#general`
          channel inside. The menu explains this mismatch instead of hiding it.
        -->
     <div role="menu" class="absolute right-0 top-full mt-1 z-10 min-w-[12rem] rounded-md border border-border bg-card shadow-md py-1 text-sm">
       <p class="px-3 pb-2 pt-1 text-xs text-muted-foreground max-w-[16rem]">
         {i18n.t('In Status Desktop this channel shows as community')} «{chatsState.selected.communityName || chatsState.selected.name}» {i18n.t('with channel')} #general
       </p>
       <button role="menuitem" onclick={copyInvite} class="w-full text-left px-3 py-2 hover:bg-secondary">
         {i18n.t('Copy invite link')}
       </button>
     </div>
          {/if}
        </div>
      {/if}
      {#if menuNotice}
        <span class="text-xs text-muted-foreground">{menuNotice}</span>
      {/if}
      {#if chatsState.selected.type === 'external'}
        <span class="text-xs bg-secondary text-muted-foreground px-2 py-0.5 rounded">
          {i18n.t('External source')}
        </span>
      {/if}
      {#if joinRequests.length > 0}
        <span class="ml-auto text-xs bg-warning/10 text-warning px-2 py-0.5 rounded">
          {i18n.t('Join requests')}: {joinRequests.length}
        </span>
      {/if}
      {#if chatsState.selected.isPendingRequest}
        <span class="text-xs bg-warning/10 text-warning px-2 py-0.5 rounded">{i18n.t('Contact Request')}</span>
      {/if}
    </div>

    {#if joinRequests.length > 0}
      <ul class="p-3 border-b border-border space-y-2 bg-secondary/40">
        {#each joinRequests as request (request.id)}
          <li class="flex items-center gap-2 text-sm">
     <span class="truncate font-mono text-xs">{request.publicKey.slice(0, 16)}…</span>
     <button
       onclick={() => decide(request, true)}
       class="ml-auto h-7 px-3 rounded-md bg-primary text-primary-foreground text-xs"
     >
       {i18n.t('Accept')}
            </button>
     <button
       onclick={() => decide(request, false)}
       class="h-7 px-3 rounded-md border border-border text-xs"
     >
       {i18n.t('Decline')}
     </button>
          </li>
        {/each}
      </ul>
    {/if}

    {#if chatsState.selected.isPendingRequest}
      <div class="flex-1 flex flex-col items-center justify-center p-6 gap-6">
        <div class="w-16 h-16 rounded-full bg-warning/10 text-warning flex items-center justify-center font-bold text-3xl">!</div>
        <p class="text-center text-sm text-muted-foreground">"{chatsState.selected.lastMessage}"</p>
        <div class="flex gap-3">
          <button onclick={acceptRequest} disabled={isAccepting} class="px-4 py-2 bg-primary text-primary-foreground rounded-md">
            {isAccepting ? i18n.t('Accepting...') : i18n.t('Accept')}
          </button>
   <button onclick={declineRequest} disabled={isAccepting} class="px-4 py-2 border border-border rounded-md hover:bg-secondary">
     {i18n.t('Reject')}
   </button>
        </div>
      </div>
    {:else if chatsState.selected.type === 'external'}
      <!--
        External feed. A separate branch because the backend holds no messages for
        it: items come from RSS/Atom and live in `feedsState`.

        Text is collapsed with `line-clamp`, not truncated in the data: shortening is
        layout, so clicking an item shows it whole without refetching. Source markup
        is never passed to `{@html}` (docs §9.5).
      -->
      <!--
        `min-h-0` is required: inside `flex flex-col` a child defaults to
        `min-height: auto` and does not shrink, so the list would grow past the panel
        instead of scrolling. Padding sits on the inner `div`: the scrollable area in
        ScrollArea takes `size-full` from the root, so `p-4` on ScrollArea itself
        would eat the height.
      -->
      <ScrollArea class="flex-1 min-h-0">
        <div class="p-4">
        {#if !feed}
          <p class="text-muted-foreground text-sm italic">{i18n.t('Feed not found')}</p>
        {:else if feed.error && feed.items.length === 0}
          <p class="text-destructive text-sm">{feed.error}</p>
        {:else if feed.items.length === 0 && !feed.error && feed.fetchedAt === 0}
          <!-- A subscription is stored before its first fetch: the panel returns at
               once and the app switches here while the feed is still loading. -->
          <p class="text-muted-foreground text-sm italic">{i18n.t('Loading feed...')}</p>
        {:else if feed.items.length === 0}
          <p class="text-muted-foreground text-sm italic">{i18n.t('No items in this feed')}</p>
        {:else}
          <div class="space-y-3">
            {#each feed.items as item (item.url || item.title)}
              {@const key = item.url || item.title}
              {@const open = expandedItems.has(key)}
              <div class="p-3 rounded-md bg-secondary/40">
                {#if item.summary}
                  <!--
                    A collapsed item is a button: clicking expands the text. A link
                    inside a button is invalid, so the source button sits separately
                    below the text.
                  -->
                  <button
                    onclick={() => toggleItem(key)}
                    class="w-full text-left"
                    aria-expanded={open}
                  >
                    <div class="text-sm font-medium text-foreground">{item.title}</div>
                    <div
                      class="text-sm text-muted-foreground mt-1 {open ? 'whitespace-pre-wrap' : 'line-clamp-4'} break-words"
                    >
                      {item.summary}
                    </div>
                    {#if !open}
                      <div class="text-[0.625rem] text-primary mt-1">{i18n.t('Show more')}</div>
                    {/if}
                  </button>
                {:else}
                  <div class="text-sm font-medium text-foreground">{item.title}</div>
                {/if}

                <div class="flex items-center gap-2 mt-2">
                  {#if item.published_at}
                    <span class="text-[0.625rem] text-muted-foreground shrink-0">
                      {new Date(item.published_at).toLocaleString()}
                    </span>
                  {/if}
                  {#if item.url}
                    <!--
                      The source opens through a Rust command rather than a
                      navigation: `target="_blank"` inside a Tauri window in
                      WebKitGTK often does nothing. The full address is kept in `title`
                      so it can be read and copied when no handler is found.
                    -->
                    <button
                      onclick={() => openExternal(item.url!)}
                      class="text-[0.625rem] text-primary hover:underline truncate max-w-[60%] text-left"
                      title={item.url}
                    >
                      {i18n.t('Open source')}: {item.url}
                    </button>
                  {/if}
                </div>
              </div>
            {/each}
          </div>
        {/if}
        </div>
      </ScrollArea>
    {:else if openPostId && messages.find((m) => m.id === openPostId)}
      {@const openPost = messages.find((m) => m.id === openPostId)}
      <CommentsPage
 post={openPost}
        replies={repliesByParent.get(openPostId) || []}
        authorNameOf={authorNameOf}
 canWrite={canWrite}
        onBack={() => (openPostId = null)}
        onSent={(sent) => (messages = [...messages, sent])}
      />
    {:else}
      <!-- Message history. Same reason for `min-h-0` and padding on the inner `div`. -->
      <ScrollArea class="flex-1 min-h-0">
        <div class="p-4 {chatsState.selected.type === 'community' ? 'bg-background min-h-full' : ''}">
        {#if isLoading}
          <p class="text-muted-foreground text-sm">{i18n.t('Loading messages...')}</p>
        {:else if posts.length === 0}
          <p class="text-muted-foreground text-sm italic">{i18n.t('No messages yet.')}</p>
        {:else if chatsState.selected.type === 'direct'}
          <!--
            Direct chat bubbles. Own messages on the left, the other party's on the
            right. A bubble is 3/4 of the column wide, with a background slightly
            lighter or darker than the column.
          -->
          <div class="flex flex-col gap-2">
            {#each directMessages as msg (msg.id)}
              {#if Number(msg.contentType) === CONTACT_REQUEST}
                <!-- Contact request: name, request text, and a check mark once accepted. -->
                <div class="w-3/4 mx-auto rounded-lg px-3 py-2 border border-border bg-card text-sm">
                  <div class="flex items-center gap-2 mb-1">
                    <span class="text-xs font-semibold text-muted-foreground">{i18n.t('Request')}</span>
                    <span class="font-medium truncate">{authorNameOf(msg)}</span>
                    {#if Number(msg.contactRequestState) === 2}
                      <span class="ml-auto text-success font-bold" title={i18n.t('Accepted')} aria-label={i18n.t('Accepted')}>✓</span>
                    {/if}
                  </div>
                  <div class="whitespace-pre-wrap break-words">{formatMessageText(msg.text, chatsState.contacts)}</div>
                </div>
              {:else}
                <div class="flex {isOwn(msg) ? 'justify-start' : 'justify-end'}">
                  <div class="w-3/4 rounded-lg px-3 py-2 bg-secondary/50 text-sm">
                    <div class="text-xs text-muted-foreground mb-0.5">{isOwn(msg) ? i18n.t('You') : authorNameOf(msg)}</div>
                    <div class="whitespace-pre-wrap break-words">{formatMessageText(msg.text, chatsState.contacts)}</div>
                  </div>
                </div>
              {/if}
            {/each}
            <div id="chat-end"></div>
          </div>
        {:else}
          <div class="space-y-3">
            {#each posts as post (post.id)}
              {@const replies = repliesByParent.get(post.id) || []}
              {@const postLong = isLongText(post.text)}
              {@const postOpen = expandedMessages.has(post.id)}
              <!--
                A post is a white bubble on the section background, the same shape a
                direct chat uses, so a channel does not look like a different kind of
                screen.
              -->
              <div class="rounded-lg border border-border/60 bg-card px-3 py-2 shadow-sm space-y-1">
  {#if chatsState.selected.type === 'community'}
    <div class="relative flex justify-end">
      <button
 onclick={() => (postMenuId = postMenuId === post.id ? null : post.id)}
        class="px-1 text-xs text-muted-foreground hover:text-foreground"
        aria-label={i18n.t('Post actions')}
        aria-expanded={postMenuId === post.id}
      >
        ⋯
      </button>
      {#if postMenuId === post.id}
 <div role="menu" class="absolute right-0 top-full z-10 min-w-[10rem] rounded-md border border-border bg-card shadow-md py-1 text-sm">
   <button role="menuitem" onclick={copyPostLink} class="w-full text-left px-3 py-2 hover:bg-secondary">
     {i18n.t('Copy link')}
   </button>
        </div>
      {/if}
    </div>
         {/if}
  <div class="text-sm">
           <div class="font-bold">{authorNameOf(post)}</div>
    <div class="{postOpen || !postLong ? 'whitespace-pre-wrap' : 'line-clamp-4'} break-words">{formatMessageText(post.text, chatsState.contacts)}</div>
    {#if postLong}
      <button
        onclick={() => toggleMessage(post.id)}
        class="text-xs text-primary mt-1 hover:underline"
        aria-expanded={postOpen}
      >
        {postOpen ? i18n.t('Show less') : i18n.t('Show more')}
      </button>
    {/if}
  </div>
  <button
           onclick={() => (openPostId = post.id)}
    class="text-xs text-muted-foreground hover:text-foreground mt-1"
         >
    {replies.length > 0 ? `${i18n.t('Comments')} (${replies.length})` : i18n.t('Comment')}
  </button>

                <!--
                  Comments under a post.

                  Each comment carries its author: a channel has many writers, and a
                  line without a name was indistinguishable from the post above it.
                  Long comments collapse the same way the post does.
                -->
                {#if replies.length > 0}
                  <div class="pl-4 space-y-1 border-t border-border/60 pt-1">
                    {#each replies as reply (reply.id)}
                      {@const replyLong = isLongText(reply.text)}
                      {@const replyOpen = expandedMessages.has(reply.id)}
                      <div class="flex gap-2 text-sm">
                        <span class="text-muted-foreground shrink-0">↳</span>
                        <div class="{isOwn(reply) ? 'text-primary' : 'text-foreground'} min-w-0">
                          <div class="text-xs font-medium text-muted-foreground">{authorNameOf(reply)}</div>
                          <div class="{replyOpen || !replyLong ? 'whitespace-pre-wrap' : 'line-clamp-4'} break-words">{formatMessageText(reply.text, chatsState.contacts)}</div>
                          {#if replyLong}
                            <button
                              onclick={() => toggleMessage(reply.id)}
                              class="text-xs text-primary mt-1 hover:underline"
                              aria-expanded={replyOpen}
                            >
                              {replyOpen ? i18n.t('Show less') : i18n.t('Show more')}
                            </button>
                          {/if}
                        </div>
                      </div>
                    {/each}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        </div>
      </ScrollArea>

      <!--
        Feed input. A channel where the account cannot post still takes comments: the
        composer writes a comment to the last post (see `send`), so it is shown
        whenever writing is allowed at all.
      -->
      {#if canWrite && !openPostId}
        <div class="p-4 border-t border-border flex gap-2">
          <input
            bind:value={inputText}
            placeholder={i18n.t('Type a message...')}
            onkeydown={(e) => {
if (e.key === 'Enter') send();
     }}
            class="flex-1 px-3 py-2 border border-input rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <button onclick={send} class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium">
            {i18n.t('Send')}
          </button>
        </div>
      {:else if chatsState.selected.canPost === false}
        <div class="p-4 border-t border-border text-sm text-muted-foreground">
          {i18n.t('You cannot post in this channel')}
        </div>
      {/if}
    {/if}
  {/if}
</div>
