<script lang="ts">
  /**
   * Регистрация имени ENS внутри раздела профиля.
   *
   * ## Почему блок, а не вкладка кошелька
   *
   * Имя `<имя>.stateofus.eth` — это свойство профиля, а не кошелька: оно
   * привязано к личности в Status и видно собеседникам как адрес для перевода.
   * В кошельке оно оказалось по ошибке — там его искали рядом с «Отправить»,
   * но менять его человек идёт в профиль, где уже стоят имя и аватар.
   *
   * ## Почему своим паролем, а не из сессии
   *
   * В кошельке пароль уже лежал в памяти (`sendStore`) после первого перевода,
   * и брать его оттуда было естественно. В профиль человек может прийти, ни
   * разу не отправив перевод, поэтому пароль спрашивается здесь и после
   * успешной регистрации запоминается в общей сессии — следующая отправка
   * уже не спросит.
   *
   * ## Почему поле — только имя
   *
   * Регистратор хэширует ровно тот label, который ему передали. Ввести `.eth`
   * в поле значило бы получить `.eth.stateofus.eth`. Домен показан рядом.
   */
  import { i18n } from '$lib/i18n';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import { walletState } from '$lib/stores/walletStore.svelte';
  import { sendState, rememberPassword } from '$lib/stores/sendStore.svelte';
  import {
    ensState,
    ensSupported,
    usernameError,
    checkName,
    goToConfirm,
    registerName,
    backToEnsForm,
    chainBalances,
    ENS_DOMAIN,
  } from '$lib/stores/ensStore.svelte';
  import { formatUnits } from '$lib/utils/amount';
  import { CHAIN_NAMES } from '$lib/utils/assetGroups';
  import { explorerTxUrl } from '$lib/utils/explorer';
  import PasswordInput from '$lib/sections/auth/PasswordInput.svelte';
  import { invoke } from '@tauri-apps/api/core';

  let passwordInput = $state('');

  const chainId = $derived(statusState.chainId);
  const chainName = $derived(CHAIN_NAMES[chainId] ?? String(chainId));
  const supported = $derived(ensSupported(chainId));

  /** Залоговый токен: на Sepolia это STT, на mainnet — SNT. */
  const stakeSymbol = $derived(chainId === 11155111 ? 'STT' : 'SNT');

  const nameError = $derived(usernameError(ensState.username));
  const canReview = $derived(!!ensState.username.trim() && !nameError && supported);

  /**
   * Балансы, которые решают, пройдёт ли регистрация.
   *
   * `$derived` от `walletState.balances`: как только кошелёк перечитает
   * балансы (после перевода или по кнопке «Обновить»), цифры здесь тоже
   * обновятся, без перезагрузки профиля.
   */
  const balances = $derived(chainBalances(chainId));

  /** Хватает ли залога: цена известна и баланс не меньше её. */
  const stakeShort = $derived(
    ensState.price !== null && balances.stake !== null && balances.stake < ensState.price
  );

  /**
   * Нет ETH на комиссию.
   *
   * Только явный ноль. `null` означает «баланс ещё не загружен или RPC не
   * ответил» — предупреждать в этом случае значило бы пугать человека без
   * денег при полном кошельке. Неизвестный баланс показывается как «—».
   */
  const nativeShort = $derived(balances.native === 0n);

  /**
   * Почему регистрация заведомо не пройдёт. Пустая строка — можно.
   *
   * ## Почему блокируем заранее
   *
   * Без этого человек исправно доходит до поля пароля, вводит его и получает
   * отказ от контракта — уже после того, как набрал пароль и нажал кнопку.
   * Отказ при этом не про пароль, и понять это из текста ошибки трудно.
   *
   * ## Почему блокируем только на достоверных данных
   *
   * `null` в балансе — «неизвестно», а не «ноль». Блокировать на неизвестном
   * значило бы запрещать регистрацию при полном кошельке, если балансы ещё не
   * подгрузились. Поэтому блокируют только: имя занято, сеть не поддерживается,
   * известный баланс меньше залога, известный ETH ровно ноль.
   *
   * ## Почему не блокируем, пока имя не проверено
   *
   * Цена неизвестна (`price === null`) — значит и сравнивать не с чем; в этом
   * случае отправку не запрещаем, а уточняем при нажатии.
   */
  const blockedReason = $derived.by(() => {
    if (!supported) return 'ens-blocked-unsupported';
    if (ensState.taken) return 'ens-blocked-taken';
    if (
      ensState.price !== null &&
      balances.stake !== null &&
      balances.stake < ensState.price
    ) {
      return 'ens-blocked-stake';
    }
    if (balances.native === 0n) return 'ens-blocked-native';
    return '';
  });

  const canRegister = $derived(blockedReason === '');

  const explorerUrl = $derived(explorerTxUrl(chainId, ensState.txHash));

  async function submitPassword() {
    if (!passwordInput.trim()) return;
    rememberPassword(passwordInput);
    passwordInput = '';
    await registerName();
  }

  async function openExplorer() {
    if (!explorerUrl) return;
    try {
      await invoke('open_external', { url: explorerUrl });
    } catch (e) {
      console.error('[ens] failed to open explorer', e);
    }
  }
