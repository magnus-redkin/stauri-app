<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { formatError } from '$lib/utils/errors';

  // Stores
  import {
    statusState,
    resetState,
    logout,
    setSeedSaved,
    setPendingRequestsCount
  } from '$lib/stores/statusStore.svelte';

  import {
    connectionState,
    connect,
    changeNetwork,
    login,
    createAccount,
    disconnect
  } from '$lib/stores/connectionStore.svelte';

  import { resetContacts, loadContacts } from '$lib/stores/contactsStore.svelte';
  import { getChats } from '$lib/status/messaging';
  import { scenarioLog, short } from '$lib/utils/scenario';
  import { chatsState, loadChats, selectChat, resetChats, setRightPanel } from '$lib/stores/chatsStore.svelte';
  import { loadCommunities, resetCommunities } from '$lib/stores/communitiesStore.svelte';
  import { resetDapps, resetDappsView } from '$lib/stores/dappsStore.svelte';
  import { loadFeeds, resetFeeds } from '$lib/stores/feedsStore.svelte';
  import {
    loadUiPreferences,
    increaseFontSize,
    decreaseFontSize,
    resetFontSize,
  } from '$lib/stores/uiStore.svelte';
  import {
    record as recordNav,
    goBack,
    goForward,
    resetNavigation,
    registerNavigationApplier,
  } from '$lib/stores/navStore.svelte';
  import { dappsState } from '$lib/stores/dappsStore.svelte';
  import { communitiesState } from '$lib/stores/communitiesStore.svelte';
  import {
    walletState,
    loadWallet,
    resetWallet,
    startWalletPolling,
    stopWalletPolling,
    refreshWallet
  } from '$lib/stores/walletStore.svelte';
  import { resetSend } from '$lib/stores/sendStore.svelte';
  import { resetEns } from '$lib/stores/ensStore.svelte';

  // UI
  import { PaneGroup, Pane, PaneResizer } from "paneforge";
  import SidebarIcons from "$lib/sections/layout/SidebarIcons.svelte";
  import MainEntryScreen from "$lib/sections/auth/MainEntryScreen.svelte";
  import RecoveryScreen from '$lib/sections/auth/RecoveryScreen.svelte';

  import HomeMain from "$lib/sections/home/HomeMain.svelte";
  import ProfileLeft from "$lib/sections/profile/ProfileLeft.svelte";
  import EditProfile from "$lib/sections/profile/EditProfile.svelte";
  import CreateSeed from "$lib/sections/profile/CreateSeed.svelte";
  import SettingsLeft from "$lib/sections/settings/SettingsLeft.svelte";
  import SettingsMain from "$lib/sections/settings/SettingsMain.svelte";
  import WalletLeft from "$lib/sections/wallet/WalletLeft.svelte";
  import WalletMain from "$lib/sections/wallet/WalletMain.svelte";
  import MarketMain from "$lib/sections/market/MarketMain.svelte";
  import ChatLeft from "$lib/sections/chat/ChatLeft.svelte";
  import ChatHeaderIcons from "$lib/sections/chat/ChatHeaderIcons.svelte";
  import ChatMain from "$lib/sections/chat/ChatMain.svelte";
  import DappsLeft from "$lib/sections/dapps/DappsLeft.svelte";
  import DappsMain from "$lib/sections/dapps/DappsMain.svelte";
  import SectionPane from "$lib/sections/layout/SectionPane.svelte";
  import MobileShell from "$lib/sections/layout/MobileShell.svelte";


  // Sections do not keep a navigation history yet; the arrows appear once they do.
  let mobileEditProfile = $state(false);
  let mobileWalletAccounts = $state(false);

  const noHistory = { canBack: false, canForward: false, back: () => {}, forward: () => {} };

  const SECTION_TITLES: Record<string, string> = {
    home: 'Home', profile: 'Profile', chat: 'Chat', wallet: 'All accounts',
    dapps: 'dApps', market: 'Market', settings: 'Settings',
  };
  function sectionTitle(id: string): string {
    return SECTION_TITLES[id] ?? '';
  }

  let activeSection = $state('home');
  // Mobile layout uses a single panel and a bottom bar; the breakpoint is window width (≤ 768px).
  let isMobile = $state(false);
  // Which section panel the mobile layout shows: left or right.
  $effect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => (isMobile = mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });
  let showRecovery = $state(false);
  let showCreateSeed = $state(false);

  // Account selected for login.
  let selectedAccountKeyUid = $state('');
  let selectedNetwork = $state('mainnet');

  const hasProfiles = $derived(statusState.accounts.length > 0);

  // Ctrl+Q closes the window.
  $effect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'q') {
        e.preventDefault();
        getCurrentWindow().close();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  });

  /**
   * Global keyboard shortcuts: font scaling and navigation.
   *
   * @remarks
   * The listener runs in the capture phase. The webview surface consumes some
   * combinations before the bubbling phase: without capture `Ctrl+"+"` is sometimes
   * taken by WebKit's built-in zoom, which scales the whole page including scroll
   * instead of only the text. Capture also keeps an overlaid form (such as search)
   * from swallowing navigation, because the event is seen first.
   *
   * Tauri's `zoom_hotkeys_enabled` is deliberately not used: built-in zoom scales the
   * whole viewport, including `rem` and `px` field sizes, while what is needed is text
   * size, which Settings already controls with a slider. Two mechanisms would
   * disagree, so `uiStore` is the only source of scale.
   */
  $effect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Ctrl+"+", Ctrl+"-", Ctrl+0. Keys are matched by both `code` and `key`:
      // layouts differ, and "+" arrives as `=` (without Shift), `+`, `Equal` or
      // `NumpadAdd`, so every spelling is checked.
      if (mod && !e.altKey) {
        const key = e.key;
        const code = e.code;
        if (key === '+' || key === '=' || code === 'NumpadAdd' || code === 'Equal') {
          e.preventDefault();
          increaseFontSize();
          return;
        }
        if (key === '-' || key === '_' || code === 'NumpadSubtract' || code === 'Minus') {
          e.preventDefault();
          decreaseFontSize();
          return;
        }
        if (key === '0' || code === 'Digit0' || code === 'Numpad0') {
          e.preventDefault();
          resetFontSize();
          return;
        }
      }

      // Alt+Left / Alt+Right navigate back and forward.
      if (e.altKey && !mod && !e.shiftKey) {
        if (e.key === 'ArrowLeft') {
          e.preventDefault();
          goBack();
          return;
        }
        if (e.key === 'ArrowRight') {
          e.preventDefault();
          goForward();
        }
      }
    };

    window.addEventListener('keydown', handleShortcut, { capture: true });
    return () => window.removeEventListener('keydown', handleShortcut, { capture: true });
  });

  /**
   * Applies a navigation history snapshot.
   *
   * @param snap - Snapshot to restore.
   *
   * @remarks
   * Registered before the first `record` so that stepping back right after startup
   * is not empty. Every field is assigned explicitly: the snapshot is complete, and a
   * partial restore could leave, for example, a community open while switching to
   * another section.
   */
  registerNavigationApplier((snap) => {
    showRecovery = snap.showRecovery;
    showCreateSeed = snap.showCreateSeed;
    dappsState.active = (snap.dappView as typeof dappsState.active) ?? null;

    // The community is looked up in the catalogue; the object is restored, not the id.
    communitiesState.selected = snap.communityId
      ? communitiesState.entries.find((e) => e.id === snap.communityId) ?? null
      : null;

    selectChat(snap.chatId ?? '');
    activeSection = snap.section;
  });

  /**
   * Records navigation history.
   *
   * @remarks
   * Key states are watched instead of calling `record` at every navigation site:
   * a call is easy to forget, while the effect sees every change, whether it came
   * from a click, a link or a shortcut.
   *
   * `untrack` is needed because `record` itself writes `navState`, and reading
   * `canBack`/`canForward` in the template must not close the effect back on itself.
   */
  $effect(() => {
    const section = activeSection;
    const chatId = chatsState.selected?.id ?? null;
    const dappView = dappsState.active;
    const communityId = communitiesState.selected?.id ?? null;
    const recovery = showRecovery;
    const createSeed = showCreateSeed;

    // Records only while signed in: the login screen is not a place a shortcut should
    // return to.
    if (!statusState.isLoggedIn) return;

    untrack(() => {
      recordNav({
        section,
        chatId,
        dappView,
        communityId,
        showRecovery: recovery,
        showCreateSeed: createSeed,
      });
    });
  });

  /**
   * Loads the chat list when entering the Chat section.
   *
   * @remarks
   * `untrack` around the call is required: `loadChats` writes `chatsState`
   * (`loaded`, `isLoading`), so without it the effect would restart itself.
   */
  $effect(() => {
    const section = activeSection;
    const loggedIn = statusState.isLoggedIn;
    if (section === 'chat' && loggedIn) {
      untrack(() => {
        // Entering the section opens contact search on the right; otherwise the
        // previous screen (invite, new channel) stays, and the search form is out of
        // sight.
        if (!chatsState.selected) setRightPanel('contacts');
        loadChats();
      });
    }
  });

  /**
   * Polls contacts and chat activity while the Chat section is open.
   *
   * @remarks
   * Contact requests and their acceptance arrive without a signal the app reads (on
   * Android there are no signals at all), so contacts are reread every 10 s and the
   * chat list is refreshed when the number of requests changes. Without this a new
   * request would only appear after switching sections.
   */
  $effect(() => {
    const section = activeSection;
    const loggedIn = statusState.isLoggedIn;
    if (section !== 'chat' || !loggedIn) return;
    // Per-chat state: last message time, unread count, activity. The first pass only
    // records the baseline, otherwise every chat would count as new.
    const seen = new Map<string, string>();
    let baseline = false;
    const tick = () => untrack(async () => {
      const port = statusState.backendPort;
      if (!port) return;
      await loadContacts(true);
      const chats = await getChats(port);
      const changed: string[] = [];
      for (const c of chats) {
        const sig = `${c.lastMessage?.timestamp ?? 0}:${c.unviewedMessagesCount ?? 0}:${c.active}`;
        if (seen.get(c.id) !== sig) {
          if (baseline) changed.push(c.id);
          seen.set(c.id, sig);
        }
      }
      baseline = true;
      // A new chat (request, first message) is not visible in the list yet, and the
      // signal effect will not reread it: the list is reread here.
      const visible = new Set(chatsState.items.map((c) => c.id));
      if (changed.some((id) => !visible.has(id))) await loadChats(true);
      if (changed.length) {
        scenarioLog('reply-sync', 'poll-changed', { count: changed.length, chat: short(changed[0]) });
        // Same path as the messages.new signal: the chat list and the open
        // conversation are reread by effects that are already running.
        for (const id of changed) statusState.pendingChatIds.add(id);
        statusState.lastMessageSignal++;
      }
    });
    tick();
    const id = setInterval(tick, 10_000);
    return () => clearInterval(id);
  });

  /**
   * Reloads the chat list when new messages arrive (`lastMessageSignal`).
   *
   * @remarks
   * `untrack` is required: `loadChats` reads and writes `chatsState` (`loaded`,
   * `isLoading`), and an effect that reads state it also changes restarts itself.
   *
   * Dependencies are declared explicitly: the signal number and the active section.
   */
  $effect(() => {
    const signal = statusState.lastMessageSignal;
    const section = activeSection;
    if (signal > 0 && section === 'chat') {
      untrack(() => {
        // Reread the list only if the message arrived in a chat visible in it.
        // Messages from channels no longer shown arrive constantly, and without this
        // check each one would trigger a full load (wakuext_communities ~1.6 MB),
        // which produced reloads roughly every 30 seconds.
        const visible = new Set(chatsState.items.map((c) => c.id));
        const ids = [...statusState.pendingChatIds];
        const touched = ids.some((id) => visible.has(id));
        // Remove only what was checked here: the open feed reads the same set, and a
        // full clear would take its chat away from it.
        for (const id of ids) if (visible.has(id)) statusState.pendingChatIds.delete(id);
        if (touched) loadChats(true);
      });
    }
  });

  /**
   * Loads the community catalogue when entering the dApps section.
   *
   * @remarks
   * The catalogue is read from a smart contract and may not have changed, so it is
   * loaded once per session (`loaded`), without force.
   */
  $effect(() => {
    const section = activeSection;
    const loggedIn = statusState.isLoggedIn;
    if (section === 'dapps' && loggedIn) {
      untrack(() => { loadCommunities(); });
    }
  });

  // Clears the seed creation screen when leaving Profile.
  $effect(() => {
    if (activeSection !== 'profile') {
      showCreateSeed = false;
    }
  });


  /**
   * Keeps wallet balances fresh while the Wallet section is open.
   *
   * @remarks
   * `fetchOrGetCachedWalletBalances` reads the backend cache and ignores
   * `forceRefresh`, so balances have to be reread periodically.
   */
  $effect(() => {
    if (statusState.isLoggedIn && activeSection === 'wallet') {
      loadWallet();
      startWalletPolling();
      return () => stopWalletPolling();
    }
    stopWalletPolling();
  });

  onMount(async () => {
    // Display preferences are applied first, otherwise the interface flashes at the
    // default size even though the user chose another.
    loadUiPreferences();

    // External feed subscriptions and channel flags are read right away: the chat
    // list needs them, not only the dApp section. A read error must not block
    // connecting; a corrupted store is left with an empty list.
    loadFeeds();
    await connect(undefined);
    if (statusState.accounts.length > 0) {
      selectedAccountKeyUid = statusState.accounts[0]["key-uid"];
    }
  });

  async function handleNetworkChange(network: string) {
    await changeNetwork(network);
    selectedNetwork = network;

    // A network switch means a different data directory, and therefore a different
    // set of profiles. A key selected on the previous network does not exist in the
    // new database, and signing in with it fails while reading `kdfIterations`:
    //   failed to get account kdf iterations number: sql: no rows in result set
    // (`GetAccountKDFIterationsNumber` looks up a row by keyUid in accounts.sql).
    selectedAccountKeyUid = statusState.accounts[0]?.['key-uid'] ?? '';
  }

  async function handleLogin(password: string) {
    if (!selectedAccountKeyUid) return;

    // Guards against a stale key: signing in with a key from another profile fails
    // while reading `kdfIterations` ("sql: no rows in result set"), and the message
    // explains nothing to the user. If the key is missing from the current set, the
    // network or the profile data changed; the first available key is used instead of
    // sending a foreign one to the backend.
    const known = statusState.accounts.some(
      (a: any) => a?.['key-uid'] === selectedAccountKeyUid
    );
    if (!known) {
      selectedAccountKeyUid = statusState.accounts[0]?.['key-uid'] ?? '';
      if (!selectedAccountKeyUid) {
        statusState.errorMsg = 'Login failed: no profile found in this network';
        return;
      }
    }

    try {
      await login(password, selectedAccountKeyUid);
      activeSection = 'home';
    } catch (e: any) {
      statusState.errorMsg = `Login failed: ${formatError(e)}`;
    }
  }

  async function handleCreateAccount(password: string) {
    try {
      await createAccount(password);
      // After creation the account signs in automatically (through waitForLogin).
      if (statusState.accounts.length > 0) {
        selectedAccountKeyUid = statusState.accounts[0]["key-uid"];
      }
      activeSection = 'home';
    } catch (e: any) {
      statusState.errorMsg = `Create account failed: ${formatError(e)}`;
    }
  }

  function handleOpenChat(chatId: string) {
    activeSection = 'chat';
    selectChat(chatId);
  }

  /**
   * Opens profile editing: replaces the list on a narrow screen, sits on the right
   * on a wide one.
   */
  function openEditProfile() {
    activeSection = 'profile';
    showCreateSeed = false;
    mobileEditProfile = true;
  }

  /**
   * Handles a click on an icon in the left rail.
   *
   * @param id - Section id.
   *
   * @remarks
   * Two cases behave differently: switching to another section is ordinary
   * navigation and needs no reset, while a repeated click on the already active tab
   * means "take me back to the start". `activeSection` does not change in that case,
   * so effects watching it do not fire and the reset is done explicitly. For dApps
   * that reset returns to the sample list; without it there was no way out of an
   * open community catalogue except the refresh button.
   */
  function handleSectionSelect(id: string) {
    // A section reopens at its first screen.
    mobileEditProfile = false;
    mobileWalletAccounts = false;
    // Chat always opens on search on the right, even if the section is already open
    // (otherwise an invite or another form stays). An open chat is left untouched.
    if (id === 'chat' && !chatsState.selected) setRightPanel('contacts');
    if (id !== activeSection) return;
    if (id === 'dapps') resetDappsView();
  }

  async function handleDisconnect() {
    await logout();
    await disconnect();
    resetState();
    resetContacts();
    resetChats();
    resetCommunities();
    resetDapps();
    resetWallet();
    // The password for signing transfers lives in session memory and must be erased
    // on sign-out, otherwise the next profile on this machine inherits the previous
    // one's password in tab memory.
    resetSend();
    // Name registration state belongs to the profile: a foreign name in the field and
    // a foreign owner on screen must not be shown after an account switch.
    resetEns();
    // Navigation history belongs to the profile: returning to the previous account's
    // chats is impossible, and following a foreign history would show empty screens.
    resetNavigation();
    // The seed phrase lives in Rust memory and used to be cleared only by the seed
    // creation screen's `onDestroy`. On sign-out it stayed there until the app closed,
    // so the next profile on this machine could get it, and under XSS it was reachable
    // through `seed_word`.
    invoke('clear_seed').catch(() => {});
    setPendingRequestsCount(0);
    showCreateSeed = false;
    selectedAccountKeyUid = '';
    activeSection = 'home';
    await connect(undefined);
    if (statusState.accounts.length > 0) {
      selectedAccountKeyUid = statusState.accounts[0]["key-uid"];
    }
  }
