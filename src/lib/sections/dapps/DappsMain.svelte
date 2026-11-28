<script lang="ts">
  /**
   * Right panel of the dApps section.
   *
   * The address bar at the top opens the entered dApp in a separate window (`dapp.rs`)
   * rather than inside this panel. A foreign interface gets no access to the component tree
   * or to IPC: its window is not listed in the capabilities, so `invoke` from a foreign
   * page does not work.
   *
   * Below the bar, while no provider is selected, sits the list of examples. It mixes three
   * kinds that look like one list to the user: a built-in screen (the directory), a real
   * external application, and an entry that only fills the provider address. The difference
   * is where the interface opens.
   *
   * Two providers, each with its own slot:
   *   * `communities` — a community directory; the provider returns addresses only, and the
   *     join request is sent by the app (`spectateCommunity`);
   *   * `feed` — a feed by URL; entries are read-only and links open through explicit
   *     buttons that show the full address.
   *
   * Markup returned by a provider never reaches `{@html}` (docs §9.5): only text and
   * individual links are rendered.
   */
  import { i18n } from '$lib/i18n';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    dappsState,
    dappExamples,
    openDapp,
    activateExample,
    resetDappsView,
  } from '$lib/stores/dappsStore.svelte';
  import {
    feedsState,
    addFeed,
    loadFeeds,
    RSSHUB_MIRROR,
    FEED_EXAMPLES,
    TG_CHANNELS,
    normalizeFeedUrl,
  } from '$lib/stores/feedsStore.svelte';
  import {
    communitiesState,
    filteredEntries,
    loadCommunities,
    selectCommunity,
    openChannel,
    channelTree,
  } from '$lib/stores/communitiesStore.svelte';
  import JoinCommunity from './JoinCommunity.svelte';
  import { pluginsState, loadPlugins, installPlugin, openPlugin, removePlugin } from '$lib/stores/pluginsStore.svelte';

  const entries = $derived(filteredEntries());

  // Installed dApp plugins are read once when the panel opens; install, open and remove
  // refresh the list themselves.
  $effect(() => {
    if (!pluginsState.loaded) void loadPlugins();
  });

  /**
   * Communities expanded into a channel tree.
   *
   * `SvelteSet` is reactive on its own, so it is neither wrapped in `$state` nor
   * reassigned — reassigning would drop the subscriptions (the same reason as in
   * `ChatLeft`).
   */
  const expanded = new SvelteSet<string>();

  function toggleExpanded(id: string) {
    if (expanded.has(id)) expanded.delete(id);
    else expanded.add(id);
  }

  /** Channels of the selected community: categories and what is inside them. */
  const tree = $derived(channelTree(communitiesState.selected?.community));

  let channelError = $state('');

  /**
   * Whether the join form is open.
   *
   * Kept separate from `communitiesState` because it is interface state, not data. The form
   * itself is mounted only under the expanded community, so it never outlives its community.
   */
  let joining = $state(false);

  /**
   * The dApp address input.
   *
   * It takes focus as soon as the examples screen is shown: that is the first thing done in
   * this section, and an extra click is pointless. The `$effect` also runs when returning
   * from the directory — the section stays the same while the screen changes.
   */
  let dappInput = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if (dappsState.active === null) dappInput?.focus();
  });

  /**
   * The feed address input.
   *
   * Same principle: opening the provider puts the cursor in the field so a URL can be
   * pasted straight away — there is no other action on that screen.
   */
  let feedInput = $state<HTMLInputElement | null>(null);
  $effect(() => {
    if (dappsState.active === 'feed') feedInput?.focus();
  });

  /** Callback from `+page.svelte`: switch to the chat section and open the given chat. */
  let { onOpenChat }: { onOpenChat?: (chatId: string) => void } = $props();

  /**
   * Adds a feed and opens it in the chat list.
   *
   * Opening it is not decoration: adding a feed validates the address and, when it works,
   * creates a chat entry. Leaving the user on the provider panel would make them hunt for
   * what they just added.
   */
  async function submitFeed() {
    if (feedsState.isAdding) return;
    const res = await addFeed(dappsState.feedUrl);
    if (!res.ok) return;

    const raw = dappsState.feedUrl.trim();
    dappsState.feedUrl = '';
    // The key is what `normalizeFeedUrl` produced, not the text the user typed: a
    // `t.me/<name>` link becomes an RSSHub mirror route, and comparing the raw input
    // against stored keys never matched, so the section did not switch to the new chat.
    const added = normalizeFeedUrl(raw) ?? raw;
    onOpenChat?.(`feed:${added}`);
  }

  async function handleChannelClick(entry: any, channelId: string) {
    channelError = '';
    const res = await openChannel(entry, channelId);
    if (res.ok && res.chatId) onOpenChat?.(res.chatId);
    else if (!res.ok) channelError = res.error || i18n.t('Channel is not readable');
  }
