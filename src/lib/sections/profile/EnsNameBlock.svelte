<script lang="ts">
  /**
   * Registration of an ENS name inside the profile section.
   *
   * An `<name>.stateofus.eth` name belongs to the profile rather than the wallet: it is
   * tied to the Status identity and visible to contacts as an address for transfers. The
   * profile is where the name and the avatar are already edited, so registration sits next
   * to them.
   *
   * The password is asked here rather than reused from the session: a user can open the
   * profile without having sent a transfer, so no session password exists yet. After a
   * successful registration it is stored for the session, and the next send does not ask
   * again.
   *
   * The field accepts the label only. The registrar hashes exactly what it is given, so
   * typing `.eth` would produce `.eth.stateofus.eth`; the domain is shown beside the field
   * instead.
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

  /** Stake token: STT on Sepolia, SNT on mainnet. */
  const stakeSymbol = $derived(chainId === 11155111 ? 'STT' : 'SNT');

  const nameError = $derived(usernameError(ensState.username));
  const canReview = $derived(!!ensState.username.trim() && !nameError && supported);

  /**
   * Balances that decide whether registration can succeed.
   *
   * Derived from `walletState.balances`, so a balance refresh (after a transfer, or through
   * the refresh button) updates these figures without reopening the profile.
   */
  const balances = $derived(chainBalances(chainId));

  /** Whether the stake is covered: the price is known and the balance is not below it. */
  const stakeShort = $derived(
    ensState.price !== null && balances.stake !== null && balances.stake < ensState.price
  );

  /**
   * Whether there is no ETH for the fee.
   *
   * Only an explicit zero counts. `null` means "balances not loaded yet or the RPC did not
   * answer", and warning on that would alarm a user with a funded wallet; an unknown balance
   * is shown as "—" instead.
   */
  const nativeShort = $derived(balances.native === 0n);

  /**
   * Why registration cannot possibly succeed; an empty string means it can.
   *
   * Blocking early spares the user from typing a password only to be refused by the
   * contract — a refusal that is not about the password and is hard to read as such.
   *
   * Only known data blocks. A `null` balance means "unknown", not "zero": blocking on it
   * would forbid registration with a funded wallet whose balances have not loaded. Which is
   * why only a taken name, an unsupported network, a known balance below the stake or a
   * known zero ETH balance block the form.
   *
   * An unknown price (`price === null`) leaves nothing to compare, so it does not block; the
   * check happens when the button is pressed.
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
      The Status registrar is deployed on mainnet and Sepolia only. Other networks get the
      explanation instead of a form that is certain to be refused.
    -->
    <p class="text-xs text-muted-foreground">
      {i18n.t('ENS names can be registered only on Ethereum mainnet or Sepolia.')}
    </p>

  {:else if ensState.step === 'done'}
    <div class="p-3 rounded-lg border border-success/30 bg-success/10 text-success">
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
      What the account holds. Without it the only answer to "why does this not go through"
      would be an error after the button is pressed: the route is not built without the
      stake, and the fee stays unknown.
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
    <!-- Confirmation, sending and refusal. A refusal keeps the form on screen: usually the
         password has to be entered again, not the name. -->
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
          The field is disabled when registration cannot succeed: typing a password for a
          refusal by the contract is wasted effort, and the reason is already stated below.
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
