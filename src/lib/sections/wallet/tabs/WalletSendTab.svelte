<script lang="ts">
  /**
   * Экран отправки средств.
   *
   * ## Почему шаги, а не одна кнопка
   *
   * Между «ввёл» и «улетело» стоит экран подтверждения со всем, что уйдёт:
   * сеть, актив, сумма, получатель, комиссия. Это последняя возможность
   * заметить, что адрес не тот, а перевод в блокчейне не отменяется.
   *
   * ## Почему сумма — строка
   *
   * `<input type="number">` отдаёт `Number` и теряет точность на 18 знаках.
   * Разбор — `parseAmount` на `BigInt` (`utils/amount.ts`).
   *
   * ## Пароль
   *
   * Спрашивается один раз за сессию и хранится в памяти (`sendStore`), не на
   * диске. Сам перевод идёт командой Rust `send_transfer`: подпись и сборка
   * транзакции наружу не выставлены, поэтому XSS не получает ни пароля в
   * постоянное пользование, ни универсальной машинки подписи.
   */
  import { i18n } from '$lib/i18n';
  import { walletState } from '$lib/stores/walletStore.svelte';
  import {
    sendState,
    sendTransfer,
    estimateFee,
    backToForm,
    rememberPassword,
  } from '$lib/stores/sendStore.svelte';
  import { ensAddressOf, ensGetName } from '$lib/status/wallet';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import { formatError } from '$lib/utils/errors';
  import { groupTokensForSending, checkAmountAgainstBalance } from '$lib/utils/tokens';
  import { formatBalance } from '$lib/utils/format';
  import { formatUnits } from '$lib/utils/amount';
  import { CHAIN_NAMES } from '$lib/utils/assetGroups';
  import { explorerTxUrl } from '$lib/utils/explorer';
  import PasswordInput from '$lib/sections/auth/PasswordInput.svelte';
  import { invoke } from '@tauri-apps/api/core';

  let selectedKey = $state('');
  let toAddress = $state('');
  let amount = $state('');
  let passwordInput = $state('');

  const groups = $derived(groupTokensForSending(walletState.balances));

  const selected = $derived(
    groups.available.find((t) => t.key === selectedKey)?.token ??
      groups.unavailable.find((t) => t.key === selectedKey)?.token
  );

  const amountCheck = $derived.by(() => {
    if (!selected || !amount.trim()) return null;
    return checkAmountAgainstBalance(amount, selected);
  });

  /** Похоже ли введённое на адрес 0x… */
  const isHexAddress = $derived(/^0x[0-9a-fA-F]{40}$/.test(toAddress.trim()));

  /**
   * Похоже ли на ENS-имя: `name.eth` или `name.xyz`.
   *
   * Разбор отдаём ноде (`ens_addressOf`): синтаксис ENS шире, чем кажется
   * (нормализация Unicode, регистр), и повторять его здесь значило бы
   * расходиться с ней в интерпретации.
   */
  const looksLikeEns = $derived(/^[^\s.]+\.[a-zA-Z]{2,}$/.test(toAddress.trim()));

  /** Разрешённый адрес ENS: `toAddress` содержит имя, здесь — адрес. */
  let resolvedAddress = $state('');
  let resolveError = $state('');
  let isResolving = $state(false);

  /**
   * Разворачивает ENS-имя в адрес.
   *
   * Показываем результат ДО нажатия «Проверить», чтобы человек увидел адрес,
   * а не просто имя: имя могут перерегистрировать на другой адрес, и в этом
   * весь смысл проверки.
   */
  async function resolveEns() {
    const name = toAddress.trim();
    resolveError = '';
    resolvedAddress = '';
    if (!looksLikeEns || !statusState.backendPort) return;

    isResolving = true;
    try {
      // ENS живёт в mainnet, независимо от того, в какой сети отправляем.
      const address = await ensAddressOf(statusState.backendPort, 1, name);
      if (!address) resolveError = i18n.t('This name has no address on mainnet');
      else resolvedAddress = address;
    } catch (e) {
      resolveError = formatError(e, 'Failed to resolve the name');
    } finally {
      isResolving = false;
    }
  }

  /** Имя ENS для hex-адреса получателя — показывается как подсказка. */
  let reverseName = $state('');
  async function lookupName() {
    reverseName = '';
    if (!isHexAddress || !statusState.backendPort) return;
    try {
      reverseName = await ensGetName(statusState.backendPort, 1, toAddress.trim());
    } catch {
      // Имени может не быть — это норма, а не ошибка.
    }
  }

  /** Итоговый адрес получателя: развёрнутое имя или введённый 0x. */
  const recipient = $derived(
    isHexAddress ? toAddress.trim() : looksLikeEns ? resolvedAddress : ''
  );

  const addressLooksValid = $derived(!!recipient && /^0x[0-9a-fA-F]{40}$/.test(recipient));

  /**
   * Можно ли перейти к подтверждению.
   *
   * Введённое ENS-имя тоже считается достаточным: разрешить его можно в
   * момент нажатия. Иначе кнопка оставалась бы неактивной, пока человек не
   * уйдёт с поля, и это выглядело бы как «форма не принимает имя».
   */
  const canConfirm = $derived(
    !!selected &&
      amountCheck?.ok === true &&
      (addressLooksValid || (looksLikeEns && !isResolving))
  );

  const balanceText = $derived(
    selected ? formatBalance(selected.balance, selected.decimals) : ''
  );

  const chainName = $derived(
    selected ? CHAIN_NAMES[selected.chainId] ?? String(selected.chainId) : ''
  );

  /**
   * Подставляет весь баланс.
   *
   * Точная строка, а не та, что показывается рядом: `formatBalance` по
   * умолчанию обрезает до 6 знаков, и у токена с 18 знаками «Всё» отправило
   * бы меньше, чем есть. Остаток навсегда остался бы на счету.
   */
  function useMax() {
    if (!selected) return;
    amount = formatUnits(BigInt(selected.balance || '0'), selected.decimals);
  }

  /** Запоминает пароль и сразу продолжает отправку. */
  async function submitPassword() {
    if (!passwordInput.trim()) return;
    rememberPassword(passwordInput);
    passwordInput = '';
    await confirmSend();
  }

  /**
   * Переход к подтверждению: сразу считаем комиссию.
   *
   * До ввода пароля — это безопасно (`estimate_transfer_fee` ключ не
   * использует), и человек видит полную стоимость перевода раньше, чем
   * решит его подписать.
   */
  async function goToConfirm() {
    sendState.error = '';
    sendState.errorCode = '';

    // Имя, по которому ещё не было запроса (человек нажал «Проверить», не
    // уходя с поля), разрешаем здесь.
    if (looksLikeEns && !resolvedAddress && !isResolving) {
      await resolveEns();
    }

    if (!selected || amountCheck?.ok !== true) return;
    if (!recipient) return;

    sendState.step = 'confirm';
    await estimateFee({ token: selected, to: recipient, amount: amountCheck.amount });
  }

  async function confirmSend() {
    if (!selected || amountCheck?.ok !== true) return;
    await sendTransfer({
      token: selected,
      // Адрес, а не имя: нода должна получить тот получатель, который
      // показан на экране подтверждения.
      to: recipient,
      amount: amountCheck.amount,
    });
  }

  /**
   * Ссылка на транзакцию в обозревателе.
   *
   * Адрес берётся из таблицы по сети (`utils/explorer.ts`). Раньше он
   * собирался шаблоном `sepolia.etherscan.io` для любой тестовой сети, и
   * транзакция в Base Sepolia по такой ссылке «не находилась», хотя перевод
   * прошёл: у каждой сети свой обозреватель.
   */
  const explorerUrl = $derived(
    selected ? explorerTxUrl(selected.chainId, sendState.txHash) : null
  );

  async function openExplorer() {
    if (!explorerUrl) return;
    try {
      await invoke('open_external', { url: explorerUrl });
    } catch (e) {
      console.error('[send] failed to open explorer', e);
    }
  }
