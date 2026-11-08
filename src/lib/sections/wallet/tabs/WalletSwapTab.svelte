<script lang="ts">
  /**
   * Обмен токенов внутри одной сети.
   *
   * ## Почему только mainnet
   *
   * Ликвидности в тестовых сетях у провайдеров нет: Sepolia-обмен невозможен
   * в принципе, а не «пока не сделали». Поэтому на тестовой сети показываем
   * объяснение, а не форму, которая заведомо откажет.
   *
   * ## Почему проскальзывание не настраивается
   *
   * 1 % — компромисс между «обмен проходит» и «не обделили». Свободное поле
   * здесь опасно: необдуманные 10 % — прямой убыток, а человек, который
   * понимает, что делает, всё равно не должен искать это в первом прогоне.
   * Значение показано на экране и совпадает с зашитым в `swap.rs`.
   *
   * ## Пароль
   *
   * Общий на сессию (`sendStore`): любой обмен — это подпись, и спрашивать
   * пароль в третьем месте подряд незачем.
   */
  import { i18n } from '$lib/i18n';
  import { walletState } from '$lib/stores/walletStore.svelte';
  import { sendState, rememberPassword } from '$lib/stores/sendStore.svelte';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import {
    swapState,
    SWAP_CHAINS,
    SLIPPAGE_PERCENT,
    swapSources,
    swapTargets,
    findToken,
    tokenKeyOf,
    quoteSwap,
    performSwap,
    backToSwapForm,
    flipTokens,
  } from '$lib/stores/swapStore.svelte';
  import { checkAmountAgainstBalance } from '$lib/utils/tokens';
  import { formatUnits } from '$lib/utils/amount';
  import { formatBalance } from '$lib/utils/format';
  import { CHAIN_NAMES } from '$lib/utils/assetGroups';
  import { explorerTxUrl } from '$lib/utils/explorer';
  import PasswordInput from '$lib/sections/auth/PasswordInput.svelte';
  import { invoke } from '@tauri-apps/api/core';

  let passwordInput = $state('');

  const supported = $derived(SWAP_CHAINS.has(statusState.chainId));

  const sources = $derived(swapSources(walletState.balances));

  /** Исходный токен; от него зависит, какие сети и цели предлагать. */
  const fromToken = $derived(findToken(walletState.balances, swapState.fromKey));

  /** Цели — токены той же сети, что у источника. */
  const targets = $derived(swapTargets(walletState.balances, fromToken?.chainId ?? null));

  const toToken = $derived(findToken(walletState.balances, swapState.toKey));

  const amountCheck = $derived(
    fromToken && swapState.amount.trim()
      ? checkAmountAgainstBalance(swapState.amount, fromToken)
      : null
  );

  const sameToken = $derived(
    !!fromToken && !!toToken && fromToken.tokenAddress === toToken.tokenAddress
  );

  const maxOut = $derived(
    toToken && swapState.amountOut !== null
      ? formatUnits(swapState.amountOut, toToken.decimals)
      : ''
  );

  const minOut = $derived(
    toToken && swapState.minAmountOut !== null
      ? formatUnits(swapState.minAmountOut, toToken.decimals)
      : ''
  );

  const canReview = $derived(
    supported &&
      !!fromToken &&
      !!toToken &&
      !sameToken &&
      amountCheck?.ok === true &&
      !swapState.isQuoting
  );

  const explorerUrl = $derived(
    fromToken ? explorerTxUrl(fromToken.chainId, swapState.txHash) : null
  );

  async function goToConfirm() {
    if (!fromToken || !toToken || amountCheck?.ok !== true) return;
    swapState.error = '';
    swapState.step = 'confirm';
    await quoteSwap(fromToken, toToken, swapState.amount);
  }

  async function submitPassword() {
    if (!fromToken || !toToken || !passwordInput.trim()) return;
    rememberPassword(passwordInput);
    passwordInput = '';
    await performSwap(fromToken, toToken, swapState.amount);
  }

  async function confirmSwap() {
    if (!fromToken || !toToken) return;
    await performSwap(fromToken, toToken, swapState.amount);
  }

  async function openExplorer() {
    if (!explorerUrl) return;
    try {
      await invoke('open_external', { url: explorerUrl });
    } catch (e) {
      console.error('[swap] failed to open explorer', e);
    }
  }

  /** Подставляет весь баланс: точной строкой, а не обрезанной. */
  function useMax() {
    if (!fromToken) return;
    swapState.amount = formatUnits(BigInt(fromToken.balance || '0'), fromToken.decimals);
  }

  function chainName(chainId: number): string {
    return CHAIN_NAMES[chainId] ?? String(chainId);
  }
