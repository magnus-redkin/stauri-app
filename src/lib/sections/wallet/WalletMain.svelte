<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { walletState, refreshWallet } from '$lib/stores/walletStore.svelte';
  import { walletView, selectWalletTab, type WalletTab } from '$lib/stores/walletView.svelte';
  import { totalBalance, formatTotal } from '$lib/utils/totalBalance';
  import WalletAssetsTab from './tabs/WalletAssetsTab.svelte';
  import WalletSendTab from './tabs/WalletSendTab.svelte';
  import WalletReceiveTab from './tabs/WalletReceiveTab.svelte';
  import WalletBuyTab from './tabs/WalletBuyTab.svelte';
  import WalletSwapTab from './tabs/WalletSwapTab.svelte';
  import WalletAccountsTab from './tabs/WalletAccountsTab.svelte';

  /**
   * Вкладка живёт в сторе, а не здесь: её переключает ещё и ссылка
   * «Управление аккаунтами» в левой панели (см. `walletView.svelte.ts`).
   */
  const activeTab = $derived(walletView.activeTab);

  const tabs: { id: WalletTab; label: string; disabled?: boolean }[] = [
    { id: 'assets', label: i18n.t('Assets') },
    { id: 'send', label: i18n.t('Send') },
    { id: 'receive', label: i18n.t('Receive') },
    // Buy и Swap остаются видимыми, но выключенными: так видно, что они
    // запланированы, и не появляется кнопки, которая ничего не делает.
    { id: 'buy', label: i18n.t('Buy'), disabled: true },
    { id: 'swap', label: i18n.t('Swap') },
  ];

  function selectTab(tab: (typeof tabs)[number]) {
    if (tab.disabled) return;
    selectWalletTab(tab.id);
  }

  async function refresh() {
    await refreshWallet();
  }

  /**
   * Общий баланс по основным сетям.
   *
   * Считается из тех же балансов и цен, что уже загружены, — отдельного
   * запроса нет. Тестовые сети в итог не входят: сеполия-ETH не конвертируется
   * в ETH, и сумма по ним была бы числом, которого нигде нет.
   */
  const total = $derived(totalBalance(walletState.balances, walletState.prices));

  /** В мобильной оболочке заголовок и Reload выводит титульная строка. */
  let { compact = false }: { compact?: boolean } = $props();
</script>

<div class="h-full flex flex-col bg-card overflow-hidden">
  <!-- Шапка: заголовок + адрес + кнопка обновления -->
  {#if !compact}
  <div class="p-6 pb-0 flex justify-between items-start">
    <div>
      <h2 class="text-2xl font-bold text-primary">{i18n.t('All accounts')}</h2>
      <!--
        Итог по основным сетям. «≈» стоит намеренно: сумма собрана из курсов,
        которые меняются, а часть токенов может быть без цены вовсе.
      -->
      {#if total.priced > 0}
        <div class="text-sm font-medium text-foreground mt-1">
          {formatTotal(total.total)}
          {#if total.isPartial}
            <span class="text-xs font-normal text-muted-foreground">
              ({i18n.t('some tokens have no price')})
            </span>
          {/if}
        </div>
      {/if}
      {#if walletState.address}
        <div class="text-xs font-mono text-muted-foreground mt-1 break-all">
          {walletState.address}
        </div>
      {/if}
    </div>
    <!--
      «Обновить» запускает полный перезапрос балансов в бэкенде
      (`wallet_restartWalletReloadTimer`) и перечитывает кэш через паузу.
      Раньше здесь стоял `loadWallet(true)`, который только перечитывал
      кэш: `forceRefresh` в status-go игнорируется, поэтому числа не менялись
      и кнопка выглядела нерабочей.
    -->
    <button
      onclick={refresh}
      disabled={walletState.isRefreshing}
      class="p-2 rounded-md border border-border hover:bg-secondary transition-colors disabled:opacity-50"
      title={walletState.isRefreshing ? i18n.t('Refreshing...') : i18n.t('Refresh')}
      aria-label={i18n.t('Refresh')}
    >
      <span class={walletState.isRefreshing ? 'inline-block animate-spin' : 'inline-block'}>🔄</span>
    </button>
  </div>
  {/if}

  <!-- Кнопки-вкладки -->
  <div class="px-6 mt-4 border-b border-border flex gap-1 overflow-x-auto">
    {#each tabs as tab (tab.id)}
      <button
        onclick={() => selectTab(tab)}
        disabled={tab.disabled}
        class="px-4 py-2 text-sm font-medium rounded-t-md transition-colors whitespace-nowrap
          {activeTab === tab.id
            ? 'text-primary border-b-2 border-primary -mb-px bg-secondary/30'
            : tab.disabled
              ? 'text-muted-foreground/50 cursor-not-allowed'
              : 'text-muted-foreground hover:text-foreground hover:bg-secondary/50'}"
        title={tab.disabled ? i18n.t('Coming soon') : ''}
      >
        {tab.label}
      </button>
    {/each}
  </div>

  <!-- Контент вкладки -->
  <div class="flex-1 overflow-hidden">
    {#if activeTab === 'assets'}
      <WalletAssetsTab />
    {:else if activeTab === 'send'}
      <WalletSendTab />
    {:else if activeTab === 'receive'}
      <WalletReceiveTab />
    {:else if activeTab === 'buy'}
      <WalletBuyTab />
    {:else if activeTab === 'swap'}
      <WalletSwapTab />
    {:else if activeTab === 'accounts'}
      <WalletAccountsTab />
    {/if}
  </div>
</div>