</script>

<div class="flex flex-col gap-2">
  <label class="text-sm font-medium text-foreground" for="ens-name">{i18n.t('ENS name')}</label>

  {#if !supported}
    <!--
      Регистратор Status развёрнут только в mainnet и Sepolia. На прочих
      сетях не показываем форму, по которой заведомо придёт отказ.
    -->
    <p class="text-xs text-muted-foreground">
      {i18n.t('ENS names can be registered only on Ethereum mainnet or Sepolia.')}
    </p>

  {:else if ensState.step === 'done'}
    <div class="p-3 rounded-lg border border-green-300 bg-green-100 text-green-900">
      <p class="text-sm font-medium">{i18n.t('Name registered')}</p>
      <p class="text-sm font-mono break-all mt-1">{ensState.fullName}</p>
      {#if ensState.txHash}
        <p class="text-xs font-mono break-all mt-2">{ensState.txHash}</p>
        {#if explorerUrl}
          <button onclick={openExplorer} class="text-xs text-primary hover:underline mt-2">
            {i18n.t('Open in explorer')}
          </button>
        {/if}
      {/if}
    </div>
    <p class="text-xs text-muted-foreground">
      {i18n.t('The deposit is held by the registrar and can be returned after a year.')}
    </p>
    <button
      onclick={backToEnsForm}
      class="text-sm text-primary hover:underline text-left"
    >
      {i18n.t('Register another name')}
    </button>

  {:else if ensState.step === 'form'}
    <div class="flex items-center gap-2">
      <input
        id="ens-name"
        bind:value={ensState.username}
        onblur={checkName}
        placeholder="myname"
        spellcheck="false"
        class="flex-1 h-10 border border-input rounded-md px-3 bg-background font-mono text-sm"
      />
      <span class="text-sm text-muted-foreground shrink-0">.{ENS_DOMAIN}</span>
    </div>

    {#if nameError && ensState.username.trim()}
      <p class="text-xs text-destructive">{i18n.t(nameError)}</p>
    {:else if ensState.isChecking}
      <p class="text-xs text-muted-foreground">{i18n.t('Checking...')}</p>
    {:else if ensState.taken}
      <p class="text-xs text-destructive break-all">
        {i18n.t('This name is already taken')} — {ensState.owner}
      </p>
    {:else if ensState.checkError}
      <p class="text-xs text-muted-foreground">{ensState.checkError}</p>
    {:else if ensState.price !== null}
      <p class="text-xs text-muted-foreground">
        {i18n.t('Available')} — {formatUnits(ensState.price, 18)} {stakeSymbol}
      </p>
    {/if}

    <button
      disabled={!canReview}
      onclick={goToConfirm}
      class="w-full py-2 border border-border rounded-md text-sm font-medium disabled:opacity-50"
    >
      {i18n.t('Register')}
    </button>

    <!--
      Что есть на счету. Без этого единственным ответом на «почему не идёт»
      было бы сообщение об ошибке после нажатия кнопки: маршрут не строится
      без залога, и комиссия остаётся неизвестной.
    -->
    <div class="text-xs text-muted-foreground flex flex-wrap gap-x-3 gap-y-1">
      <span>
        {stakeSymbol}:
        <span class="font-mono {stakeShort ? 'text-destructive' : ''}">
          {#if balances.stake !== null}
            {formatUnits(balances.stake, 18)}
          {:else}
            —
          {/if}
        </span>
      </span>
      <span>
        ETH:
        <span class="font-mono {nativeShort ? 'text-destructive' : ''}">
          {#if balances.native !== null}
            {formatUnits(balances.native, 18)}
          {:else}
            —
          {/if}
        </span>
      </span>
    </div>

    {#if stakeShort}
      <p class="text-xs text-destructive">
        {i18n.t('Not enough for the deposit')} — {i18n.t('Top up the wallet first')}
      </p>
    {:else if nativeShort}
      <p class="text-xs text-destructive">
        {i18n.t('No ETH on this network to pay the network fee')}
      </p>
    {/if}

  {:else}
    <!-- Подтверждение, отправка и отказ. При отказе форма не исчезает:
         чаще всего достаточно повторить пароль, а не набирать имя заново. -->
    <div class="border border-border rounded-lg divide-y divide-border text-sm">
      <div class="p-2 flex justify-between gap-3">
        <span class="text-xs text-muted-foreground">{i18n.t('Network')}</span>
        <span class="font-medium text-right">{chainName}</span>
      </div>
      <div class="p-2">
        <div class="text-xs text-muted-foreground">{i18n.t('Name')}</div>
        <div class="font-mono break-all mt-1">{ensState.username.trim()}.{ENS_DOMAIN}</div>
      </div>
      <div class="p-2 flex justify-between gap-3">
        <span class="text-xs text-muted-foreground">{i18n.t('Deposit')}</span>
        <span class="font-medium font-mono text-right">
          {#if ensState.price !== null}
            {formatUnits(ensState.price, 18)} {stakeSymbol}
          {:else}
            {i18n.t('Calculated when sending')}
          {/if}
        </span>
      </div>
      <div class="p-2 flex justify-between gap-3">
        <span class="text-xs text-muted-foreground">{i18n.t('Network fee')}</span>
        <span class="font-medium font-mono text-right">
          {#if ensState.fee !== null}
            {formatUnits(ensState.fee, 18)}
            <div class="text-[0.625rem] text-muted-foreground font-sans text-right">
              {i18n.t('estimate, the final value is set by the network')}
            </div>
          {:else}
            {i18n.t('Calculated when sending')}
          {/if}
        </span>
      </div>
      <div class="p-2">
        <div class="text-xs text-muted-foreground">{i18n.t('From')}</div>
        <div class="font-mono break-all mt-1 text-xs">{walletState.address}</div>
      </div>
    </div>

    {#if ensState.error}
      <p class="text-sm text-destructive break-words">{ensState.error}</p>
    {/if}

    {#if ensState.step === 'sending'}
      <p class="text-sm text-muted-foreground">
        {i18n.t('Registering... this can take a while.')}
      </p>
    {:else if sendState.needsPassword || !sendState.password}
      <div>
        <label class="text-sm font-medium" for="ens-password">{i18n.t('Password')}</label>
        <p class="text-xs text-muted-foreground mt-1 mb-2">
          {i18n.t('Needed to sign the transaction. Kept in memory until you log out.')}
        </p>
        <!--
          Поле выключено, когда регистрация заведомо не пройдёт: набирать
          пароль ради отказа от контракта — лишняя работа, а причина уже
          написана ниже.
        -->
        <PasswordInput
          bind:value={passwordInput}
          onEnter={submitPassword}
          autofocus={true}
          disabled={!canRegister}
        />
      </div>
      <button
        onclick={submitPassword}
        disabled={!passwordInput.trim() || ensState.isSending || !canRegister}
        class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
      >
        {i18n.t('Confirm and register')}
      </button>
    {:else}
      <button
        onclick={registerName}
        disabled={ensState.isSending || !canRegister}
        class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
      >
        {i18n.t('Confirm and register')}
      </button>
    {/if}

    {#if !canRegister}
      <p class="text-xs text-destructive">{i18n.t(blockedReason)}</p>
    {/if}

    <button
      onclick={backToEnsForm}
      disabled={ensState.isSending}
      class="w-full py-2 border border-border rounded-md text-sm font-medium disabled:opacity-50"
    >
      {i18n.t('Back')}
    </button>
  {/if}
</div>
