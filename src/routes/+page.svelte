<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { info } from '$lib/utils/log';
  import { formatError } from '$lib/utils/errors';
  import { i18n } from '$lib/i18n';

  // Stores
  import {
    statusState,
    resetState,
    logout,
    setSeedSaved,
    setPendingRequestsCount,
    setAccounts
  } from '$lib/stores/statusStore.svelte';

  import {
    connectionState,
    connect,
    changeNetwork,
    login,
    createAccount,
    restoreAccount,
    resetLocalProfileAndRestore,
    disconnect
  } from '$lib/stores/connectionStore.svelte';

  import { contactsState, resetContacts, loadContacts, mergeContacts } from '$lib/stores/contactsStore.svelte';
  import { getChats } from '$lib/status/messaging';
  import { scenarioLog, short } from '$lib/utils/scenario';
  import { chatsState, loadChats, selectChat, resetChats, setRightPanel, applyContacts, mergeSignalContacts } from '$lib/stores/chatsStore.svelte';
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
  import {
    ensureProfileAvatar,
    setProfileAvatar,
    setSessionPassword,
    clearSessionPassword,
    getSessionPassword,
  } from '$lib/stores/profileStore.svelte';

  // UI
  import { PaneGroup, Pane, PaneResizer } from "paneforge";
  import SidebarIcons from "$lib/sections/layout/SidebarIcons.svelte";
  import RecoveryScreen from '$lib/sections/auth/RecoveryScreen.svelte';
  import MobileEntryScreen from '$lib/sections/auth/MobileEntryScreen.svelte';
  import PinPad from '$lib/sections/auth/PinPad.svelte';
  import { isAndroid } from '$lib/utils/platform';
  import type {
    EntryContext,
    EntryPhase,
    Network,
    ProfileSummary,
  } from '$lib/entry/entryFlow';
  import { initialPhase, phaseAfterPinLookup, pinProblem } from '$lib/entry/entryFlow';
  import { deleteProfile, initializeApplication } from '$lib/status/api';
  import {
    credentialsAvailable,
    forgetPendingPin,
    generatePassword,
    openPin,
    pinState,
    savePin,
    savePinFromPending,
  } from '$lib/status/credentials';
  import {
    lanCancel,
    lanConfirm,
    lanLocalAddress,
    lanReceiveStart,
    lanSendStart,
    lanStatus,
    pairingAvailable,
    type LanStatus,
  } from '$lib/status/pairing';
  import PairingScreen from '$lib/sections/auth/PairingScreen.svelte';

  import HomeMain from "$lib/sections/home/HomeMain.svelte";
  import HomeLeft from "$lib/sections/home/HomeLeft.svelte";
  import type { TopicId } from "$lib/sections/home/homeTopics";
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
  // Open topic of the About menu on Home; the right panel follows it.
  // null: Home shows only the two main buttons.
  let homeTopic = $state<TopicId | null>(null);
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
  /**
   * How many profiles this device has for the selected network.
   *
   * @remarks
   * One profile means the list is a screen with a single item and a row of Back buttons
   * that lead nowhere: the PIN is asked for straight away instead.
   */
  const profileCount = $derived(statusState.accounts.length);

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
   * Loads the profile picture after login.
   *
   * @remarks
   * The left column shows the picture in every section, not only in the profile, so it
   * has to be fetched once a profile is open. `ensureProfileAvatar` is idempotent and
   * keeps the result in one store, which is what makes an upload visible in both panes.
   *
   * `untrack` is required: the call writes `profileAvatarState`, and an effect that
   * reads state it also changes would restart itself.
   */
  $effect(() => {
    const loggedIn = statusState.isLoggedIn;
    if (!loggedIn) return;
    untrack(() => {
      ensureProfileAvatar();
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
      if (!statusState.backendRunning) return;
      await loadContacts(true);
      // Names in the list come from the contacts, and a contact update from the
      // other side changes them without touching any chat record. Rebuilding the
      // list from the fresh contacts shows the new name without a reload.
      applyContacts(contactsState.items);
      const chats = await getChats();
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
   * Applies contact records that arrived inside a `messages.new` signal.
   *
   * @remarks
   * A rename by the other side is a contact update, and status-go ships the changed
   * record with the signal (`event.contacts`). Applying it here is what makes the new
   * name appear at once, in every section: before this it waited for the 10-second poll,
   * and the user saw the old name in the chat list and in the open conversation.
   *
   * The queue is read and emptied inside `untrack`: the merge writes `contactsState` and
   * `chatsState`, and an effect that reads state it changes restarts itself.
   */
  $effect(() => {
    if (statusState.pendingContactUpdates.length === 0) return;
    untrack(() => {
      const incoming = statusState.pendingContactUpdates;
      statusState.pendingContactUpdates = [];
      mergeContacts(incoming);
      mergeSignalContacts(incoming);
      scenarioLog('reply-sync', 'contact-signal', { count: incoming.length });
    });
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
    info('[boot] +page onMount');
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
    // Every platform starts on the same flow: whether a profile has a PIN decides what
    // the next step is, and that question is asked of the backend either way.
    await startEntryFlow();
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

  /**
   * Opens or restores a profile from its seed phrase.
   *
   * Errors are rethrown: the recovery screen shows them next to the button, so
   * a wrong word or a rejected phrase is not hidden behind a generic message. A
   * `LocalProfileLockedError` is one of them — it is what turns on the screen's offer
   * to drop the local copy, so it must reach it unchanged.
   *
   * @param mnemonic - Twelve words in order.
   * @param password - Password for the local database.
   */
  async function handleRestoreAccount(mnemonic: string, password: string): Promise<void> {
    info('[boot] handleRestoreAccount called');
    const outcome = await restoreAccount(mnemonic, password);
    info(`[boot] handleRestoreAccount: ${outcome}`);
    finishSignInUi(password);
  }

  /**
   * Removes the local copy of the profile and restores it from the phrase.
   *
   * Reached only from the recovery screen's confirmation block, after it saw the
   * local profile refuse the password. The message history and settings of this
   * device are gone afterwards; wallet and profile return from the phrase.
   *
   * @param mnemonic - Twelve words in order.
   * @param password - New password for the fresh local database.
   */
  async function handleResetProfile(mnemonic: string, password: string): Promise<void> {
    info('[boot] handleResetProfile called');
    const outcome = await resetLocalProfileAndRestore(mnemonic, password);
    info(`[boot] handleResetProfile: ${outcome}`);
    finishSignInUi(password);
  }

  /**
   * Shared tail of both restore paths: select the profile and leave the auth screens.
   *
   * The selected key comes from the signed-in profile rather than from the list:
   * after a reset the list is rewritten, and its first entry is not necessarily the
   * one just restored.
   *
   * @param password - Password of this session, kept for the profile screen.
   */
  function finishSignInUi(password: string): void {
    selectedAccountKeyUid =
      statusState.accountKeyUid || statusState.accounts[0]?.['key-uid'] || '';
    // Same reason as in handleLogin: the user remembers the phrase, not the password.
    setSessionPassword(password);
    showRecovery = false;
    // The sign-in is over, so no screen that belongs to it may survive it. Without this,
    // a restored profile landed on whatever the profile section was showing — including
    // the editor, which is not a place to arrive at after typing twelve words.
    mobileEditProfile = false;
    mobileSendProfile = false;
    showCreateSeed = false;
    activeSection = 'home';
  }

  // ---------------------------------------------------------------------------
  // Mobile entry flow
  // ---------------------------------------------------------------------------
  //
  // One flow on both platforms: the password is generated and protected by a PIN the
  // user chooses. See `$lib/entry/entryFlow` for the rules.

  let entryPhase = $state<EntryPhase>({ kind: 'login' });
  let entrySelected = $state<ProfileSummary | null>(null);
  /** Digits on the PIN pad. Cleared after every submit and on leaving the pad. */
  let entryPin = $state('');
  /**
   * First entry while choosing a new PIN.
   *
   * The PIN encrypts the profile password, so a typo cannot be undone: the second entry is
   * what catches it. Kept here rather than in the pad, so the pad stays a dumb keypad.
   */
  let entryPinFirst = $state('');
  /**
   * Whether the PIN being chosen converts an old profile rather than creating a new one.
   *
   * @remarks
   * A profile from before this scheme has no envelope, and the password it was opened with
   * is the only thing that can create one. The phrase is already saved for such a profile,
   * so the seed screen is not shown again — only the PIN is added.
   */
  let pinUpgrade = $state(false);
  /**
   * Password for a profile that is about to be created.
   *
   * @remarks
   * Generated before the PIN pad and used only after the PIN is confirmed: the account
   * must not exist until there is a PIN to open it with.
   */
  let entryCreatePassword = $state('');
  /**
   * Whether the PIN being chosen wraps a password that arrived over pairing.
   *
   * @remarks
   * The password is not in the phase: it stayed on the Rust side when the transfer
   * finished, and `savePinFromPending` is what turns it into an envelope. This flag only
   * says which call to make — and, on leaving the screen, which password to forget.
   */
  let pendingPin = $state(false);
  /** Whether the pad is asking for the repeat of a new PIN. */
  const pinConfirming = $derived(
    (entryPhase.kind === 'set-pin' || entryPhase.kind === 'create-pin') && entryPinFirst !== ''
  );
  /** PIN bounds, read from the backend so the interface cannot drift from it. */
  let pinMin = $state(4);
  let pinMax = $state(12);
  let entryBusy = $state(false);
  let entryError = $state('');
  /** Whether this build keeps PINs at all; read once at start. */
  let canStorePin = $state(false);
  /**
   * Whether the session is locked because the application went to the background.
   *
   * @remarks
   * Android keeps the process alive when the user leaves the app, so coming back used to
   * return straight to the last screen with the profile open — the PIN protected the
   * database at start and nothing after that. A messenger on a phone that anyone can pick
   * up needs the other half: leaving locks the session, and coming back asks for the PIN.
   */
  let appLocked = $state(false);
  /** Digits on the lock screen. Separate from the entry pad: the flow is not running. */
  let lockPin = $state('');
  let lockError = $state('');
  let lockBusy = $state(false);
  /**
   * Whether the profile currently signed in has a PIN.
   *
   * @remarks
   * Set when a session is opened through the PIN pad. A profile from before the scheme has
   * no PIN, and locking it behind a pad would make it unopenable — that one keeps the old
   * behaviour of staying open.
   */
  let sessionHasPin = $state(false);
  /** Profile and network of the locked session, needed to verify the PIN. */
  let lockedKeyUid = $state('');
  let lockedNetwork = $state<Network>('mainnet');
  /**
   * When the session last became unlocked.
   *
   * @remarks
   * Dismissing the soft keyboard fires `blur`, and that happens right after the PIN is
   * accepted — the pad closes, the keyboard goes away, the window loses focus for an
   * instant. Locking on that event asked for the PIN a second time, immediately after a
   * correct one. The guard only applies while the page is still visible: a real
   * backgrounding reports `hidden` and locks at once, grace period or not.
   */
  let unlockedAt = 0;
  /**
   * Holds the interface on screen for a moment after a successful login.
   *
   * @remarks
   * On the first start after an update the backend may stop and come back while it
   * migrates, and `isLoggedIn` dips to `false` in between. Without this the entry flow —
   * and with it the PIN pad — appeared for a moment after a perfectly good login. The
   * flag is cleared by a timer, and immediately on an explicit logout.
   */
  let loginGrace = $state(false);
  /**
   * Whether a profile is open in this window.
   *
   * @remarks
   * `statusState.isLoggedIn` follows the backend, and the backend can stop and come back
   * while it migrates — on the first start after an update, for instance. Rendering the
   * entry flow from that flag alone flashed the PIN pad after a perfectly good login.
   * This one only changes when a session really opens or closes.
   */
  let sessionOpen = $state(false);

  /**
   * How long a `blur` after an unlock is ignored, in milliseconds.
   *
   * @remarks
   * Long enough to cover dismissing the keyboard and the window settling, short enough
   * that a real glance away still locks. Backgrounding does not rely on this at all.
   */
  const BLUR_GRACE_MS = 1500;

  /** Network of the entry flow, in the storage vocabulary (`mainnet`/`testnet`). */
  let entryNetwork = $state<Network>('mainnet');

  // Pairing state, shared by both entry points: the receiving screen in the entry flow
  // and the sending screen opened from the profile section.
  /** Which side of the transfer this device is on. */
  let pairingRole = $state<'sender' | 'receiver'>('receiver');
  /** Where the attempt is; the screen renders this and nothing else. */
  let pairingPhase = $state<'idle' | 'waiting' | 'codes' | 'transferring' | 'done' | 'failed'>(
    'idle'
  );
  /**
   * Six digits both devices compare.
   *
   * @remarks
   * Derived on the Rust side from a one-time exchange between the two devices, so an
   * attacker relaying between them ends up with different digits on each screen. The
   * digits are never typed anywhere; two people look at them.
   */
  let pairingDigits = $state('');
  let pairingError = $state('');
  /** Display name of the profile that arrived, for the PIN screen. */
  let pairingProfileName = $state<string | undefined>(undefined);
  /**
   * This device's address while it waits as the receiver.
   *
   * @remarks
   * Shown so it can be typed on the other device when the broadcast search finds
   * nothing — the usual case behind a router that drops broadcast but allows unicast.
   */
  let pairingLocalAddress = $state('');
  /**
   * Whether Sync was pressed on this device.
   *
   * @remarks
   * The transfer starts only when both sides have pressed, so the sending side waits
   * after its own press. Without this the button simply sat there and looked broken.
   */
  let pairingConfirmed = $state(false);
  /** Poll handle while an attempt is running. */
  let pairingTimer: ReturnType<typeof setInterval> | null = null;

  /** Stops polling the transfer. */
  function stopPairingPolling(): void {
    if (pairingTimer !== null) {
      clearInterval(pairingTimer);
      pairingTimer = null;
    }
  }

  /**
   * Starts polling the transfer.
   *
   * @remarks
   * A transfer is one long operation on the Rust side: discovery, a handshake, a human
   * comparison and then status-go's own server. Polling a small value keeps the screen
   * stateless and survives a reload of the page; an event stream would have to be kept in
   * step with the screen's lifecycle for no gain.
   */
  function startPairingPolling(): void {
    stopPairingPolling();
    pairingTimer = setInterval(() => {
      void lanStatus()
        .then(applyPairingStatus)
        .catch((e) => {
          stopPairingPolling();
          pairingPhase = 'failed';
          pairingError = formatError(e);
        });
    }, 500);
  }

  /** Folds one status answer into the page. */
  async function applyPairingStatus(next: LanStatus): Promise<void> {
    pairingDigits = next.digits ?? '';
    if (next.error) pairingError = next.error;
    if (next.phase !== 'codes') pairingConfirmed = false;
    if (next.phase === 'done') {
      stopPairingPolling();
      await finishPairing(next);
      return;
    }
    if (next.phase === 'failed' || next.phase === 'idle') stopPairingPolling();
    pairingPhase = next.phase;
  }

  /**
   * Leaves the pairing screen once the transfer ended.
   *
   * @remarks
   * The receiver is the one that ends up with a new profile, so it is where the PIN
   * appears: status-go ships the sender's password inside the payload, and the screen
   * wraps it under a PIN the user chooses. A password that arrived but is not wrapped
   * would leave a profile nobody can open once this screen is gone.
   */
  async function finishPairing(next: LanStatus): Promise<void> {
    await lanCancel().catch(() => undefined);
    pairingPhase = 'idle';
    pairingDigits = '';
    if (pairingRole === 'sender') {
      mobileSendProfile = false;
      activeSection = 'home';
      return;
    }
    const keyUid = next.key_uid ?? '';
    pairingProfileName = next.name ?? undefined;
    await reloadAccounts();
    entryPin = '';
    entryPinFirst = '';
    pendingPin = true;
    entryPhase = {
      kind: 'set-pin',
      profile: { keyUid, name: pairingProfileName },
    };
  }
  /** Whether the sender is being asked for its PIN before it shows a code. */
  let pairingPin = $state('');
  let pairingPinError = $state('');
  /**
   * Whether the message history travels with the profile.
   *
   * @remarks
   * Off by default. status-go sends the whole message database with no date window, and
   * its own source calls that a privacy decision the user has to make deliberately.
   */
  let pairingSyncHistory = $state(true);
  /** Whether the sending screen replaces the profile section. */
  let mobileSendProfile = $state(false);

  /**
   * Device type reported to the other side, as status-go records it.
   *
   * @returns `android` on the phone, otherwise the desktop OS name.
   * @remarks
   * The two vocabularies differ (`macos` rather than `mac`, `linux` rather than
   * `Linux`), and status-go stores it verbatim in the paired installation, so the value
   * is spelled the way the library expects.
   */
  function pairingDeviceType(): string {
    if (isAndroid()) return 'android';
    const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
    if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
    if (/Windows/i.test(ua)) return 'windows';
    return 'linux';
  }

  /**
   * Reloads the profile list from the backend.
   *
   * @remarks
   * Needed after a pairing transfer: the receiving device has a profile it did not have
   * a moment ago, and `InitializeApplication` is what reads the account table. Without
   * this the PIN screen would name a profile the rest of the application does not know.
   */
  async function reloadAccounts(): Promise<void> {
    try {
      const initData = await initializeApplication(
        statusState.backendDataDir,
        statusState.chainId
      );
      setAccounts(initData?.accounts ?? []);
    } catch (e) {
      pairingError = formatError(e);
    }
  }

  /**
   * Context the flow rules read.
   *
   * Built here rather than passed around: the rules are pure and the page owns the
   * mutable state they describe.
   */
  function entryContext(): EntryContext {
    return {
      network: entryNetwork,
      profiles: statusState.accounts.map((a: any) => ({
        keyUid: a['key-uid'],
        name: a.name || a.alias || undefined,
      })),
      canStorePin,
    };
  }

  /** Recomputes the phase after the profile list changes. */
  function syncEntryPhase(): void {
    entryPhase = initialPhase(entryContext());
  }

  /** Starts the entry flow: reads what this build can do, then asks what to show. */
  async function startEntryFlow(): Promise<void> {
    canStorePin = await credentialsAvailable();
    // The flow starts on whatever network the backend actually came up on. Assuming
    // `mainnet` would ask for a PIN in a slot the profile was never stored in, and the
    // profile would look like it had none.
    entryNetwork = statusState.isTestnet ? 'testnet' : 'mainnet';
    syncEntryPhase();
    // A single profile needs no choice: asking which one it is, only to answer "the only
    // one", put a Back button in front of the PIN pad at every cold start.
    const only = entryContext().profiles;
    if (only.length === 1) await handleSelectProfile(only[0]);
  }

  async function handleEntryNetworkChange(network: Network): Promise<void> {
    entryError = '';
    // The listener is registered here instead of at the top: in the phone flow the
    // picker only exists on the first screen, and a network switch restarts the
    // backend, which the flow has to survive.
    await handleNetworkChange(network);
    entryNetwork = network;
    entrySelected = null;
    syncEntryPhase();
  }

  /**
   * Reads whether a PIN is set for a profile and decides what comes next.
   *
   * @param profile - Profile the user tapped.
   * @remarks
   * The PIN is the only key the user has: it is never stored, and what it unlocks is
   * checked by the backend, which is also where the attempt counter lives.
   */
  async function handleSelectProfile(profile: ProfileSummary): Promise<void> {
    entryError = '';
    entrySelected = profile;
    entryPin = '';
    entryPinFirst = '';
    // Reset here as well as on the way out of the pad: the flag belongs to one profile,
    // and a second profile opened from the list must not inherit it and skip the seed
    // screen it still needs.
    pinUpgrade = false;
    pendingPin = false;
    entryBusy = true;
    try {
      // The state covers all four cases in one call: no envelope, a ready one, the
      // attempt limit, and an envelope that exists but cannot be read. The last two both
      // end at the phrase — a keypad cannot succeed there, and the password is generated
      // so the password prompt cannot either.
      const state = await pinState(entryNetwork, profile.keyUid);
      entryPhase = phaseAfterPinLookup(profile, state, canStorePin);
    } finally {
      entryBusy = false;
    }
  }

  /**
   * Confirms the PIN pad.
   *
   * @remarks
   * Two phases land here, and they do different things: opening a profile reads the
   * password with the PIN, while setting one wraps a password the page is still holding.
   * Both go through the same pad so the interaction feels the same.
   */
  async function handleSubmitPin(): Promise<void> {
    const phase = entryPhase;
    if (
      phase.kind !== 'enter-pin' &&
      phase.kind !== 'set-pin' &&
      phase.kind !== 'password' &&
      phase.kind !== 'create-pin'
    ) {
      return;
    }
    entryError = '';

    // The password phase shares the field with the PIN pad, so it is checked by its own
    // rules: a password is not digits and has no length limit from the keypad.
    if (phase.kind === 'password') {
      if (entryPin.length === 0) return;
      entryBusy = true;
      try {
        const password = entryPin;
        const opened = await loginWithStoredPassword(phase.profile, password, false);
        if (!opened) return;
        entryPin = '';
        entryPinFirst = '';
        // A profile can be in this branch for exactly one reason: it was created before
        // this scheme and has no envelope. Leaving it that way would mean the password
        // is typed on every start, forever — so the PIN is asked for right now, while
        // the password is in hand, and the profile ends up like any other.
        pinUpgrade = true;
        entryPhase = { kind: 'set-pin', profile: phase.profile, password };
      } finally {
        entryBusy = false;
      }
      return;
    }

    const problem = pinProblem(entryPin, pinMin, pinMax);
    if (problem) {
      entryError = i18n.t(problem);
      return;
    }

    entryBusy = true;
    try {
      if (phase.kind === 'enter-pin') {
        const password = await openPin(entryNetwork, phase.profile.keyUid, entryPin);
        entryPin = '';
        await loginWithStoredPassword(phase.profile, password);
        return;
      }

      // Setting: the first entry is held, the second has to match it. A mistyped PIN
      // would encrypt the password under a value its owner does not know, and nothing on
      // the device could recover it — only the seed phrase.
      if (entryPinFirst === '') {
        entryPinFirst = entryPin;
        entryPin = '';
        entryError = '';
        return;
      }
      if (entryPin !== entryPinFirst) {
        entryPinFirst = '';
        entryPin = '';
        entryError = i18n.t('The PINs do not match. Try again');
        return;
      }

      // No account exists yet: the PIN is the one thing that has to be right before the
      // profile is created at all.
      if (phase.kind === 'create-pin') {
        await createProfileAfterPin(entryPin);
        return;
      }

      // Two kinds of profile reach the rest of this block. One has its password here (a
      // profile being converted from the old scheme). The other arrived over pairing: its
      // password stayed on the Rust side, and setting the PIN is the call that wraps it —
      // the password is then read back out of the envelope it just produced, which is
      // also the first proof that the PIN actually opens it.
      let password: string;
      if (pendingPin) {
        await savePinFromPending(entryNetwork, phase.profile.keyUid, entryPin);
        password = await openPin(entryNetwork, phase.profile.keyUid, entryPin);
        pendingPin = false;
      } else {
        password = phase.password ?? '';
        await savePin(entryNetwork, phase.profile.keyUid, entryPin, password);
      }
      entryPin = '';
      entryPinFirst = '';
      selectedAccountKeyUid = phase.profile.keyUid;
      // The profile is open from here on, and this PIN is now what reopens it.
      sessionHasPin = true;
      entryPhase = { kind: 'login' };
      const upgraded = pinUpgrade;
      pinUpgrade = false;
      if (upgraded) {
        // An old profile that just gained its PIN. Its phrase was saved back when the
        // profile was created, so sending the user to the seed screen would be a step
        // that asks them to redo something already done.
        setSessionPassword(password);
        activeSection = 'home';
        return;
      }
      // A profile that arrived over pairing is not signed in yet: the keys are on the
      // device, but this one still has to open the database with the password that
      // arrived. Landing on the profile section instead would show a session that does
      // not exist.
      if (!statusState.isLoggedIn) {
        await loginWithStoredPassword(phase.profile, password);
        return;
      }
      setSessionPassword(password);
      // The phrase is the only way back if the PIN is forgotten, so it is shown right
      // after the profile is created — and it is shown as a *screen*, which lives in the
      // profile section: switching to `home` instead left the user on Home with the
      // phrase never displayed.
      activeSection = 'profile';
      showCreateSeed = true;
    } catch (e) {
      // The backend's message carries the attempts left, which is what the user needs;
      // a generic "cannot open" would hide it.
      entryError = formatError(e);
    } finally {
      entryBusy = false;
    }
  }

  /** Leaves the PIN pad. */
  async function handlePinBack(): Promise<void> {
    const phase = entryPhase;
    // Walking away from a paired profile's PIN screen leaves a profile on the device
    // whose password only this process knew. The profile is not deleted — the phrase
    // still restores it — but the password is dropped, so nothing can wrap it later as
    // if the user had stayed.
    if (pendingPin && phase.kind === 'set-pin') {
      await forgetPendingPin(entryNetwork, phase.profile.keyUid);
      pendingPin = false;
    }
    entryPin = '';
    entryPinFirst = '';
    pinUpgrade = false;
    entryCreatePassword = '';
    entryError = '';
    entryPhase = { kind: 'pick-profile' };
  }

  /**
   * Logs in with a password the PIN unlocked, or one the user typed.
   *
   * @param profile - Profile being opened.
   * @param password - Password that opens it.
   * @param viaPin - Whether the password came out of the envelope.
   * @remarks
   * `viaPin` decides whether the session can be locked later. A profile opened with its
   * PIN has an envelope, so the lock screen has something to verify; one opened by typing
   * its password does not, and locking it would ask for a PIN that was never set — a dead
   * end for the rest of the session.
   */
  async function loginWithStoredPassword(
    profile: ProfileSummary,
    password: string,
    viaPin = true
  ): Promise<boolean> {
    try {
      await login(password, profile.keyUid);
      setSessionPassword(password);
      selectedAccountKeyUid = profile.keyUid;
      sessionHasPin = viaPin;
      // The keyboard used for the PIN is dismissed right about now, and that fires `blur`.
      // Recording the moment keeps the lock from asking for the same PIN a second time.
      unlockedAt = Date.now();
      loginGrace = true;
      sessionOpen = true;
      // The pad must not be what a backend hiccup returns to: the session is open.
      entryPhase = { kind: 'login' };
      entrySelected = null;
      setTimeout(() => (loginGrace = false), 2500);
      activeSection = 'home';
      return true;
    } catch (e) {
      entryError = i18n.t('Could not open this profile');
      statusState.errorMsg = `Login failed: ${formatError(e)}`;
      return false;
    }
  }

  /**
   * Creates a profile with a generated password and asks for a PIN.
   *
   * @remarks
   * The password is not shown and not asked for: the PIN protects it. The PIN is asked
   * for *after* the account exists, because the key uid is only known once status-go has
   * created the profile; the password waits in the phase until then and is never kept in
   * a component, so it does not linger after a reload.
   */
  /**
   * Creates the account once the PIN is known.
   *
   * @param pin - Digits the user entered twice; the envelope is saved under them.
   * @remarks
   * The order matters: `createAccount` logs in immediately, so the account exists before
   * anything can fail. If saving the envelope fails after that, the local profile is
   * deleted again — a profile without a PIN is one whose generated password nobody knows,
   * and leaving it behind is what made an abandoned creation look like a real profile on
   * the next start.
   */
  async function createProfileAfterPin(pin: string): Promise<void> {
    const password = entryCreatePassword;
    await createAccount(password);
    const keyUid = statusState.accountKeyUid || statusState.accounts[0]?.['key-uid'] || '';
    if (!keyUid) throw new Error('the backend created no profile');
    try {
      await savePin(entryNetwork, keyUid, pin, password);
    } catch (e) {
      await deleteProfile(keyUid, `${statusState.backendDataDir}/keystore/${keyUid}`).catch(() => {});
      throw e;
    }
    entryPin = '';
    entryPinFirst = '';
    entryCreatePassword = '';
    selectedAccountKeyUid = keyUid;
    setSessionPassword(password);
    sessionHasPin = true;
    sessionOpen = true;
    entryPhase = { kind: 'login' };
    // The phrase is the only way back if the PIN is forgotten: show it right away.
    activeSection = 'profile';
    showCreateSeed = true;
  }

  function handleMobileCreate(): void {
    entryError = '';
    entryPin = '';
    entryPinFirst = '';
    // Nothing is created yet. The account appears only after the PIN is confirmed, in
    // `handleSubmitPin`: creating it first meant a profile whose password nobody knew if
    // the user backed out, and the next start showed it as if it were a real one.
    entryCreatePassword = generatePassword();
    entryPhase = { kind: 'create-pin' };
  }

  /**
   * Opens the pairing screen as the receiving side.
   *
   * @param _method - How the two devices are connected; the transfer itself does not
   *   depend on it. Discovery runs on whatever local network both devices share, and a
   *   USB cable with tethering on is one more such network.
   *
   * A device in the entry flow has no profile, so it is necessarily the receiver. The
   * sending side is reached from the profile section of a device that is logged in.
   */
  async function handlePair(_method: 'wifi' | 'usb'): Promise<void> {
    entryError = '';
    entryPin = '';
    pairingRole = 'receiver';
    pairingError = '';
    pairingDigits = '';
    pairingPhase = 'waiting';
    if (!(await pairingAvailable())) {
      entryError = i18n.t('Pairing is not available in this build yet');
      return;
    }
    entryPhase = { kind: 'pairing-enter', role: 'receiver' };
    try {
      pairingLocalAddress = (await lanLocalAddress()) ?? '';
      const status = await lanReceiveStart(statusState.backendDataDir, entryNetwork);
      void applyPairingStatus(status);
      startPairingPolling();
    } catch (e) {
      pairingPhase = 'failed';
      pairingError = formatError(e);
    }
  }

  /**
   * Starts the search and the handshake; the sender gets here after the PIN check.
   *
   * @param address - Address typed by the user, when the broadcast search found nothing.
   */
  async function showPairingCode(address?: string): Promise<void> {
    pairingError = '';
    pairingDigits = '';
    pairingPhase = 'waiting';
    try {
      const status = await lanSendStart(
        statusState.backendDataDir,
        selectedAccountKeyUid,
        getSessionPassword(),
        pairingDeviceType(),
        pairingSyncHistory,
        address
      );
      void applyPairingStatus(status);
      startPairingPolling();
    } catch (e) {
      pairingPhase = 'failed';
      pairingError = formatError(e);
    }
  }

  /** Retries the sender's search at the address typed on screen. */
  async function handlePairingAddress(address: string): Promise<void> {
    stopPairingPolling();
    await lanCancel().catch(() => undefined);
    await showPairingCode(address);
  }

  /**
   * Checks the PIN before the sender shows its code.
   *
   * @remarks
   * The same `openPin` the entry flow uses, so wrong attempts count towards the same
   * limit: this prompt cannot be used as a free guessing oracle in front of a locked
   * profile.
   */
  async function handlePairingPin(): Promise<void> {
    pairingPinError = '';
    const problem = pinProblem(pairingPin, pinMin, pinMax);
    if (problem) {
      pairingPinError = i18n.t(problem);
      return;
    }
    try {
      const password = await openPin(entryNetwork, selectedAccountKeyUid, pairingPin);
      pairingPin = '';
      // The session password, because the transfer reads it when the other device
      // connects. Proving the PIN here also proves the profile can be opened at all.
      setSessionPassword(password);
      await showPairingCode();
    } catch (e) {
      pairingPin = '';
      pairingPinError = formatError(e);
    }
  }

  /** Leaves without showing a code. */
  function handlePairingPinCancel(): void {
    pairingPin = '';
    pairingPinError = '';
    if (pairingRole === 'sender') mobileSendProfile = false;
  }

  /**
   * Presses Sync after the digits matched on both screens.
   *
   * @remarks
   * Both devices press: the receiving side sends its confirmation, the sending side
   * issues the transfer. The profile leaves only when both have agreed, which is what
   * turns "whoever holds the code takes the profile" into a decision of two people.
   */
  async function handlePairingConfirm(): Promise<void> {
    pairingError = '';
    try {
      const status = await lanConfirm();
      pairingConfirmed = status.phase === 'codes';
      await applyPairingStatus(status);
    } catch (e) {
      pairingError = formatError(e);
    }
  }

  /** Leaves the pairing screen. */
  async function handlePairingBack(): Promise<void> {
    stopPairingPolling();
    await lanCancel().catch(() => undefined);
    pairingPhase = 'idle';
    pairingDigits = '';
    pairingError = '';
    pairingPin = '';
    pairingPinError = '';
    if (pairingRole === 'sender') {
      mobileSendProfile = false;
      return;
    }
    // The receiver came from "Restore or sync": that is where Back leads, not to a
    // transport picker that no longer exists.
    entryPhase = { kind: 'restore-method' };
  }

  /**
   * Opens the sending screen from the profile section.
   *
   * @remarks
   * Only reachable while logged in: the keys are what is being sent, and status-go
   * requires a session to read them.
   */
  async function handleOpenSendProfile(): Promise<void> {
    if (!(await pairingAvailable())) {
      statusState.errorMsg = i18n.t('Pairing is not available in this build yet');
      return;
    }
    pairingRole = 'sender';
    pairingPhase = 'idle';
    pairingDigits = '';
    pairingError = '';
    pairingPin = '';
    pairingPinError = '';
    mobileSendProfile = true;
  }

  // ---------------------------------------------------------------------------
  // Session lock
  // ---------------------------------------------------------------------------
  //
  // The PIN protects the profile password, and the password protects the database. At
  // start the profile is opened through the PIN; while the app sits in the background the
  // last screen stays as it was, so anyone picking up the phone would read it. Leaving the
  // app therefore covers the interface with the PIN pad and drops the session password
  // from memory — anything that needs to sign has to ask again.
  //
  // The backend is deliberately *not* logged out here. A logout stops the messenger and
  // the next start has to resync from scratch, which would cost the user their background
  // message reception on every app switch. What protects the data is the pad in front of
  // it plus the wipe of the signing secret; the database itself is encrypted at rest.

  /** Records which profile the open session belongs to, so it can be locked. */
  function rememberSessionIdentity(): void {
    // The picker speaks `sepolia`/`holesky`, while a credential slot is scoped by
    // `mainnet`/`testnet` only. `parseNetwork` would answer `null` for the testnet names
    // and leave the slot pointing at mainnet, where this profile has no PIN at all —
    // unlocking would fail on a testnet profile that restored fine a minute earlier.
    lockedNetwork = selectedNetwork === 'mainnet' ? 'mainnet' : 'testnet';
    lockedKeyUid =
      selectedAccountKeyUid ||
      statusState.accountKeyUid ||
      statusState.accounts[0]?.['key-uid'] ||
      '';
  }

  /**
   * Stops a pairing attempt and puts the screens back where they started.
   *
   * @remarks
   * A transfer in progress is a live secret: a bound discovery socket, a running
   * status-go server, and six digits on screen. Leaving the application used to leave
   * all of it running behind the lock — the server kept its port until the five-minute
   * timeout, and on return the screen showed a dead attempt that had expired while the
   * app was in the background. The attempt now ends when the app goes away, exactly as
   * it ends when the user presses Back.
   */
  function stopPairingAttempt(): void {
    const active =
      pairingPhase === 'waiting' ||
      pairingPhase === 'codes' ||
      pairingPhase === 'transferring';
    const onScreen = entryPhase.kind === 'pairing-enter' || mobileSendProfile;
    if (!active && !onScreen) return;
    info('[pairing] attempt stopped by leaving the app');
    stopPairingPolling();
    void lanCancel().catch(() => undefined);
    pairingPhase = 'idle';
    pairingDigits = '';
    pairingConfirmed = false;
    pairingError = '';
    pairingPin = '';
    pairingPinError = '';
    if (entryPhase.kind === 'pairing-enter') entryPhase = { kind: 'restore-method' };
    if (mobileSendProfile) mobileSendProfile = false;
  }

  /** Locks the open session, if this profile can be reopened with a PIN. */
  function lockSession(): void {
    if (appLocked || !statusState.isLoggedIn) return;
    if (!sessionHasPin) {
      // Signed in without a PIN (a desktop-style profile): there is nothing to verify, and
      // locking would strand the user until the profile is reset. Leave it open.
      return;
    }
    rememberSessionIdentity();
    // A profile whose key uid could not be resolved has no slot to verify against:
    // locking would put a pad in front of a profile that can never open.
    if (!lockedKeyUid) return;
    info('[lock] locking the session');
    appLocked = true;
    lockPin = '';
    lockError = '';
    // The password stays in memory only while the session is unlocked, so a device left
    // unlocked on a desk cannot be used to sign a transfer without the PIN.
    clearSessionPassword();
  }

  /** Verifies the PIN on the lock screen and returns to the interface. */
  async function handleUnlock(): Promise<void> {
    lockError = '';
    const problem = pinProblem(lockPin, pinMin, pinMax);
    if (problem) {
      lockError = i18n.t(problem);
      return;
    }
    lockBusy = true;
    try {
      // The same call the entry flow uses: it is what counts wrong attempts, so the limit
      // holds here too and cannot be bypassed by backgrounding the app repeatedly.
      const password = await openPin(lockedNetwork, lockedKeyUid, lockPin);
      lockPin = '';
      setSessionPassword(password);
      appLocked = false;
      unlockedAt = Date.now();
    } catch (e) {
      // The backend's message carries the attempts left, which is what the user needs.
      lockError = formatError(e);
      lockPin = '';
    } finally {
      lockBusy = false;
    }
  }

  /**
   * Wires the window lifecycle to the lock.
   *
   * @remarks
   * `visibilitychange` fires with `hidden` when the activity is covered by another app or
   * the screen goes off — that is the moment a pickpocket or a curious colleague gets the
   * phone, so it is the moment to lock. `pagehide` is not used: the webview may keep the
   * page alive and never fire it, and Android kills the process on its own terms.
   *
   * Losing focus is the same event on the desktop: the window that is no longer focused
   * is a window someone else can read, and a desk is no more private than a train. Both
   * platforms are wired here rather than the phone alone, because the desktop keeps a PIN
   * too and locking it costs nothing when `sessionHasPin` is false.
   *
   * The listener is attached once and removed on unmount; returning a short delay before
   * locking would defeat the point, since the process stays alive in the background.
   */
  $effect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        // A pairing attempt does not survive the app leaving the foreground: its server
        // and its sockets would keep running behind the lock until the timeout.
        stopPairingAttempt();
        void lockSession();
      }
    };
    // The webview does not always report `visibilitychange` when another activity covers
    // it, while losing focus is what the window system always reports. Both are wired:
    // `lockSession` is idempotent, so a double trigger costs nothing.
    //
    // `blur` alone is too eager: dismissing the keyboard fires it. It is ignored for a
    // moment after a successful unlock, and only while the page is still visible — being
    // covered by another app arrives as `hidden` and locks regardless.
    const onBlur = () => {
      // Android reports `hidden` when the app actually goes away, and reports `blur` for
      // things that are not leaving at all — dismissing the keyboard, a focus change
      // during redraw. Locking on those asked for the PIN a second time right after a
      // correct one. On the desktop the opposite is true: the window stays `visible`
      // while it loses focus, so `blur` is the only signal that the user walked away.
      if (!isAndroid() && Date.now() - unlockedAt < BLUR_GRACE_MS) return;
      if (isAndroid() && document.visibilityState === 'visible') return;
      stopPairingAttempt();
      void lockSession();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('blur', onBlur);
    };
  });

  async function handleCreateAccount(password: string) {
    info('[boot] handleCreateAccount called');
    try {
      await createAccount(password);
      info('[boot] handleCreateAccount: createAccount resolved');
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
    // Leaving the profile section abandons a pending transfer: the pairing server it may
    // have started lives until the transfer finishes, and a screen that is gone cannot
    // show it.
    if (id !== 'profile' && mobileSendProfile) {
      mobileSendProfile = false;
      stopPairingPolling();
      void lanCancel().catch(() => undefined);
      pairingPhase = 'idle';
      pairingDigits = '';
      pairingError = '';
    }
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
    // The password kept for the profile screen is the same kind of secret: the next
    // profile on this machine must not inherit it.
    clearSessionPassword();
    setProfileAvatar(null);
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
    // The lock belongs to a session: a signed-out profile has no PIN to ask for, and a
    // stale flag here would hide the entry flow behind a pad that opens nothing.
    appLocked = false;
    loginGrace = false;
    sessionOpen = false;
    sessionHasPin = false;
    lockPin = '';
    lockError = '';
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
        <!--
          The editor, the pairing screen and the seed screen belong to the Profile section.
          The branch used to treat `home` the same way, so a leftover `mobileEditProfile`
          flag made Home render the profile editor — the user signed in after restoring a
          phrase and landed on Edit.page instead of Home.
        -->
        {#if activeSection === 'profile' && mobileEditProfile}
   <EditProfile onNavigate={(s) => { mobileEditProfile = false; activeSection = s; }} />
        {:else if activeSection === 'profile' && mobileSendProfile}
          <!--
            Sending from a phone: the list is replaced by the pairing screen, which shows
            the string and then waits. Same reasoning as the seed screen below — a narrow
            layout renders one pane, and the screen has to be chosen explicitly.
          -->
          <PairingScreen
            role="sender"
            phase={pairingPhase}
            digits={pairingDigits}
            error={pairingError}
            bind:pin={pairingPin}
            pinError={pairingPinError}
            {pinMin}
            {pinMax}
            bind:syncHistory={pairingSyncHistory}
            confirmed={pairingConfirmed}
            onConfirm={handlePairingConfirm}
            onAddress={handlePairingAddress}
            onPin={handlePairingPin}
            onPinCancel={handlePairingPinCancel}
            onBack={handlePairingBack}
          />
        {:else if activeSection === 'profile' && showCreateSeed}
          <!--
            The phrase lives in the right pane on a wide screen. A phone shows one pane at a
            time, so the seed screen has to be chosen explicitly here — otherwise it was
            rendered for a pane the narrow layout never displays, and a newly created
            profile reached Home with its phrase never shown.
          -->
          {@render rightPane()}
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
        {#if activeSection === 'home'}
          <HomeLeft active={homeTopic} onSelect={(id) => (homeTopic = id)} />
        {:else if activeSection === 'profile'}
   <ProfileLeft
     onDisconnect={handleDisconnect}
     onCreateSeed={() => { activeSection = 'profile'; showCreateSeed = true; }}
     onEditProfile={openEditProfile}
     onSendProfile={handleOpenSendProfile}
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
   <HomeMain topic={homeTopic} onNavigate={(s) => activeSection = s} />
        {:else if activeSection === 'profile'}
          {#if showCreateSeed}
     <CreateSeed
       onBack={() => showCreateSeed = false}
onSave={() => {
         setSeedSaved(true);
  showCreateSeed = false;
         // Writing the phrase down ends the setup: the next screen is the one the user
         // came for, not the profile section they were taken to only to see the words.
         mobileEditProfile = false;
         activeSection = 'home';
       }}
            />
          {:else if mobileSendProfile}
            <!-- Sending a profile from a wide layout: same screen as on the phone. -->
            <PairingScreen
              role="sender"
              phase={pairingPhase}
              digits={pairingDigits}
              error={pairingError}
              bind:pin={pairingPin}
              pinError={pairingPinError}
              {pinMin}
              {pinMax}
              bind:syncHistory={pairingSyncHistory}
              confirmed={pairingConfirmed}
              onConfirm={handlePairingConfirm}
              onAddress={handlePairingAddress}
              onPin={handlePairingPin}
              onPinCancel={handlePairingPinCancel}
              onBack={handlePairingBack}
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
          <HomeMain topic={homeTopic} onNavigate={(s) => activeSection = s} />
        {/if}
      </SectionPane>
    {/snippet}

<div class="min-h-screen bg-background">
  <!-- Testnet banner -->
  {#if statusState.isTestnet}
    <div class="bg-warning text-warning-foreground text-center py-2 px-4 font-semibold text-sm">
      ⚠️ {statusState.networkName.toUpperCase()} TESTNET MODE — All balances and transactions are on testnets.
    </div>
  {/if}

  <!-- Spinner -->
  {#if connectionState.isConnecting}
    <div class="flex flex-col items-center justify-center min-h-screen gap-4">
      <div class="w-10 h-10 border-4 border-muted border-t-primary rounded-full animate-spin"></div>
      <h2 class="text-2xl font-semibold text-foreground">Connecting...</h2>
    </div>

  {:else if appLocked}
    <!--
      Lock screen: only a session that had a PIN reaches it, so the pad always has something
      to verify against. It sits above the login branch because a locked session is still
      signed in — the backend keeps running in the background, and the pad is the only way
      back to the interface.
    -->
    <PinPad
      bind:value={lockPin}
      minLength={pinMin}
      maxLength={pinMax}
      title={i18n.t('Enter your PIN')}
      busy={lockBusy}
      error={lockError}
      onSubmit={handleUnlock}
    />

  <!-- Login screen -->
  <!--
    The PIN setup of a new profile is shown even though the profile is already signed in:
    `createAccount` logs in immediately, and without this the screen would vanish before
    the user ever picked a PIN, leaving a profile that can never be opened again.
  -->
  {:else if
    !(sessionOpen || loginGrace) ||
    entryPhase.kind === 'set-pin' ||
    entryPhase.kind === 'create-pin'
  }
    <!--
      One entry flow on every platform. The desktop used to ask for a password by hand,
      but a profile synced from a phone arrives with a 32-character generated password
      nobody types — so the desktop keeps a PIN too, and the same screens serve both.
      The password prompt survives only for profiles created before the scheme.
    -->
    {#if entryPhase.kind === 'restore-phrase' || showRecovery}
      <RecoveryScreen
        onBack={() => {
          showRecovery = false;
          entryPhase = { kind: 'restore-method' };
        }}
        onRestore={handleRestoreAccount}
        onReset={handleResetProfile}
      />
    {:else if entryPhase.kind === 'pairing-enter'}
      <!--
        The transfer lives on the page, not in the entry screen: it needs the connection
        string, the busy state and the retry, and the entry screen is deliberately a
        stateless renderer of `phase`.
      -->
      <PairingScreen
        role={pairingRole}
        phase={pairingPhase}
        digits={pairingDigits}
        error={pairingError || entryError}
        localAddress={pairingLocalAddress}
        bind:pin={pairingPin}
        pinError={pairingPinError}
        {pinMin}
        {pinMax}
        bind:syncHistory={pairingSyncHistory}
        confirmed={pairingConfirmed}
        onConfirm={handlePairingConfirm}
        onAddress={handlePairingAddress}
        onPin={handlePairingPin}
        onPinCancel={handlePairingPinCancel}
        onBack={handlePairingBack}
      />
    {:else}
      <MobileEntryScreen
        bind:phase={entryPhase}
        bind:pin={entryPin}
        hasProfiles={hasProfiles}
        {profileCount}
        {pinMin}
        {pinMax}
        {pinConfirming}
        busy={entryBusy}
        error={entryError}
        onNetworkChange={handleEntryNetworkChange}
        onSelectProfile={handleSelectProfile}
        onCreate={handleMobileCreate}
        onRestorePhrase={() => (entryPhase = { kind: 'restore-phrase' })}
        onSubmitPin={handleSubmitPin}
        onPinBack={handlePinBack}
        onPair={handlePair}
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
