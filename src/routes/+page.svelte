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
    switchNetwork,
    login,
    createAccount,
    restoreAccount,
    resetLocalProfileAndRestore,
    isMnemonicProfileLocal,
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
  import { startUpdatePolling } from '$lib/stores/updaterState.svelte';
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
  import PinEntry from '$lib/sections/auth/PinEntry.svelte';
  import { isAndroid, isPhonePlatform } from '$lib/utils/platform';
  import type {
    EntryContext,
    EntryPhase,
    Network,
    ProfileSummary,
  } from '$lib/entry/entryFlow';
  import {
    credentialNetwork,
    initialPhase,
    isMissingPinError,
    phaseAfterPinLookup,
    pinCreationProblem,
    pinOpenProblem,
  } from '$lib/entry/entryFlow';
  import { deleteProfile, initializeApplication } from '$lib/status/api';
  import {
    credentialsAvailable,
    forgetPendingPin,
    generatePassword,
    openPin,
    pinRules,
    pinState,
    savePin,
    savePinFromPending,
    type PinRules,
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
  import CreateName from '$lib/sections/auth/CreateName.svelte';
  import { rememberProfileName } from '$lib/stores/profileNames';
  import { saveSetting } from '$lib/status/wallet';
  import { sendContactUpdates } from '$lib/status/messaging';

  import HomeMain from "$lib/sections/home/HomeMain.svelte";
  import HomeLeft from "$lib/sections/home/HomeLeft.svelte";
  import { parseAbout } from "$lib/sections/home/aboutSections";
  import { aboutMarkdown } from "$lib/sections/home/aboutMarkdown";
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
  /**
   * The shell header title on a phone: "Edit Profile" while the editor is open, "Profile"
   * otherwise. The pencil in the header carries both states, so the pane body no longer
   * repeats the title.
   */
  const mobileTitle = $derived(
    activeSection === 'profile' && mobileEditProfile ? i18n.t('Edit Profile') : sectionTitle(activeSection)
  );
  // Open subsection of the About menu on Home; the right panel follows it.
  // null: Home shows only the two main buttons.
  let homeSection = $state<string | null>(null);
  /** Subsections of `docs/<lang>/about.md`: one per `##` heading, in file order. */
  const aboutSections = $derived(parseAbout(aboutMarkdown()));
  // Mobile layout uses a single panel and a bottom bar. A phone keeps it in both
  // orientations: turning the device makes the viewport wider than the 768px breakpoint,
  // and a width-only rule swapped the whole layout for the desktop panes, which have no
  // bottom menu — the section bar vanished with no way back to it.
  let isMobile = $state(isPhonePlatform());
  // Which section panel the mobile layout shows: left or right.
  $effect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => (isMobile = isPhonePlatform() || mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });
  let showRecovery = $state(false);
  let showCreateSeed = $state(false);

  // Account selected for login.
  let selectedAccountKeyUid = $state('');
  let selectedNetwork = $state('mainnet');

  /**
   * Whether this device has profiles for the selected network.
   *
   * @remarks
   * The entry screen lists them itself; with none, creation is the only action and it is
   * styled as the primary one.
   */
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
    // A release can wait on no one: the check runs in the background and then hourly.
    startUpdatePolling();
    await connect(undefined);
    if (statusState.accounts.length > 0) {
      selectedAccountKeyUid = statusState.accounts[0]["key-uid"];
    }
    // Every platform starts on the same flow: whether a profile has a PIN decides what
    // the next step is, and that question is asked of the backend either way.
    await startEntryFlow();
  });


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
    // The value chosen on the recovery screen is this profile's PIN from now on.
    await ensureEnvelope(password, statusState.accountKeyUid);
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
    await ensureEnvelope(password, statusState.accountKeyUid);
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
    // The recovery screen is rendered by `entryPhase`, not only by `showRecovery`, and the
    // entry branch is chosen while `sessionOpen` is false. Clearing only the flag left a
    // successfully restored profile sitting on its own password screen with no message:
    // the backend had logged it in, the interface never noticed. Same tail as
    // `loginWithStoredPassword`.
    sessionHasPin = false;
    loginGrace = true;
    sessionOpen = true;
    entryPhase = { kind: 'login' };
    entrySelected = null;
    setTimeout(() => (loginGrace = false), 2500);
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
  /**
   * PIN policy read from the backend, so the interface cannot drift from Rust.
   *
   * @remarks
   * The phone keeps a numeric code (five digits and up) and the desktop a passphrase
   * (eight characters and four classes). Creation is the strict half; opening accepts
   * whatever was stored. The defaults mirror the Rust policy and are replaced at start.
   */
  let credentialRules = $state<PinRules>(
    isAndroid()
      ? { max_length: 12, max_attempts: 10, creation_min: 5, digits_only: true, require_classes: false }
      : { max_length: 64, max_attempts: 10, creation_min: 8, digits_only: false, require_classes: true }
  );
  /** Shortest PIN the creation policy accepts; the open screens use it as a guard. */
  let pinMin = $derived(credentialRules.creation_min);
  /** Longest PIN that could ever have been stored. */
  let pinMax = $derived(credentialRules.max_length);
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
   * Credential slot of the open session — where its PIN envelope actually lives.
   *
   * @remarks
   * Recorded when the session is opened, not derived when it is about to be locked:
   * guessing the network and the profile from whatever the picker last showed is how a
   * pad ends up asking for a PIN in a slot the profile never had one in, and every
   * attempt there ends in "no PIN is set for this profile".
   */
  let sessionSlot = $state<{ network: Network; keyUid: string } | null>(null);
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
   * Whether the bottom-menu interface is on screen.
   *
   * @remarks
   * The section bar must be reachable from every section, so the shell owns exactly one
   * viewport: banner, header, scrolling content, bar. With `min-h` alone the column grew
   * with the content — a long screen (the profile editor) or a phone held sideways pushed
   * the bar past the bottom edge, and the menu was simply gone with no way back. Entry
   * screens keep `min-h`: they are short and may scroll.
   */
  const shellVisible = $derived(
    isMobile &&
      !connectionState.isConnecting &&
      !appLocked &&
      (sessionOpen || loginGrace) &&
      !['set-pin', 'create-pin', 'create-seed', 'create-name'].includes(entryPhase.kind)
  );

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
    // The policy decides what the pads enforce and what the keypad offers: five digits
    // on the phone, eight characters with four classes on the desktop.
    credentialRules = await pinRules();
    // The flow starts on whatever network the backend actually came up on. Assuming
    // `mainnet` would ask for a PIN in a slot the profile was never stored in, and the
    // profile would look like it had none. `credentialNetwork` is the one place that
    // turns a backend preset (`sepolia`, `holesky`) into the two envelope slots.
    entryNetwork = credentialNetwork(statusState.networkName || 'mainnet');
    syncEntryPhase();
  }

  async function handleEntryNetworkChange(network: string): Promise<void> {
    // The switch happens in place: status-go closes its account database and reopens it
    // on the chosen network's directory, so the list above is replaced by that network's
    // profiles. Nothing restarts, and a failure leaves the old network untouched — the
    // picker then puts its highlight back.
    if (network === statusState.networkName) return;
    entryError = '';
    try {
      await switchNetwork(network);
      entryNetwork = credentialNetwork(network);
      entrySelected = null;
      selectedAccountKeyUid = statusState.accounts[0]?.['key-uid'] ?? '';
      syncEntryPhase();
    } catch (e) {
      entryError = formatError(e);
      throw e;
    }
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
        // One credential per platform: the value just accepted IS the PIN — digits on a
        // phone, a passphrase on a desktop. It is wrapped silently here. Asking to
        // "choose a PIN" right after accepting a password asked for the same thing
        // twice, and the screen read as "the password did not work".
        await ensureEnvelope(password, phase.profile.keyUid);
      } finally {
        entryBusy = false;
      }
      return;
    }

    // Opening an existing PIN is checked for shape only; a PIN being created is checked
    // against the creation policy. The same split exists in Rust, which is the gate.
    const problem =
      phase.kind === 'enter-pin'
        ? pinOpenProblem(entryPin, pinMax)
        : pinCreationProblem(entryPin, credentialRules);
    if (problem) {
      entryError = i18n.t(problem);
      return;
    }

    entryBusy = true;
    try {
      if (phase.kind === 'enter-pin') {
        const password = await openPin(entryNetwork, phase.profile.keyUid, entryPin);
        entryPin = '';
        // The slot just proved it opens: it is the one a lock has to verify against.
        sessionSlot = { network: entryNetwork, keyUid: phase.profile.keyUid };
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
      sessionSlot = { network: entryNetwork, keyUid: phase.profile.keyUid };
      entryPhase = { kind: 'login' };
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
      // The digits that just failed are cleared: leaving them on the pad means the next
      // presses append to a value the user has already given up on, and the field runs
      // into its length limit instead of accepting a fresh PIN.
      entryPin = '';
      entryPinFirst = '';
    } finally {
      entryBusy = false;
    }
  }

  /**
   * Gives a profile an envelope without asking the user for anything extra.
   *
   * @param password - Value just typed and proven: the password at entry, or the one
   *   chosen on the recovery screen.
   * @param keyUid - Profile to cover.
   *
   * @remarks
   * On both platforms the typed value *is* the PIN; only the creation policy differs
   * (digits on a phone, four classes on a desktop). So a profile without an envelope gets
   * one wrapping that same value, and the next start asks for it exactly once.
   *
   * A failure is not fatal: the profile still opens by password, which is the previous
   * behaviour. It happens when the stored value does not satisfy the creation policy —
   * a phone holding a legacy alphanumeric password, for instance.
   */
  async function ensureEnvelope(password: string, keyUid: string): Promise<void> {
    if (!canStorePin || !keyUid || !password) return;
    try {
      if ((await pinState(entryNetwork, keyUid)) !== 'ready') {
        await savePin(entryNetwork, keyUid, password, password);
      }
      sessionHasPin = true;
      sessionSlot = { network: entryNetwork, keyUid };
    } catch (e) {
      info(`[entry] envelope not stored: ${formatError(e)}`);
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
    entryCreatePassword = '';
    entryError = '';
    entryPhase = { kind: 'login' };
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
    sessionSlot = { network: entryNetwork, keyUid };
    sessionOpen = true;
    // Creation continues on the entry flow: the phrase first, then the display name.
    // Both are skippable, and the profile is already complete without them.
    entryPhase = { kind: 'create-seed', password };
  }

  /**
   * Ends the creation wizard and opens the interface.
   *
   * @remarks
   * The default name is what the backend created the profile with
   * (`createAccountAndLogin`), so a skipped name screen is a real answer rather than an
   * empty field: the picker on the next start shows it.
   */
  function finishCreation(): void {
    const keyUid = statusState.accountKeyUid || selectedAccountKeyUid;
    rememberProfileName(keyUid, statusState.alias || 'New stauri user');
    entryPhase = { kind: 'login' };
    showCreateSeed = false;
    activeSection = 'home';
  }

  /** Stores the name chosen in the wizard, then leaves it. */
  async function handleCreateName(name: string): Promise<void> {
    entryError = '';
    const keyUid = statusState.accountKeyUid || selectedAccountKeyUid;
    try {
      await saveSetting('display-name', name);
      statusState.alias = name;
      rememberProfileName(keyUid, name);
      // The contact record carries the name into chats. A messenger that is not up yet
      // is not a reason to fail the wizard: the setting is saved either way.
      sendContactUpdates('').catch(() => undefined);
    } catch (e) {
      entryError = formatError(e);
      return;
    }
    finishCreation();
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
    const problem = pinOpenProblem(pairingPin, pinMax);
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
    // The slot recorded when the session opened is the one the PIN was written to. The
    // fallbacks only matter for a session that never had an envelope, which `lockSession`
    // refuses to lock anyway — but they must not silently point a pad at another profile.
    lockedNetwork =
      sessionSlot?.network ??
      (selectedNetwork === 'mainnet' ? 'mainnet' : 'testnet');
    lockedKeyUid =
      sessionSlot?.keyUid ||
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
  async function lockSession(): Promise<void> {
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
    // The flag records how the session was opened, not that the envelope is still there:
    // a profile restored, synced or reset since has none, and a pad over it would refuse
    // every PIN. Checked here so the dead end is never shown in the first place.
    const state = await pinState(lockedNetwork, lockedKeyUid).catch(() => 'missing' as const);
    if (state !== 'ready') {
      info(`[lock] not locking: PIN slot is ${state}`);
      return;
    }
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
    const problem = pinOpenProblem(lockPin, pinMax);
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
    } catch (e) {
      // The backend's message carries the attempts left, which is what the user needs.
      const message = formatError(e);
      // A failure this pad can never get past: there is no envelope for the profile any
      // more (it was restored, synced or reset after the session was opened by PIN), or
      // the envelope cannot be read. Every PIN would end here, so the lock is dropped and
      // the entry flow — password and phrase — is the way back. A wrong PIN and a full
      // attempt counter stay on the pad: those have an answer.
      if (isMissingPinError(message) || /damaged|corrupt/i.test(message)) {
        info('[lock] session cannot be reopened, returning to the entry flow');
        appLocked = false;
        sessionHasPin = false;
        sessionSlot = null;
        sessionOpen = false;
        lockPin = '';
        lockError = '';
        entryPhase = { kind: 'login' };
        return;
      }
      lockError = message;
      lockPin = '';
    } finally {
      lockBusy = false;
    }
  }

  /**
   * Leaves the lock for the full entry screen.
   *
   * @remarks
   * The pad is the way back into the open session and nothing else: someone who wants
   * another profile, a new one, or a sync has no other door, and being held on the keypad
   * with no way out is a dead end. The backend session stays up — the same state the lock
   * itself leaves behind — so returning to the picker loses nothing.
   */
  function leaveLockedSession(): void {
    info('[lock] left the lock screen for the entry flow');
    appLocked = false;
    sessionHasPin = false;
    sessionSlot = null;
    sessionOpen = false;
    lockPin = '';
    lockError = '';
    entryPhase = { kind: 'login' };
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
    // On the phone `blur` fires for keyboard dismissal and redraws, so only `hidden`
    // counts. On the desktop `blur` fires on every alt-tab, and locking there turned
    // switching windows into a PIN prompt — it is minimising, the explicit act that puts
    // the window away, that locks now.
    const onBlur = () => {
      if (isAndroid()) return;
      window.setTimeout(() => {
        void (async () => {
          try {
            if (!(await getCurrentWindow().isMinimized())) return;
            stopPairingAttempt();
            void lockSession();
          } catch {
            // Not running inside a Tauri window (a plain browser during development).
          }
        })();
      }, 250);
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
    sessionSlot = null;
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
      {#if !mobileEditProfile}
        <button
          type="button"
          onclick={() => (mobileEditProfile = true)}
          class="h-11 w-11 rounded-md bg-card flex items-center justify-center"
 aria-label="Edit profile"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/></svg>
        </button>
      {:else}
        <!-- In edit mode the check ends the editor and returns to the profile pane. -->
        <button
          type="button"
          onclick={() => (mobileEditProfile = false)}
          class="h-11 w-11 rounded-md bg-card flex items-center justify-center"
 aria-label="Done"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
        </button>
      {/if}
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
      {:else if activeSection === 'home'}
        <!--
          Home owns the whole pane on a phone: the list of subsections is the start screen,
          and an open subsection replaces it with a way back. This branch used to be folded
          into the profile one and rendered the desktop list, so a tap only highlighted the
          item and the text never appeared.
        -->
        <HomeMain
          sections={aboutSections}
          bind:topic={homeSection}
          compact={true}
          onNavigate={(s) => activeSection = s}
          onBack={() => (homeSection = null)}
        />
      {:else if activeSection === 'profile'}
        <!--
          The editor, the pairing screen and the seed screen belong to the Profile section.
          The branch used to treat `home` the same way, so a leftover `mobileEditProfile`
          flag made Home render the profile editor — the user signed in after restoring a
          phrase and landed on Edit.page instead of Home.
        -->
        {#if activeSection === 'profile' && mobileEditProfile}
   <EditProfile compact={true} onNavigate={(s) => { mobileEditProfile = false; activeSection = s; }} />
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
          <HomeLeft sections={aboutSections} active={homeSection} onSelect={(id) => (homeSection = id)} />
        {:else if activeSection === 'profile'}
   <ProfileLeft
     compact={isMobile}
     onDisconnect={handleDisconnect}
     onCreateSeed={() => { activeSection = 'profile'; showCreateSeed = true; }}
     onEditProfile={openEditProfile}
     onSendProfile={handleOpenSendProfile}
     onOpenSettings={() => (activeSection = 'settings')}
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
     compact={isMobile}
     onDisconnect={handleDisconnect}
     onCreateSeed={() => { activeSection = 'profile'; showCreateSeed = true; }}
     onEditProfile={openEditProfile}
     onOpenSettings={() => (activeSection = 'settings')}
   />
 {/if}
      </SectionPane>
    {/snippet}

    {#snippet rightPane()}
      <SectionPane>
 {#if activeSection === 'home'}
   <HomeMain
     sections={aboutSections}
     topic={homeSection}
     compact={false}
     onNavigate={(s) => activeSection = s}
   />
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
            <EditProfile compact={false} onNavigate={(s) => activeSection = s} />
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
          <HomeMain
            sections={aboutSections}
            topic={homeSection}
            compact={false}
            onNavigate={(s) => activeSection = s}
          />
        {/if}
      </SectionPane>
    {/snippet}

<div class="flex flex-col bg-background {shellVisible ? 'h-[100dvh] overflow-hidden' : 'min-h-[100dvh]'}">
  <!-- Testnet banner -->
  {#if statusState.isTestnet}
    <div class="shrink-0 bg-warning text-warning-foreground text-center py-2 px-4 font-semibold text-sm">
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
    <PinEntry
      bind:value={lockPin}
      minLength={pinMin}
      maxLength={pinMax}
      title={i18n.t('Enter your PIN')}
      busy={lockBusy}
      error={lockError}
      onSubmit={handleUnlock}
      onBack={leaveLockedSession}
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
    entryPhase.kind === 'create-pin' ||
    entryPhase.kind === 'create-seed' ||
    entryPhase.kind === 'create-name'
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
        onCheckLocal={isMnemonicProfileLocal}
        pinRules={credentialRules}
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
    {:else if entryPhase.kind === 'create-seed'}
      <!--
        The wizard's second step. The account already exists, so the phrase is shown with
        a way past it: a profile without a written phrase still works here, but the wallet
        cannot be restored or spent from elsewhere, and the screen says so.
      -->
      <CreateSeed
        onSave={() => (entryPhase = { kind: 'create-name' })}
        onSkip={() => (entryPhase = { kind: 'create-name' })}
      />
    {:else if entryPhase.kind === 'create-name'}
      <!-- The third step: a setting, not a prerequisite. Skipping keeps "New stauri user". -->
      <CreateName
        initial={statusState.alias || 'New stauri user'}
        busy={entryBusy}
        error={entryError}
        onSave={handleCreateName}
        onSkip={finishCreation}
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
 title={mobileTitle}
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