</script>

    {#snippet chatActions()}
      <ChatHeaderIcons />
    {/snippet}

    {#snippet profileActions()}
      <button
        type="button"
        onclick={() => (mobileEditProfile = !mobileEditProfile)}
        class="h-11 w-11 rounded-md bg-card flex items-center justify-center"
 aria-label="Edit profile"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
    {/snippet}

    {#snippet walletActions()}
      <button
 type="button"
        onclick={() => refreshWallet()}
 disabled={walletState.isRefreshing}
 class="h-11 w-11 rounded-md bg-card flex items-center justify-center disabled:opacity-50"
        aria-label="Refresh"
      >
        <span class={walletState.isRefreshing ? 'inline-block animate-spin' : 'inline-block'}>🔄</span>
      </button>
      <button
 type="button"
        onclick={() => (mobileWalletAccounts = !mobileWalletAccounts)}
        class="h-11 w-11 rounded-md bg-card flex items-center justify-center"
        aria-label="Edit account"
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
      </button>
    {/snippet}

    {#snippet mobileContent()}
      {#if activeSection === 'chat'}
        {#if chatsState.selected || chatsState.rightPanel !== 'chat'}
          {@render rightPane()}
 {:else}
          {@render leftPane()}
 {/if}
      {:else if activeSection === 'profile' || activeSection === 'home'}
        {#if mobileEditProfile}
   <EditProfile onNavigate={(s) => { mobileEditProfile = false; activeSection = s; }} />
        {:else}
          {@render leftPane()}
        {/if}
      {:else if activeSection === 'wallet' && mobileWalletAccounts}
        <WalletLeft />
      {:else}
 {@render rightPane()}
      {/if}
    {/snippet}

    {#snippet leftPane()}
      <SectionPane>
        {#if activeSection === 'home' || activeSection === 'profile'}
   <ProfileLeft
     onDisconnect={handleDisconnect}
     onCreateSeed={() => { activeSection = 'profile'; showCreateSeed = true; }}
     onEditProfile={openEditProfile}
          />
        {:else if activeSection === 'settings'}
          <SettingsLeft />
        {:else if activeSection === 'wallet'}
   <WalletLeft />
        {:else if activeSection === 'chat'}
                 <ChatLeft compact={isMobile} onSelectChat={(chat) => selectChat(chat.id)} />
 {:else if activeSection === 'dapps'}
   <DappsLeft />
        {:else}
   <ProfileLeft
     onDisconnect={handleDisconnect}
     onCreateSeed={() => { activeSection = 'profile'; showCreateSeed = true; }}
     onEditProfile={openEditProfile}
   />
 {/if}
      </SectionPane>
    {/snippet}

    {#snippet rightPane()}
      <SectionPane>
 {#if activeSection === 'home'}
   <HomeMain onNavigate={(s) => activeSection = s} />
        {:else if activeSection === 'profile'}
          {#if showCreateSeed}
     <CreateSeed
       onBack={() => showCreateSeed = false}
onSave={() => {
         setSeedSaved(true);
  showCreateSeed = false;
       }}
            />
          {:else}
            <EditProfile onNavigate={(s) => activeSection = s} />
   {/if}
        {:else if activeSection === 'settings'}
          <SettingsMain />
        {:else if activeSection === 'wallet'}
   <WalletMain compact={isMobile} />
        {:else if activeSection === 'market'}
          <MarketMain />
 {:else if activeSection === 'chat'}
          <ChatMain />
 {:else if activeSection === 'dapps'}
          <DappsMain onOpenChat={handleOpenChat} />
 {:else}
          <HomeMain onNavigate={(s) => activeSection = s} />
        {/if}
      </SectionPane>
    {/snippet}

<div class="min-h-screen bg-background">
  <!-- Testnet banner -->
  {#if statusState.isTestnet}
    <div class="bg-orange-500 text-white text-center py-2 px-4 font-semibold text-sm">
      ⚠️ {statusState.networkName.toUpperCase()} TESTNET MODE — All balances and transactions are on testnets.
    </div>
  {/if}

  <!-- Spinner -->
  {#if connectionState.isConnecting}
    <div class="flex flex-col items-center justify-center min-h-screen gap-4">
      <div class="w-10 h-10 border-4 border-muted border-t-primary rounded-full animate-spin"></div>
      <h2 class="text-2xl font-semibold text-foreground">Connecting...</h2>
    </div>

  <!-- Login screen -->
  {:else if !statusState.isLoggedIn}
    {#if showRecovery}
      <RecoveryScreen
        onBack={() => showRecovery = false}
        onLogin={() => {
          alert("Recovery not implemented yet.");
          showRecovery = false;
        }}
      />
    {:else}
      <MainEntryScreen
        onLogin={handleLogin}
        onCreate={handleCreateAccount}
        onRecovery={() => showRecovery = true}
        onNetworkChange={handleNetworkChange}
        {hasProfiles}
        bind:selectedAccountKeyUid
        bind:selectedNetwork
      />
    {/if}

  <!-- Main interface -->
  {:else}
    {#if isMobile}
      <MobileShell
 bind:activeSection
        onSelect={handleSectionSelect}
        content={mobileContent}
 actions={activeSection === 'chat' ? chatActions : activeSection === 'wallet' ? walletActions : activeSection === 'profile' ? profileActions : undefined}
 title={sectionTitle(activeSection)}
 history={noHistory}
      />
    {:else}
    <div class="flex h-screen overflow-hidden">
      <SidebarIcons bind:activeSection onSelect={handleSectionSelect} />

      <PaneGroup direction="horizontal" class="h-full w-full">
        <!--
          Panels scroll themselves, not each section separately.

          `SectionPane` gives both panels a definite height and outer scrolling.
          Sections that have their own scrolling (chat list, wallet) take exactly the
          panel height, so the outer one never appears. A section without its own
          scrolling that grows longer than the panel gets it here, and no new section
          has to check this.
        -->
        <Pane defaultSize={30} minSize={20} class="h-full overflow-hidden border-r border-border">
   {@render leftPane()}
        </Pane>

        <PaneResizer class="w-1 bg-border hover:bg-primary transition-colors cursor-col-resize" />

        <Pane defaultSize={70} class="h-full overflow-hidden bg-card">
   {@render rightPane()}
        </Pane>
      </PaneGroup>
    </div>
    {/if}
  {/if}
</div>
