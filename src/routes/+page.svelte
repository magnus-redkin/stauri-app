<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';
  import { getCurrentWindow } from '@tauri-apps/api/window';
  import { formatError } from '$lib/utils/errors';

  // Сторы
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

  import { resetContacts } from '$lib/stores/contactsStore.svelte';
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


  // История раздела пока пустая: стрелки появятся, когда разделы начнут её вести.
  // Карандаш в мобильной шапке: Profile открывает редактирование, Wallet — список аккаунтов.
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

  // Навигация
  let activeSection = $state('home');
  // Мобильный layout: одна панель, нижнее меню. Порог — ширина окна (≤ 768px).
  let isMobile = $state(false);
  // Какая панель раздела видна в мобильном layout: LP или RP.
  $effect(() => {
    const mq = window.matchMedia('(max-width: 768px)');
    const update = () => (isMobile = mq.matches);
    update();
    mq.addEventListener('change', update);
    return () => mq.removeEventListener('change', update);
  });
  let showRecovery = $state(false);
  let showCreateSeed = $state(false);

  // Выбор аккаунта для логина
  let selectedAccountKeyUid = $state('');
  let selectedNetwork = $state('mainnet');

  const hasProfiles = $derived(statusState.accounts.length > 0); // <-- Добавить

  // Ctrl+Q
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
   * Горячие клавиши: масштаб и навигация.
   *
   * ## Почему здесь `capture: true`
   *
   * Поверхность webview перехватывает часть сочетаний раньше bubbling-фазы:
   * без capture `Ctrl+«+»` иногда достаётся встроенному зуму WebKit, и тогда
   * масштабируется вся страница вместе с прокруткой, а не только шрифт.
   * К тому же наложение формы (например, поиска) не должно «съедать»
   * навигацию — capture гарантирует, что мы увидим событие первыми.
   *
   * ## Почему не `zoom_hotkeys_enabled` Tauri
   *
   * Встроенный зум масштабирует весь viewport, включая размеры полей в
   * `rem` и `px` одинаково. Нам нужен именно размер текста, который в
   * Настройках уже настраивается ползунком: два разных механизма дали бы
   * несогласованное состояние. Поэтому масштаб один — `uiStore`.
   */
  $effect(() => {
    const handleShortcut = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;

      // Ctrl+«+» / Ctrl+«-» / Ctrl+0. Клавиши сравниваем по `code` и по
      // `key`: на разных раскладках «+» приходит как `=` (без Shift),
      // `+`, `Equal` или `NumpadAdd` — проверяем все варианты.
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

      // Alt+← / Alt+→ — навигация назад/вперёд.
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
   * Применение снимка истории.
   *
   * Функция регистрируется до первого `record`, чтобы шаг назад сразу после
   * старта не оказался пустым. Все поля выставляем явно: снимок полный, и
   * частичное восстановление оставило бы, например, открытое сообщество при
   * переходе в другой раздел.
   */
  registerNavigationApplier((snap) => {
    showRecovery = snap.showRecovery;
    showCreateSeed = snap.showCreateSeed;
    dappsState.active = (snap.dappView as typeof dappsState.active) ?? null;

    // Сообщество ищем в каталоге: восстанавливать надо объект, а не id.
    communitiesState.selected = snap.communityId
      ? communitiesState.entries.find((e) => e.id === snap.communityId) ?? null
      : null;

    selectChat(snap.chatId ?? '');
    activeSection = snap.section;
  });

  /**
   * Запись истории.
   *
   * Следим за ключевыми состояниями, а не вызываем `record` в каждом месте
   * навигации: забыть вызов легко, а эффект видит любое изменение — и по
   * клику, и по ссылке, и по горячей клавише.
   *
   * `untrack` нужен, потому что сам `record` пишет `navState`, а чтение
   * `canBack`/`canForward` в шаблоне не должно замыкать эффект.
   */
  $effect(() => {
    const section = activeSection;
    const chatId = chatsState.selected?.id ?? null;
    const dappView = dappsState.active;
    const communityId = communitiesState.selected?.id ?? null;
    const recovery = showRecovery;
    const createSeed = showCreateSeed;

    // Пишем только когда пользователь вошёл: экран входа — не место, куда
    // стоит возвращаться горячей клавишей.
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

  // Загрузка чатов при входе в раздел.
  //
  // Раньше список грузился только по сигналу `messages.new`, то есть при
  // первом открытии раздела чатов было пусто: сигналов ещё не было, а
  // другого повода загрузить не существовало. В логе это выглядело как
  // «после startMessenger — тишина», хотя пользователь уже был в чате.
  //
  // `untrack` вокруг вызова обязателен: `loadChats` пишет `chatsState`
  // (`loaded`, `isLoading`), и без него эффект перезапускал бы сам себя.
  $effect(() => {
    const section = activeSection;
    const loggedIn = statusState.isLoggedIn;
    if (section === 'chat' && loggedIn) {
      untrack(() => {
        // Вход в раздел открывает справа поиск контактов: иначе остаётся
        // прошлый экран (Invite, новый канал), и формы поиска не видно.
        if (!chatsState.selected) setRightPanel('contacts');
        loadChats();
      });
    }
  });

  // Реагируем на новые сообщения (через lastMessageSignal).
  //
  // `untrack` обязателен: `loadChats` внутри читает и пишет `chatsState`
  // (`loaded`, `isLoading`), а эффект, который читает изменяемое им же
  // состояние, перезапускает сам себя. В логе это выглядело как 6 вызовов
  // подряд с интервалом 5–7 мс вместо одного.
  //
  // Зависимости объявлены явно: номер сигнала и активная секция.
  $effect(() => {
    const signal = statusState.lastMessageSignal;
    const section = activeSection;
    if (signal > 0 && section === 'chat') {
      untrack(() => {
 // Перечитываем список только если сообщение пришло в чат, который в нём
        // виден. Сообщения из снятых с отображения каналов приходят постоянно,
        // и без этой проверки каждое из них тянуло бы полную загрузку
        // (wakuext_communities ~1.6 МБ): отсюда перезагрузки раз в ~30 секунд.
        const visible = new Set(chatsState.items.map((c) => c.id));
        const ids = [...statusState.pendingChatIds];
 const touched = ids.some((id) => visible.has(id));
        // Удаляем только то, что сами проверили: открытая лента читает тот же
 // набор, и полная очистка отняла бы у неё её чат.
        for (const id of ids) if (visible.has(id)) statusState.pendingChatIds.delete(id);
        if (touched) loadChats(true);
      });
    }
  });

  // Загрузка каталога сообществ при входе в раздел.
  //
  // Каталог читается из смарт-контракта и мог не меняться — поэтому
  // грузится один раз за сессию (`loaded`), без force.
  $effect(() => {
    const section = activeSection;
    const loggedIn = statusState.isLoggedIn;
    if (section === 'dapps' && loggedIn) {
      untrack(() => { loadCommunities(); });
    }
  });

  // Сбрасываем CreateSeed при уходе с Profile
  $effect(() => {
    if (activeSection !== 'profile') {
      showCreateSeed = false;
    }
  });


  // wallet
  // fetchOrGetCachedWalletBalances читает кэш бэкенда (forceRefresh в status-go
  // игнорируется), поэтому балансы нужно перечитывать периодически.
  $effect(() => {
    if (statusState.isLoggedIn && activeSection === 'wallet') {
      loadWallet();
      startWalletPolling();
      return () => stopWalletPolling();
    }
    stopWalletPolling();
  });

  onMount(async () => {
    // Настройки отображения применяем первыми: иначе интерфейс на мгновение
    // покажется в размере по умолчанию, хотя пользователь выбрал другой.
    loadUiPreferences();

    // Подписки на внешние ленты и отметки каналов читаются сразу: они нужны
    // списку чатов, а не только разделу dApp. Ошибка чтения не должна мешать
    // подключению — испорченное хранилище остаётся с пустым списком.
    loadFeeds();
    await connect(undefined);
    if (statusState.accounts.length > 0) {
      selectedAccountKeyUid = statusState.accounts[0]["key-uid"];
    }
  });

  async function handleNetworkChange(network: string) {
    await changeNetwork(network);
    selectedNetwork = network;

    // Смена сети — это другой каталог данных, а значит другой набор профилей.
    // Ключ, выбранный на предыдущей сети, в новой базе не существует, и вход
    // с ним падает на чтении `kdfIterations`:
    //   failed to get account kdf iterations number: sql: no rows in result set
    // (`GetAccountKDFIterationsNumber` ищет строку по keyUid в accounts.sql).
    //
    // Раньше ключ выставлялся только в onMount, поэтому после переключения
    // оставался от mainnet-профиля — и войти в профиль Sepolia было нельзя.
    selectedAccountKeyUid = statusState.accounts[0]?.['key-uid'] ?? '';
  }

  async function handleLogin(password: string) {
    if (!selectedAccountKeyUid) return;

    // Защита от устаревшего ключа: вход с ключом из другого профиля падает
    // на чтении `kdfIterations` («sql: no rows in result set»), и текст этой
    // ошибки ничего не объясняет пользователю. Если такого ключа в текущем
    // наборе нет — значит, сменилась сеть или данные профиля; берём первый
    // доступный вместо того, чтобы отдавать в бэкенд заведомо чужой.
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
      // После создания аккаунт автоматически логинится (через waitForLogin)
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
   * Клик по иконке в нулевой колонке.
   *
   * Два случая ведут себя по-разному, и это важно:
   *   * переход в другой раздел — обычная навигация, ничего сбрасывать не
   *     нужно;
   *   * повторный клик по уже активной вкладке — просьба «верни меня к
   *     началу». `activeSection` при этом не меняется, поэтому эффекты,
   *     следящие за ней, не сработают, и сброс делаем явно.
   *
   * dApps: возврат к списку примеров. Без этого из открытого каталога
   * сообществ было не выбраться — оставалась только кнопка «обновить».
   */
  function handleSectionSelect(id: string) {
    // Раздел открывается заново с его первого экрана.
    mobileEditProfile = false;
    mobileWalletAccounts = false;
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
    // Пароль для подписи переводов живёт в памяти сессии — при выходе его
    // нужно стереть, иначе следующий профиль на этой машине унаследует
    // чужой пароль в памяти вкладки.
    resetSend();
    // Состояние регистрации имени принадлежит профилю: чужое имя в поле и
    // чужой владелец на экране — это ровно то, что нельзя показывать после
    // смены аккаунта.
    resetEns();
    // История переходов принадлежит профилю: вернуться в чаты предыдущего
    // аккаунта нельзя, а переход по чужой истории показал бы пустые экраны.
    resetNavigation();
    // Seed-фраза лежит в памяти Rust, и её стирал только `onDestroy` экрана
    // создания seed. При выходе из аккаунта фраза оставалась в памяти до
    // закрытия приложения — то есть следующий профиль на этой машине мог её
    // получить, а при XSS она была бы доступна через `seed_word`.
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
  <!-- Плашка Testnet -->
  {#if statusState.isTestnet}
    <div class="bg-orange-500 text-white text-center py-2 px-4 font-semibold text-sm">
      ⚠️ {statusState.networkName.toUpperCase()} TESTNET MODE — All balances and transactions are on testnets.
    </div>
  {/if}

  <!-- Спиннер -->
  {#if connectionState.isConnecting}
    <div class="flex flex-col items-center justify-center min-h-screen gap-4">
      <div class="w-10 h-10 border-4 border-muted border-t-primary rounded-full animate-spin"></div>
      <h2 class="text-2xl font-semibold text-foreground">Connecting...</h2>
    </div>

  <!-- Экран входа -->
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

  <!-- Основной интерфейс -->
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
   Панели прокручиваются сами, а не каждый раздел по отдельности.

   `SectionPane` даёт обеим панелям определённую высоту и внешнюю
          прокрутку. Разделы, у которых есть своя прокрутка (список чатов,
   кошелёк), занимают ровно высоту панели — внешняя не появляется.
   Раздел без своей прокрутки, оказавшийся длиннее панели, получает
   её здесь, и проверять это в каждом новом разделе не нужно.
        -->
        <Pane defaultSize={30} minSize={20} class="h-full overflow-hidden border-r border-border">
   {@render leftPane()}
        </Pane>

        <PaneResizer class="w-1 bg-border hover:bg-primary transition-colors cursor-col-resize" />

        <!-- MAIN PANEL -->
        <Pane defaultSize={70} class="h-full overflow-hidden bg-card">
   {@render rightPane()}
        </Pane>
      </PaneGroup>
    </div>
    {/if}
  {/if}
</div>