</script>

<div class="h-full flex flex-col bg-card">
  {#if dappsState.active === null}
    <div class="flex-1 flex flex-col min-h-0">
      <!--
        The address bar belongs to the examples screen only. Sharing it with the feed
        provider puts two address inputs side by side, and a Telegram channel link ends up
        in the dApp field. The field is part of "choose what to open", not a header for the
        whole section.
      -->
      <div class="p-2 border-b border-border space-y-2">
        <div class="flex gap-2">
          <input
            bind:value={dappsState.dappUrl}
            placeholder={i18n.t('dApp address (https://...)')}
            onkeydown={(e) => { if (e.key === 'Enter') openDapp(); }}
            class="flex-1 h-9 border border-input rounded-md px-3 text-sm bg-background"
          />
          <button
            onclick={() => openDapp()}
            disabled={!dappsState.dappUrl.trim()}
            class="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50 shrink-0"
          >
            {i18n.t('Open')}
          </button>
        </div>
        {#if dappsState.dappError}
          <p class="text-xs text-destructive">{dappsState.dappError}</p>
        {/if}
        <!--
          The warning cannot be dismissed (docs §12): the user must know that a foreign
          window cannot reach Stauri, but that the app is also not responsible for what that
          window shows. It is always visible rather than shown once — "don't ask again" here
          would mean "forget that this is foreign code".
        -->
        <p class="text-[0.6875rem] text-muted-foreground">
          {i18n.t('External dApps open in a separate window and cannot reach Stauri or your keys.')}
        </p>
      </div>

      <div class="p-4 border-b border-border">
        <span class="font-bold text-lg text-primary">{i18n.t('dApps')}</span>
        <p class="text-xs text-muted-foreground mt-1">
          {i18n.t('Built-in ones stay in Stauri; external ones open in a separate window.')}
        </p>
      </div>

      <div class="p-2 border-b border-border space-y-2">
        <div class="flex gap-2">
          <input
            bind:value={dappsState.dappUrl}
            bind:this={dappInput}
            placeholder={i18n.t('dApp address (https://...)')}
            onkeydown={(e) => { if (e.key === 'Enter') openDapp(); }}
            class="flex-1 h-9 border border-input rounded-md px-3 text-sm bg-background"
          />
          <button
            onclick={() => openDapp()}
            disabled={!dappsState.dappUrl.trim()}
            class="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50 shrink-0"
          >
            {i18n.t('Open')}
          </button>
        </div>
        {#if dappsState.dappError}
          <p class="text-xs text-destructive">{dappsState.dappError}</p>
        {/if}
        <!-- Same non-dismissible warning as the block above. -->
        <p class="text-[0.6875rem] text-muted-foreground">
          {i18n.t('External dApps open in a separate window and cannot reach Stauri or your keys.')}
        </p>
      </div>

      <div class="p-4 border-b border-border">
        <span class="font-bold text-primary">{i18n.t('Installed plugins')}</span>
        <div class="mt-2 flex gap-2">
          <input
            bind:value={pluginsState.manifestUrl}
            placeholder={i18n.t('dApp manifest URL (https://...)')}
            onkeydown={(e) => { if (e.key === 'Enter') installPlugin(); }}
            class="flex-1 h-9 border border-input rounded-md px-3 text-sm bg-background"
          />
          <button
            onclick={() => installPlugin()}
            disabled={pluginsState.isInstalling || !pluginsState.manifestUrl.trim()}
            class="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50 shrink-0"
          >
            {pluginsState.isInstalling ? i18n.t('Installing...') : i18n.t('Install')}
          </button>
        </div>
        {#if pluginsState.error}
          <p class="text-xs text-destructive mt-1">{pluginsState.error}</p>
        {/if}
        {#if pluginsState.items.length === 0}
          <p class="text-xs text-muted-foreground mt-2">{i18n.t('No plugins installed')}</p>
        {:else}
          <ul class="mt-2 space-y-1">
            {#each pluginsState.items as dapp (dapp.id)}
              <li class="flex items-center gap-2 text-sm">
                <span class="truncate">{dapp.name}</span>
                <span class="text-xs text-muted-foreground">v{dapp.version}</span>
                <button
                  onclick={() => openPlugin(dapp.id)}
                  class="ml-auto text-xs text-primary hover:underline"
                >
                  {i18n.t('Open')}
                </button>
                <button
                  onclick={() => removePlugin(dapp.id)}
                  class="text-xs text-muted-foreground hover:text-destructive"
                >
                  {i18n.t('Remove')}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="p-4 border-b border-border">
        <span class="font-bold text-primary">{i18n.t('Examples of dApps')}</span>
      </div>

      <ScrollArea class="flex-1 min-h-0">
        <div class="p-2 space-y-1">
          {#each dappExamples as example (example.id)}
            <button
              onclick={() => activateExample(example)}
              class="w-full text-left p-3 rounded-md hover:bg-secondary transition-colors"
            >
              <div class="flex items-center gap-2">
                <span class="text-base shrink-0">{example.icon}</span>
                <span class="font-medium text-foreground truncate">{i18n.t(example.title)}</span>
                <span class="text-[0.625rem] px-1.5 py-0.5 rounded bg-muted text-muted-foreground shrink-0">
                  {example.kind === 'builtin'
                    ? i18n.t('Built-in')
                    : example.kind === 'external'
                      ? i18n.t('External')
                      : i18n.t('Provider')}
                </span>
              </div>
              <div class="text-xs text-muted-foreground mt-0.5 line-clamp-2">
                {i18n.t(example.subtitle)}
              </div>
            </button>
          {/each}
        </div>
      </ScrollArea>
    </div>

  {:else if dappsState.active === 'communities'}
    <div class="p-3 border-b border-border flex items-center gap-2">
      <!--
        Back to the examples. The section stays the same (`dapps`); only the inner screen
        changes, so this is a return inside the component rather than app navigation.
      -->
      <button
        onclick={() => resetDappsView()}
        class="p-1.5 rounded-md border border-border hover:bg-secondary shrink-0"
        aria-label={i18n.t('Back')}
        title={i18n.t('Back')}
      >
        ←
      </button>
      <div class="flex-1 min-w-0">
        <span class="font-bold text-primary">{i18n.t('Community directory')}</span>
        <p class="text-xs text-muted-foreground mt-1">
          {i18n.t('Addresses come from the provider. Joining is done by Stauri.')}
        </p>
      </div>
      <button
        onclick={() => loadCommunities(true)}
        disabled={communitiesState.isLoading}
        class="text-xs px-2 py-1 rounded-md border border-border hover:bg-secondary disabled:opacity-50 shrink-0"
        aria-label={i18n.t('Refresh')}
        title={i18n.t('Refresh')}
      >
        ⟳
      </button>
    </div>

    <div class="p-2 border-b border-border">
      <input
        bind:value={communitiesState.query}
        placeholder={i18n.t('Search communities')}
        class="w-full h-9 border border-input rounded-md px-3 text-sm bg-background"
      />
    </div>

    <ScrollArea class="flex-1 min-h-0">
      <div class="p-2">
        {#if entries.length === 0}
          <p class="p-4 text-muted-foreground text-sm italic">
            {communitiesState.isLoading ? i18n.t('Loading communities...') : i18n.t('No communities found')}
          </p>
        {:else}
          <div class="space-y-1">
            {#each entries as entry (entry.id)}
              <div>
                <!--
                  A community row. The button expands the tree instead of spectating
                  straight away: the user sees what is inside before anything is written to
                  the status-go database.
                -->
                <button
                  onclick={async () => {
                    toggleExpanded(entry.id);
                    if (!expanded.has(entry.id)) return;
                    // Expanding requires the description: without it there are no channels.
                    if (!entry.loaded) await selectCommunity(entry);
                    else if (!entry.joined && !entry.spectated) await selectCommunity(entry);
                  }}
                  class="w-full text-left p-3 rounded-md hover:bg-secondary transition-colors {communitiesState.selected?.id === entry.id ? 'bg-secondary' : ''}"
                  aria-expanded={expanded.has(entry.id)}
                >
                  <div class="flex items-center gap-2">
                    <span class="shrink-0 text-muted-foreground text-xs">
                      {expanded.has(entry.id) ? '▾' : '▸'}
                    </span>
                    <span class="text-primary text-xs font-bold">◇</span>
                    <span class="font-medium text-foreground truncate">
                      {entry.name || entry.id.slice(0, 12) + '…'}
                    </span>
                    {#if entry.joined}
                      <span class="text-[0.625rem] px-1.5 py-0.5 rounded bg-primary/10 text-primary shrink-0">
                        {i18n.t('Joined')}
                      </span>
                    {/if}
                  </div>
                  <div class="text-xs text-muted-foreground truncate mt-0.5 pl-5">
                    {#if !entry.loaded}
                      {i18n.t('Loading description...')}
                    {:else}
                      {entry.access === 'open'
                        ? i18n.t('Open')
                        : entry.access === 'token'
                          ? i18n.t('Token gated')
                          : i18n.t('By request')}
                      {#if entry.activeMembersCount}
                        · {entry.activeMembersCount} {i18n.t('members')}
                      {/if}
                    {/if}
                  </div>
                </button>

                {#if expanded.has(entry.id) && communitiesState.selected?.id === entry.id}
                  <div class="pl-6 pr-2 pb-2 space-y-1">
                    {#if communitiesState.isBusy}
                      <p class="text-xs text-muted-foreground italic px-2 py-1">
                        {i18n.t('Loading channels...')}
                      </p>
                    {:else if tree.length === 0}
                      <p class="text-xs text-muted-foreground italic px-2 py-1">
                        {i18n.t('No channels')}
                      </p>
                    {:else}
                      {#each tree as group (group.id)}
                        {#if group.name}
                          <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground px-2 pt-1">
                            {group.name}
                          </p>
                        {/if}
                        {#each group.channels as channel (channel.id)}
                          <button
                            onclick={() => handleChannelClick(entry, channel.id)}
                            disabled={communitiesState.isBusy || !channel.canView}
                            class="w-full text-left px-2 py-1.5 rounded-md hover:bg-secondary transition-colors disabled:opacity-50 flex items-center gap-2"
                          >
                            <span class="text-primary text-xs shrink-0">#</span>
                            <span class="text-sm text-foreground truncate">{channel.name}</span>
                            {#if channel.tokenGated}
                              <span class="text-[0.625rem] text-muted-foreground shrink-0">
                                {i18n.t('Token gated')}
                              </span>
                            {:else if !channel.canView}
                              <span class="text-[0.625rem] text-muted-foreground shrink-0">
                                {i18n.t('Hidden until you join')}
                              </span>
                            {:else if !channel.canPost}
                              <span class="text-[0.625rem] text-muted-foreground shrink-0">
                                {i18n.t('Read only')}
                              </span>
                            {/if}
                          </button>
                        {/each}
                      {/each}
                    {/if}

                    {#if channelError}
                      <p class="text-xs text-destructive px-2">{channelError}</p>
                    {/if}

                    <!--
                      Joining is a separate action: without it channels can be read but not
                      written to, and a join request needs a choice of addresses and a
                      password.
                    -->
                    {#if !entry.joined}
                      <button
                        onclick={() => { joining = !joining; }}
                        class="w-full text-left px-2 py-1.5 rounded-md text-xs text-primary hover:bg-secondary transition-colors"
                        aria-expanded={joining}
                      >
                        {joining
                          ? i18n.t('Cancel')
                          : i18n.t('Join community to post') + ' →'}
                      </button>

                      {#if joining}
                        <!--
                          The form prepares itself on mount (addresses and the token gate
                          check); the parent does not need to know its internal state.
                        -->
                        <JoinCommunity onDone={() => { joining = false; }} />
                      {/if}
                    {/if}
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </ScrollArea>

  {:else if dappsState.active === 'feed'}
    <div class="p-3 border-b border-border flex items-center gap-2">
      <!--
        The same return as in the directory: without it the feed can only be left by
        clicking the section icon again. Two back buttons in one component should not behave
        differently.
      -->
      <button
        onclick={() => resetDappsView()}
        class="p-1.5 rounded-md border border-border hover:bg-secondary shrink-0"
        aria-label={i18n.t('Back')}
        title={i18n.t('Back')}
      >
        ←
      </button>
      <div class="flex-1 min-w-0">
        <span class="font-bold text-primary">{i18n.t('Channel feed')}</span>
        <p class="text-xs text-muted-foreground mt-1">
          {i18n.t('Only text is shown. Links open separately and show the full address.')}
        </p>
      </div>
    </div>

    <div class="p-3 border-b border-border space-y-2">
      <div class="flex gap-2">
        <input
          bind:value={dappsState.feedUrl}
          bind:this={feedInput}
          placeholder={i18n.t('RSS/Atom URL or a Telegram link (t.me/...)')}
          onkeydown={(e) => { if (e.key === 'Enter') submitFeed(); }}
          class="flex-1 h-9 border border-input rounded-md px-3 text-sm bg-background"
        />
        <button
          onclick={submitFeed}
          disabled={feedsState.isAdding || !dappsState.feedUrl.trim()}
          class="h-9 px-3 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50 shrink-0"
        >
          {feedsState.isAdding ? i18n.t('Checking...') : i18n.t('Add')}
        </button>
      </div>

      <!--
        The error is the answer "this is not a feed": an HTML page, a 404, a Cloudflare
        interstitial or an empty document. The line below it says what to do next instead of
        merely stating the failure.
      -->
      {#if feedsState.error}
        <p class="text-xs text-destructive">{feedsState.error}</p>
        <p class="text-[0.6875rem] text-muted-foreground">
          {i18n.t('The address must return RSS or Atom, or be a Telegram channel link. Use a feed source such as RSSHub for networks that do not publish one.')}
        </p>
      {/if}

      <!--
        Mirror note: `rsshub.app` no longer serves feeds to programs, so route links taken
        from its catalogue do not work on their own. They are rewritten automatically, but
        the user should see where the request goes — and know that only some routes of the
        mirror are alive.
      -->
      <p class="text-[0.6875rem] text-muted-foreground">
        {i18n.t('RSSHub links (rsshub.app) are sent through a mirror, {mirror}. Telegram channel links are converted to that mirror automatically; some networks need keys and currently fail.', { mirror: RSSHUB_MIRROR })}
      </p>

      <p class="text-[0.6875rem] text-muted-foreground">
        {i18n.t('A working feed is added to the chat list as an external source.')}
      </p>

      <!--
        Examples sit below the field rather than in a tooltip: they are meant to be tried by
        hand, not read. A click fills the field; Enter then adds the feed to the chat list.
      -->
      <div class="pt-2 border-t border-border">
        <p class="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          {i18n.t('TG channels')}
        </p>
        <div class="space-y-0.5">
          {#each TG_CHANNELS as channel (channel)}
            <button
              onclick={() => { dappsState.feedUrl = channel; feedInput?.focus(); }}
              class="block w-full text-left text-[0.6875rem] text-primary hover:underline truncate"
              title={channel}
            >
              {channel}
            </button>
          {/each}
        </div>
      </div>

      <div class="pt-2 border-t border-border">
        <p class="text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground mb-1">
          {i18n.t('RSS examples')}
        </p>
        <div class="space-y-0.5">
          {#each FEED_EXAMPLES as example (example)}
            <button
              onclick={() => { dappsState.feedUrl = example; feedInput?.focus(); }}
              class="block w-full text-left text-[0.6875rem] text-primary hover:underline truncate"
              title={example}
            >
              {example}
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>