</script>

<div class="h-full flex flex-col p-6 overflow-auto">
  <h3 class="text-lg font-semibold mb-4">{i18n.t('Send')}</h3>

  {#if sendState.step === 'form'}
    <div class="space-y-4 max-w-md">
      <!-- Токен -->
      <div>
        <label class="text-sm font-medium" for="send-token">{i18n.t('Token')}</label>
        <select
          id="send-token"
          bind:value={selectedKey}
          class="w-full h-10 border border-input rounded-md px-3 mt-1 bg-background"
        >
          <option value="">{i18n.t('Select token')}</option>
          {#each groups.available as item (item.key)}
            <option value={item.key}>
              {item.token.symbol} — {formatBalance(item.token.balance, item.token.decimals)}
              ({CHAIN_NAMES[item.token.chainId] ?? item.token.chainId})
            </option>
          {/each}
          {#if groups.unavailable.length > 0}
            <optgroup label={i18n.t('Unavailable')}>
              {#each groups.unavailable as item (item.key)}
                <option value={item.key} disabled>
                  {item.token.symbol}
                  ({i18n.t(item.blocked === 'rpc-error' ? 'RPC error' : 'no balance')})
                </option>
              {/each}
            </optgroup>
          {/if}
        </select>
      </div>

      <!-- Получатель -->
      <div>
        <label class="text-sm font-medium" for="send-to">{i18n.t('To')}</label>
        <input
          id="send-to"
          bind:value={toAddress}
          onblur={() => { resolveEns(); lookupName(); }}
          placeholder="0x... or name.eth"
          spellcheck="false"
          class="w-full h-10 border border-input rounded-md px-3 mt-1 bg-background font-mono text-sm"
        />

        <!--
          Развёрнутое имя показывается до проверки: имя могут перерегистрировать
          на чужой адрес, и увидеть адрес заранее — весь смысл разрешения ENS.
        -->
        {#if isResolving}
          <p class="text-xs text-muted-foreground mt-1">{i18n.t('Resolving name...')}</p>
        {:else if resolveError}
          <p class="text-xs text-destructive mt-1">{resolveError}</p>
        {:else if looksLikeEns && resolvedAddress}
          <p class="text-xs text-muted-foreground mt-1 break-all font-mono">
            {i18n.t('Resolves to')}: {resolvedAddress}
          </p>
        {:else if isHexAddress && reverseName}
          <!-- Обратная проверка: у знакомого адреса есть имя — показываем его. -->
          <p class="text-xs text-muted-foreground mt-1">{reverseName}</p>
        {:else if toAddress.trim() && !addressLooksValid && !looksLikeEns}
          <p class="text-xs text-destructive mt-1">
            {i18n.t('Enter a 0x address or an ENS name')}
          </p>
        {/if}
      </div>

      <!-- Сумма -->
      <div>
        <div class="flex items-center justify-between">
          <label class="text-sm font-medium" for="send-amount">{i18n.t('Amount')}</label>
          {#if selected}
            <div class="flex items-center gap-2">
              <span class="text-xs text-muted-foreground">
                {i18n.t('Balance')}: {balanceText}
              </span>
              <button onclick={useMax} class="text-xs text-primary hover:underline">
                {i18n.t('Max')}
              </button>
            </div>
          {/if}
        </div>
        <input
          id="send-amount"
          bind:value={amount}
          inputmode="decimal"
          spellcheck="false"
          placeholder="0.0"
          class="w-full h-10 border border-input rounded-md px-3 mt-1 bg-background font-mono text-sm"
        />
        {#if amountCheck && !amountCheck.ok}
          <p class="text-xs text-destructive mt-1">{i18n.t(amountCheck.error)}</p>
        {/if}
      </div>

      <button
        disabled={!canConfirm}
        onclick={goToConfirm}
        class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
      >
        {i18n.t('Review')}
      </button>
    </div>

  {:else if sendState.step === 'confirm' || sendState.step === 'sending' || sendState.step === 'sent' || sendState.step === 'failed'}
    <!--
      Экран подтверждения и результат живут в одной ветке: если показывать
      результат отдельно, при ошибке форма исчезает и человек теряет
      введённые значения, хотя чаще всего их достаточно поправить.
    -->
    <div class="space-y-4 max-w-md">
      {#if sendState.step === 'sent'}
        <div class="p-4 rounded-md border border-green-300 bg-green-50 text-green-900">
          <p class="font-medium">{i18n.t('Transaction sent')}</p>
          {#if sendState.txHash}
            <p class="text-xs font-mono break-all mt-2">{sendState.txHash}</p>
            {#if explorerUrl}
              <button onclick={openExplorer} class="text-xs text-primary hover:underline mt-2">
                {i18n.t('Open in explorer')}
              </button>
            {/if}
          {/if}
        </div>
        <button
          onclick={backToForm}
          class="w-full py-2 border border-border rounded-md text-sm font-medium"
        >
          {i18n.t('Send another')}
        </button>

      {:else}
        <!-- Что именно уйдёт -->
        <div class="border border-border rounded-lg divide-y divide-border">
          <div class="p-3 flex justify-between gap-3">
            <span class="text-xs text-muted-foreground">{i18n.t('Network')}</span>
            <span class="text-sm font-medium text-right">{chainName}</span>
          </div>
          <div class="p-3 flex justify-between gap-3">
            <span class="text-xs text-muted-foreground">{i18n.t('Token')}</span>
            <span class="text-sm font-medium">{selected?.symbol ?? ''}</span>
          </div>
          <div class="p-3 flex justify-between gap-3">
            <span class="text-xs text-muted-foreground">{i18n.t('Network fee')}</span>
            <span class="text-sm font-medium font-mono text-right">
              {#if sendState.isEstimating}
                {i18n.t('Estimating...')}
              {:else if sendState.fee !== null}
                {formatUnits(sendState.fee, 18)}
              {:else}
                {i18n.t('Calculated when sending')}
              {/if}
              <!--
                Это оценка, а не обещание: лимит газа окончательно
                определяет нода при отправке, и на тестовых сетях он бывает
                заметно выше. Называть цифру «комиссией» без оговорки значило
                бы обещать то, чего мы не контролируем.
              -->
              {#if sendState.fee !== null}
                <div class="text-[0.625rem] text-muted-foreground font-sans text-right">
                  {i18n.t('estimate, the final value is set by the network')}
                </div>
              {/if}
            </span>
          </div>
          {#if sendState.feeError}
            <div class="p-3 text-xs text-muted-foreground">{sendState.feeError}</div>
          {/if}
          <div class="p-3 flex justify-between gap-3">
            <span class="text-xs text-muted-foreground">{i18n.t('Amount')}</span>
            <span class="text-sm font-medium font-mono">
              {amountCheck?.ok ? formatUnits(amountCheck.amount, selected?.decimals ?? 18) : amount}
            </span>
          </div>
          <div class="p-3">
            <div class="text-xs text-muted-foreground">{i18n.t('To')}</div>
            <!--
              Адрес целиком и разбитый на строки: сокращать его на последнем
              экране нельзя — именно здесь его и проверяют глазами.
            -->
            <div class="text-sm font-mono break-all mt-1">{recipient}</div>
            {#if looksLikeEns}
              <div class="text-xs text-muted-foreground mt-1">{toAddress.trim()}</div>
            {/if}
          </div>
        </div>

        {#if sendState.error}
          <!--
            Подсказка по причине, затем исходный текст: первое объясняет,
            что делать, второе нужно, если причина не распознана
            (например, для отчёта об ошибке).
          -->
          {#if sendState.errorCode && sendState.errorCode !== 'send-unknown'}
            <p class="text-sm text-destructive">{i18n.t(sendState.errorCode)}</p>
            <p class="text-xs text-muted-foreground break-words">{sendState.error}</p>
          {:else}
            <p class="text-sm text-destructive break-words">{sendState.error}</p>
          {/if}
        {/if}

        {#if sendState.needsPassword || !sendState.password}
          <div>
            <label class="text-sm font-medium" for="send-password">{i18n.t('Password')}</label>
            <p class="text-xs text-muted-foreground mt-1 mb-2">
              {i18n.t('Needed to sign the transaction. Kept in memory until you log out.')}
            </p>
            <PasswordInput
              bind:value={passwordInput}
              onEnter={submitPassword}
              autofocus={true}
            />
          </div>
          <button
            onclick={submitPassword}
            disabled={!passwordInput.trim() || sendState.isSending}
            class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
          >
            {sendState.isSending ? i18n.t('Sending...') : i18n.t('Confirm and send')}
          </button>
        {:else}
          <button
            onclick={confirmSend}
            disabled={sendState.isSending}
            class="w-full py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium disabled:opacity-50"
          >
            {sendState.isSending ? i18n.t('Sending...') : i18n.t('Confirm and send')}
          </button>
        {/if}

        <button
          onclick={backToForm}
          disabled={sendState.isSending}
          class="w-full py-2 border border-border rounded-md text-sm font-medium disabled:opacity-50"
        >
          {i18n.t('Back')}
        </button>
      {/if}
    </div>
  {/if}
</div>
