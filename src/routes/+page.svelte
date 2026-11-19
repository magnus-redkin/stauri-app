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
  import { initializeApplication } from '$lib/status/api';
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
    confirmationCode,
    pairingAvailable,
    receiveAccount,
    sendAccount,
    startReceiving,
    startSending,
    validateConnectionString,
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
   * Whether the PIN being chosen wraps a password that arrived over pairing.
   *
   * @remarks
   * The password is not in the phase: it stayed on the Rust side when the transfer
   * finished, and `savePinFromPending` is what turns it into an envelope. This flag only
   * says which call to make — and, on leaving the screen, which password to forget.
   */
  let pendingPin = $state(false);
  /** Whether the pad is asking for the repeat of a new PIN. */
  const pinConfirming = $derived(entryPhase.kind === 'set-pin' && entryPinFirst !== '');
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
  /** String this device produced, empty until the server is started. */
  let pairingString = $state('');
  /** Whether a string was produced; the screen shows it only then. */
  let pairingHasString = $state(false);
  /** String the user pasted from the other device. */
  let pairingInput = $state('');
  let pairingBusy = $state(false);
  let pairingError = $state('');
  /**
   * Six digits both devices compare before the transfer starts.
   *
   * @remarks
   * Derived from the key inside the connection string. A string swapped on its way across
   * produces different digits here and on the other device, which is the moment to stop;
   * the code does not help against someone who saw the whole string.
   */
  let pairingCode = $state('');
  /** Whether the code is on screen already; before that the screen offers to start. */
  let pairingShowingCode = $state(false);
  /**
   * Digits derived from the string the receiver pasted.
   *
   * @remarks
   * The receiving device cannot compute this from its own server — it has no string of
   * its own — so it reads the digits out of the sender's. Comparing them is the whole
   * point: a string substituted on its way across yields different digits here.
   */
  let pairingPastedCode = $state('');
  /** Whether the sender is being asked for its PIN before it shows a code. */
  let pairingPromptPin = $state(false);
  let pairingPin = $state('');
  let pairingPinError = $state('');
  /**
   * Whether the message history travels with the profile.
   *
   * @remarks
   * Off by default. status-go sends the whole message database with no date window, and
   * its own source calls that a privacy decision the user has to make deliberately.
   */
  let pairingSyncHistory = $state(false);
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
    if (phase.kind !== 'enter-pin' && phase.kind !== 'set-pin' && phase.kind !== 'password') {
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

      // Two kinds of profile reach this pad. One has its password here (a profile just
      // created, or one being converted from the old scheme). The other arrived over
      // pairing: its password stayed on the Rust side, and setting the PIN is the call
      // that wraps it — the password is then read back out of the envelope it just
      // produced, which is also the first proof that the PIN actually opens it.
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
  async function handleMobileCreate(): Promise<void> {
    entryError = '';
    entryBusy = true;
    try {
      const password = generatePassword();
      await createAccount(password);
      const keyUid = statusState.accountKeyUid || statusState.accounts[0]?.['key-uid'] || '';
      if (!keyUid) throw new Error('the backend created no profile');
      entryPin = '';
      // The profile is open already; the PIN is what opens it next time.
      entryPhase = { kind: 'set-pin', profile: { keyUid }, password };
      selectedAccountKeyUid = keyUid;
    } catch (e) {
      entryError = i18n.t('Could not create the profile');
      statusState.errorMsg = `Create account failed: ${formatError(e)}`;
      activeSection = 'home';
    } finally {
      entryBusy = false;
    }
  }

  /**
   * Opens the pairing screen as the receiving side.
   *
   * @param _method - Transport chosen on the previous screen.
   * @remarks
   * The transport is not a parameter of the transfer: status-go always pairs over TCP on
   * the local network, and the only thing the choice changes is how the string gets from
   * one screen to the other. Both paths land here, and the screen offers copy and paste.
   *
   * A device in the entry flow has no profile, so it is necessarily the receiver. The
   * sending side is reached from the profile section of a device that is logged in.
   */
  async function handlePair(_method: 'wifi' | 'usb'): Promise<void> {
    entryError = '';
    entryPin = '';
    pairingRole = 'receiver';
    pairingString = '';
    pairingInput = '';
    pairingError = '';
    if (!(await pairingAvailable())) {
      entryError = i18n.t('Pairing is not available in this build yet');
      return;
    }
    entryPhase = { kind: 'pairing-enter', role: 'receiver' };
  }

  /**
   * Asks this device to show the string the other one reads.
   *
   * @remarks
   * The sender only does this while the profile is open, and showing the code hands out
   * a five-minute key to the profile: whoever reads the string can take it. So the PIN is
   * asked for first — a phone left unlocked on a desk must not be enough on its own.
   * The receiver has no profile to protect, so it starts its server directly.
   */
  async function handlePairingStart(): Promise<void> {
    pairingError = '';
    if (pairingRole === 'sender') {
      pairingShowingCode = false;
      pairingPromptPin = true;
      pairingPin = '';
      pairingPinError = '';
      return;
    }
    await showPairingCode();
  }

  /** Starts the server and shows the code; the sender gets here after the PIN check. */
  async function showPairingCode(): Promise<void> {
    pairingError = '';
    pairingBusy = true;
    try {
      const dataDir = statusState.backendDataDir;
      const result =
        pairingRole === 'receiver'
          ? await startReceiving(dataDir)
          : await startSending(
              dataDir,
              selectedAccountKeyUid,
              getSessionPassword(),
              pairingDeviceType(),
              pairingSyncHistory
            );
      pairingString = result.value;
      pairingCode = result.confirmation_code;
      pairingHasString = true;
    } catch (e) {
      pairingError = formatError(e);
    } finally {
      pairingBusy = false;
    }
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
    pairingBusy = true;
    try {
      const password = await openPin(entryNetwork, selectedAccountKeyUid, pairingPin);
      pairingPin = '';
      // Not stored in the session: the code screen only has to prove who is holding the
      // phone, and the transfer reads the password from the session at that point.
      setSessionPassword(password);
      pairingPromptPin = false;
      pairingShowingCode = true;
      await showPairingCode();
    } catch (e) {
      pairingPin = '';
      pairingPinError = formatError(e);
    } finally {
      pairingBusy = false;
    }
  }

  /** Leaves the PIN prompt without showing a code. */
  function handlePairingPinCancel(): void {
    pairingPromptPin = false;
    pairingPin = '';
    pairingPinError = '';
    if (pairingRole === 'sender') mobileSendProfile = false;
  }

  /**
   * Runs the transfer with the string the other device showed.
   *
   * @remarks
   * The receiving side is the one that ends up with a new profile, so it is where the
   * password appears: status-go ships the sender's password inside the payload, and the
   * screen wraps it under a PIN the user chooses. A password that arrived but is not
   * wrapped would leave a profile nobody can open once this screen is gone.
   */
  async function handlePairingTransfer(): Promise<void> {
    pairingError = '';
    if (!(await validateConnectionString(pairingInput))) {
      pairingError = i18n.t('This code is not valid');
      return;
    }
    // The receiver shows the digits of whatever it pasted, next to the sender's screen.
    // Two presses rather than one: the first reveals the digits, the second — pressed
    // only after they match — starts the transfer.
    if (pairingRole === 'receiver') {
      const pasted = await confirmationCode(pairingInput);
      if (!pasted) {
        pairingError = i18n.t('This code is not valid');
        return;
      }
      if (pasted !== pairingPastedCode) {
        pairingPastedCode = pasted;
        return;
      }
    }
    pairingBusy = true;
    try {
      const dataDir = statusState.backendDataDir;
      if (pairingRole === 'sender') {
        await sendAccount(
          dataDir,
          pairingInput,
          selectedAccountKeyUid,
          getSessionPassword(),
          pairingDeviceType()
        );
        pairingString = '';
        pairingInput = '';
        pairingHasString = false;
        // The sending device keeps working as it did: the transfer is a copy, not a move.
        entryError = '';
        entryPhase = { kind: 'login' };
        activeSection = 'home';
        return;
      }

      const account = await receiveAccount(dataDir, pairingInput, entryNetwork);
      // The profile list is reloaded so the new key is known to the backend before the
      // PIN screen hands over to the session.
      await reloadAccounts();
      pairingInput = '';
      pairingString = '';
      pairingHasString = false;
      entryPin = '';
      entryPinFirst = '';
      // The password that came with the profile is not in `account`: it waits on the Rust
      // side until the PIN is set. The pad only needs to know which call to make.
      pendingPin = true;
      entryPhase = {
        kind: 'set-pin',
        profile: { keyUid: account.key_uid, name: account.name },
      };
    } catch (e) {
      pairingError = formatError(e);
    } finally {
      pairingBusy = false;
    }
  }

  /** Leaves the pairing screen. */
  async function handlePairingBack(): Promise<void> {
    pairingString = '';
    pairingInput = '';
    pairingHasString = false;
    pairingError = '';
    // The digits belong to one string. Keeping them would show the previous paste's
    // answer next to a new code, which is precisely the comparison that must not be stale.
    pairingCode = '';
    pairingPastedCode = '';
    pairingShowingCode = false;
    pairingPromptPin = false;
    pairingPin = '';
    pairingPinError = '';
    if (pairingRole === 'sender') {
      mobileSendProfile = false;
      return;
    }
    entryPhase = { kind: 'pairing-method' };
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
    pairingString = '';
    pairingInput = '';
    pairingError = '';
    pairingHasString = false;
    pairingCode = '';
    pairingPastedCode = '';
    pairingShowingCode = false;
    pairingPromptPin = false;
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
      if (document.visibilityState === 'hidden') void lockSession();
    };
    // The webview does not always report `visibilitychange` when another activity covers
    // it, while losing focus is what the window system always reports. Both are wired:
    // `lockSession` is idempotent, so a double trigger costs nothing.
    //
    // `blur` alone is too eager: dismissing the keyboard fires it. It is ignored for a
    // moment after a successful unlock, and only while the page is still visible — being
    // covered by another app arrives as `hidden` and locks regardless.
    const onBlur = () => {
      if (document.visibilityState === 'visible' && Date.now() - unlockedAt < BLUR_GRACE_MS) {
        return;
      }
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
      pairingString = '';
      pairingInput = '';
      pairingHasString = false;
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
            connectionString={pairingHasString ? pairingString : ''}
            bind:value={pairingInput}
            busy={pairingBusy}
            error={pairingError}
            confirmationCode={pairingCode}
            showingCode={pairingShowingCode}
            promptPin={pairingPromptPin}
            bind:pin={pairingPin}
            pinError={pairingPinError}
            {pinMin}
            {pinMax}
            bind:syncHistory={pairingSyncHistory}
            onStart={handlePairingStart}
            onTransfer={handlePairingTransfer}
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
              connectionString={pairingHasString ? pairingString : ''}
              bind:value={pairingInput}
              busy={pairingBusy}
              error={pairingError}
              confirmationCode={pairingCode}
              showingCode={pairingShowingCode}
              promptPin={pairingPromptPin}
              bind:pin={pairingPin}
              pinError={pairingPinError}
              {pinMin}
              {pinMax}
              bind:syncHistory={pairingSyncHistory}
              onStart={handlePairingStart}
              onTransfer={handlePairingTransfer}
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
  {:else if !statusState.isLoggedIn || entryPhase.kind === 'set-pin'}
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
        connectionString={pairingHasString ? pairingString : ''}
        bind:value={pairingInput}
        busy={pairingBusy}
        error={pairingError || entryError}
        confirmationCode={pairingCode}
        showingCode={pairingShowingCode}
        promptPin={pairingPromptPin}
        bind:pin={pairingPin}
        pinError={pairingPinError}
        {pinMin}
        {pinMax}
        bind:syncHistory={pairingSyncHistory}
        onStart={handlePairingStart}
        onTransfer={handlePairingTransfer}
        onPin={handlePairingPin}
        onPinCancel={handlePairingPinCancel}
        onBack={handlePairingBack}
      />
    {:else}
      <MobileEntryScreen
        bind:phase={entryPhase}
        bind:pin={entryPin}
        hasProfiles={hasProfiles}
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