</script>

<div class="h-full flex flex-col p-6 overflow-auto">
  <h3 class="text-lg font-semibold mb-4">{i18n.t('Swap')}</h3>

  {#if !supported}
    <div class="max-w-md space-y-2">
      <p class="text-sm text-muted-foreground">
        {i18n.t('Swapping works only on mainnet networks: providers have no liquidity in test networks.')}
      </p>
      <p class="text-xs text-muted-foreground">
        {i18n.t('Switch the network to Ethereum, Optimism, Arbitrum, Base or BNB Chain.')}
      </p>
    </div>

  {:else if swapState.step === 'done'}
    <div class="space-y-4 max-w-md">
      <div class="p-4 rounded-md border border-green-300 bg-green-50 text-green-900">
        <p class="font-medium">{i18n.t('Swap executed')}</p>
        {#if swapState.txHash}
          <p class="text-xs font-mono break-all mt-2">{swapState.txHash}</p>
          {#if explorerUrl}
            <button onclick={openExplorer} class="text-xs text-primary hover:underline mt-2">
              {i18n.t('Open in explorer')}
            </button>
          {/if}
        {/if}
        {#if swapState.approvalTxHash}
          <!--
            Обмен из двух транзакций: approve, затем сам обмен. Показываем
            оба — иначе человек не поймёт, почему в истории их два.
          -->
          <p class="text-xs text-muted-foreground mt-2">{i18n.t('Approval transaction')}:</p>
          <p class="text-xs font-mono break-all">{swapState.approvalTxHash}</p>
        {/if}
      </div>
      <button
        onclick={backToSwapForm}
        class="w-full py-2 border border-border rounded-md text-sm font-medium"
      >
        {i18n.t('Swap again')}
      </button>
    </div>

  {:else if swapState.step === 'form'}
    <div class="space-y-4 max-w-md">
      <!-- Отдаём -->
      <div>
        <div class="flex items-center justify-between">
          <label class="text-sm font-medium" for="swap-from">{i18n.t('From')}</label>
          {#if fromToken}
            <div class="flex items-center gap-2">
              <span class="text-xs text-muted-foreground">
                {i18n.t('Balance')}:
                {formatBalance(fromToken.balance, fromToken.decimals)}
              </span>
              <button onclick={useMax} class="text-xs text-primary hover:underline">
                {i18n.t('Max')}
              </button>
            </div>
          {/if}
        </div>
        <select
          id="swap-from"
          bind:value={swapState.fromKey}
          class="w-full h-10 border border-input rounded-md px-3 mt-1 bg-background"
        >
          <option value="">{i18n.t('Select token')}</option>
          {#each sources as t (tokenKeyOf(t))}
            <option value={tokenKeyOf(t)}>
              {t.symbol} — {formatBalance(t.balance, t.decimals)} ({chainName(t.chainId)})
            </option>
          {/each}
        </select>
        <input
          bind:value={swapState.amount}
          inputmode="decimal"
          spellcheck="false"
          placeholder="0.0"
          class="w-full h-10 border border-input rounded-md px-3 mt-2 bg-background font-mono text-sm"
        />
        {#if amountCheck && !amountCheck.ok}
          <p class="text-xs text-destructive mt-1">{i18n.t(amountCheck.error)}</p>
        {/if}
      </div>

      <!-- Меняем местами -->
      <div class="flex justify-center">
        <button
          onclick={flipTokens}
          class="px-3 py-1.5 rounded-md border border-border text-xs hover:bg-secondary transition-colors"
          title={i18n.t('Swap direction')}
        >
          ⇅
        </button>
      </div>

      <!-- Получаем -->
      <div>
        <label class="text-sm font-medium" for="swap-to">{i18n.t('To')}</label>
        <select
          id="swap-to"
          bind:value={swapState.toKey}
          disabled={!fromToken}
          class="w-full h-10 border border-input rounded-md px-3 mt-1 bg-background disabled:opacity-50"
        >
          <option value="">{i18n.t('Select token')}</option>
          {#each targets as t (tokenKeyOf(t))}
            <option value={tokenKeyOf(t)}>
              {t.symbol}{t.hasError ? ` (${i18n.t('RPC error')})` : ''}
            </option>
          {/each}
        </select>
        {#if sameToken}
          <p class="text-xs text-destructive mt-1">
            {i18n.t('Source and target tokens must be different')}
          </p>
        {/if}
      </div>

      <p class="text-xs text-muted-foreground">
        {i18n.t('The swap goes through an external provider. Slippage tolerance:')}
        {SLIPPAGE_PERCENT}%
      </p>

      <button
        disabled={!canReview}
        onclick={goToConfirm}
        class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
      >
        {i18n.t('Review')}
      </button>
    </div>

  {:else}
    <!-- Подтверждение, отправка и отказ — в одной ветке: при отказе форма
         не должна исчезать, чаще всего достаточно поправить сумму. -->
    <div class="space-y-4 max-w-md">
      <div class="border border-border rounded-lg divide-y divide-border">
        <div class="p-3 flex justify-between gap-3">
          <span class="text-xs text-muted-foreground">{i18n.t('Network')}</span>
          <span class="text-sm font-medium text-right">
            {fromToken ? chainName(fromToken.chainId) : ''}
          </span>
        </div>
        <div class="p-3 flex justify-between gap-3">
          <span class="text-xs text-muted-foreground">{i18n.t('You pay')}</span>
          <span class="text-sm font-medium font-mono text-right">
            {amountCheck?.ok && fromToken
              ? formatUnits(amountCheck.amount, fromToken.decimals)
              : swapState.amount}
            {fromToken?.symbol ?? ''}
          </span>
        </div>
        <div class="p-3 flex justify-between gap-3">
          <span class="text-xs text-muted-foreground">{i18n.t('You receive')}</span>
          <span class="text-sm font-medium font-mono text-right">
            {#if swapState.isQuoting}
              {i18n.t('Estimating...')}
            {:else if swapState.amountOut !== null}
              {maxOut} {toToken?.symbol ?? ''}
              <div class="text-[0.625rem] text-muted-foreground font-sans text-right">
                {i18n.t('at least')} {minOut}
              </div>
            {:else}
              {i18n.t('Calculated when sending')}
            {/if}
          </span>
        </div>
        <div class="p-3 flex justify-between gap-3">
          <span class="text-xs text-muted-foreground">{i18n.t('Network fee')}</span>
          <span class="text-sm font-medium font-mono text-right">
            {#if swapState.fee !== null}
              {formatUnits(swapState.fee, 18)}
              <div class="text-[0.625rem] text-muted-foreground font-sans text-right">
                {i18n.t('estimate, the final value is set by the network')}
              </div>
            {:else}
              {i18n.t('Calculated when sending')}
            {/if}
          </span>
        </div>
        {#if swapState.needsApproval}
          <!--
            Две транзакции вместо одной: сначала разрешение контракту
            распоряжаться токеном, затем обмен. Человек должен знать об этом
            заранее — иначе вторая подпись выглядит неожиданно.
          -->
          <div class="p-3 text-xs text-muted-foreground">
            {i18n.t('Two transactions will be sent: a token approval and the swap itself.')}
          </div>
        {/if}
        {#if swapState.provider}
          <div class="p-3 flex justify-between gap-3">
            <span class="text-xs text-muted-foreground">{i18n.t('Provider')}</span>
            <span class="text-sm font-medium">{swapState.provider}</span>
          </div>
        {/if}
      </div>

      {#if swapState.quoteError}
        <p class="text-sm text-destructive break-words">{swapState.quoteError}</p>
      {/if}
      {#if swapState.error}
        <p class="text-sm text-destructive break-words">{swapState.error}</p>
      {/if}

      {#if swapState.step === 'sending'}
        <p class="text-sm text-muted-foreground">
          {i18n.t('Swapping... this can take a while.')}
        </p>
      {:else if sendState.needsPassword || !sendState.password}
        <div>
          <label class="text-sm font-medium" for="swap-password">{i18n.t('Password')}</label>
          <p class="text-xs text-muted-foreground mt-1 mb-2">
            {i18n.t('Needed to sign the transaction. Kept in memory until you log out.')}
          </p>
          <PasswordInput
            bind:value={passwordInput}
            onEnter={submitPassword}
            autofocus={true}
            disabled={swapState.amountOut === null}
          />
        </div>
        <button
          onclick={submitPassword}
          disabled={!passwordInput.trim() ||
            swapState.isSending ||
            swapState.amountOut === null}
          class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
        >
          {i18n.t('Confirm and swap')}
        </button>
      {:else}
        <button
          onclick={confirmSwap}
          disabled={swapState.isSending || swapState.amountOut === null}
          class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
        >
          {i18n.t('Confirm and swap')}
        </button>
      {/if}

      <button
        onclick={backToSwapForm}
        disabled={swapState.isSending}
        class="w-full py-2 border border-border rounded-md text-sm font-medium disabled:opacity-50"
      >
        {i18n.t('Back')}
      </button>
    </div>
  {/if}
</div>
