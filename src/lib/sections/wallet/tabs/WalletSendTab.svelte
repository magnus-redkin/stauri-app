<script lang="ts">
  /**
   * Send screen for wallet funds.
   *
   * A confirmation step sits between the form and the network because it lists everything
   * that will leave: network, asset, amount, recipient and fee. That is the last chance to
   * notice a wrong address — a transfer cannot be cancelled once it is mined.
   *
   * The amount is kept as a string: `<input type="number">` returns a `Number` and loses
   * precision at 18 digits, so it is parsed into `BigInt` by `parseAmount`
   * (`utils/amount.ts`).
   *
   * The password is asked once per session and held in memory by `sendStore`, never on
   * disk. The transfer runs through the Rust `send_transfer` command, which keeps building
   * and signing out of the webview: a compromised page gets neither a standing password nor
   * a universal signing tool. `wallet_signMessage` returns the signature with a `0x` prefix
   * while `wallet_sendTransactionWithSignature` decodes bare hex and rejects it, so the
   * prefix is stripped inside that command.
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

  /** Whether the input matches a `0x`-prefixed address. */
  const isHexAddress = $derived(/^0x[0-9a-fA-F]{40}$/.test(toAddress.trim()));

  /**
   * Whether the input looks like an ENS name (`name.eth`, `name.xyz`).
   *
   * The real syntax check belongs to the node (`ensAddressOf`): ENS is wider than it looks
   * (Unicode normalisation, case folding), and repeating that here would disagree with the
   * node's interpretation.
   */
  const looksLikeEns = $derived(/^[^\s.]+\.[a-zA-Z]{2,}$/.test(toAddress.trim()));

  /** Address the ENS name resolved to; `toAddress` still holds the name. */
  let resolvedAddress = $state('');
  let resolveError = $state('');
  let isResolving = $state(false);

  /**
   * Resolves an ENS name to its address.
   *
   * The address is shown before the user commits, and not only the name: a name can be
   * re-registered to a different address, and seeing the target beforehand is the point of
   * resolving at all.
   */
  async function resolveEns() {
    const name = toAddress.trim();
    resolveError = '';
    resolvedAddress = '';
    if (!looksLikeEns || !statusState.backendRunning) return;

    isResolving = true;
    try {
      // ENS lives on mainnet regardless of the network the transfer is sent on.
      const address = await ensAddressOf(1, name);
      if (!address) resolveError = i18n.t('This name has no address on mainnet');
      else resolvedAddress = address;
    } catch (e) {
      resolveError = formatError(e, 'Failed to resolve the name');
    } finally {
      isResolving = false;
    }
  }

  /** ENS name of a hex recipient address, shown as a hint under the field. */
  let reverseName = $state('');
  async function lookupName() {
    reverseName = '';
    if (!isHexAddress || !statusState.backendRunning) return;
    try {
      reverseName = await ensGetName(1, toAddress.trim());
    } catch {
      // A missing name is the normal case, not an error.
    }
  }

  /** Recipient address actually sent to: the resolved name, or the entered `0x` address. */
  const recipient = $derived(
    isHexAddress ? toAddress.trim() : looksLikeEns ? resolvedAddress : ''
  );

  const addressLooksValid = $derived(!!recipient && /^0x[0-9a-fA-F]{40}$/.test(recipient));

  /**
   * Whether the form may move on to confirmation.
   *
   * A raw ENS name also counts: it can still be resolved when the button is pressed.
   * Demanding an already-resolved address would keep the button disabled until focus
   * leaves the field, which reads as "the form does not accept names".
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
   * Fills in the whole balance.
   *
   * Uses the exact token amount rather than the figure shown beside the field:
   * `formatBalance` trims to 6 digits by default, so for an 18-decimal token "Max" would
   * send less than the balance and the remainder would stay on the account forever.
   */
  function useMax() {
    if (!selected) return;
    amount = formatUnits(BigInt(selected.balance || '0'), selected.decimals);
  }

  /** Remembers the password for the session and continues the send at once. */
  async function submitPassword() {
    if (!passwordInput.trim()) return;
    rememberPassword(passwordInput);
    passwordInput = '';
    await confirmSend();
  }

  /**
   * Moves to the confirmation step and estimates the fee right away.
   *
   * Estimating before the password is entered is safe (`estimate_transfer_fee` never uses
   * the key), and it shows the full cost of the transfer before anything is signed.
   */
  async function goToConfirm() {
    sendState.error = '';
    sendState.errorCode = '';

    // A name that was never resolved (the button was pressed without leaving the field)
    // is resolved here.
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
      // An address, never a name: the node must receive the recipient that the
      // confirmation screen displayed.
      to: recipient,
      amount: amountCheck.amount,
    });
  }

  /**
   * Explorer link for the transaction.
   *
   * The base URL comes from the per-chain table in `utils/explorer.ts`: every network has
   * its own explorer, so a single testnet template would produce links that cannot find
   * the transaction even though the transfer went through.
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
          The resolved address appears before confirmation is pressed: a name can be
          re-registered to someone else's address, and seeing the address beforehand is
          what ENS resolution is for.
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
          <!-- Reverse lookup: a familiar address that has a name shows it. -->
          <p class="text-xs text-muted-foreground mt-1">{reverseName}</p>
        {:else if toAddress.trim() && !addressLooksValid && !looksLikeEns}
          <p class="text-xs text-destructive mt-1">
            {i18n.t('Enter a 0x address or an ENS name')}
          </p>
        {/if}
      </div>

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
      Confirmation, progress and result share one branch: a separate result screen would
      drop the form on failure, and a failed send usually only needs a corrected value.
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
                This is an estimate, not a promise: the node sets the final gas limit when
                the transaction is sent, and on test networks it is often noticeably
                higher. Presenting the figure as a fixed fee would promise something the
                app does not control.
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
              The full address, allowed to wrap: on the last screen it must not be
              shortened — this is exactly where it is checked by eye.
            -->
            <div class="text-sm font-mono break-all mt-1">{recipient}</div>
            {#if looksLikeEns}
              <div class="text-xs text-muted-foreground mt-1">{toAddress.trim()}</div>
            {/if}
          </div>
        </div>

        {#if sendState.error}
          <!--
            The explanation comes before the raw text: the first says what to do, the second
            is needed when the cause was not recognised (for a bug report, for instance).
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
