<script lang="ts">
  /**
   * Join form for a community.
   *
   * A separate component because the steps are not about the directory tree: choosing the
   * addresses to reveal, the airdrop address, the password and the token gate check. Keeping
   * them in `DappsMain` would mix directory navigation with a form that has its own logic
   * and state.
   *
   * Joining is not a single click: status-go's `requestToJoinCommunity` requires a non-empty
   * address list, an `airdropAddress` contained in it, and a signature per address — and
   * signing verifies the password through `GetVerifiedWalletAccount`.
   */
  import { i18n } from '$lib/i18n';
  import { SvelteSet } from 'svelte/reactivity';
  import {
    communitiesState,
    joinSelectedCommunity,
    checkEligibility,
    loadWalletAddresses,
  } from '$lib/stores/communitiesStore.svelte';
  import { loadChats } from '$lib/stores/chatsStore.svelte';

  let { onDone }: { onDone?: () => void } = $props();

  let password = $state('');
  /**
   * Addresses marked for sharing.
   *
   * `SvelteSet` is reactive on its own and must not be wrapped in `$state`, so the set is
   * cleared and refilled rather than replaced — reassigning would drop the subscriptions.
   */
  const selectedAddresses = new SvelteSet<string>();
  let airdropAddress = $state('');
  let message = $state<{ kind: 'ok' | 'pending' | 'error'; text: string } | null>(null);

  const entry = $derived(communitiesState.selected);

  /**
   * Prepares the form on mount: loads the wallet addresses and checks the token gate.
   *
   * All addresses are selected by default, matching "Share all addresses to join" in Status.
   * Extra ones can be unchecked by hand.
   *
   * Preparation happens here rather than in the parent because the component mounts exactly
   * when the user expands the form, and it is the place that owns this state. No `untrack`
   * is needed: the `$effect` below writes only to local `$state`.
   */
  let prepared = false;
  $effect(() => {
    if (prepared || !entry) return;
    prepared = true;
    void (async () => {
      const addresses = await loadWalletAddresses();
      selectedAddresses.clear();
      for (const addr of addresses) selectedAddresses.add(addr);
      airdropAddress = addresses[0] || '';

      // For a token gate, check eligibility up front: otherwise the user types a password
      // only to be refused by the community owner.
      if (entry.access === 'token') await checkEligibility();
    })();
  });

  function toggleAddress(address: string) {
    if (selectedAddresses.has(address)) {
      selectedAddresses.delete(address);
      if (airdropAddress === address) airdropAddress = '';
    } else {
      selectedAddresses.add(address);
      if (!airdropAddress) airdropAddress = address;
    }
  }

  async function submit() {
    if (communitiesState.isBusy) return;
    message = null;

    const addresses = [...selectedAddresses];
    const result = await joinSelectedCommunity(addresses, airdropAddress, password);

    if (result.ok) {
      password = '';
      // Channels appear only after the owner responds, but the list is refreshed right
      // away: for AUTO_ACCEPT communities the response arrives almost instantly.
      await loadChats(true);
      message = { kind: 'pending', text: i18n.t('Request sent') };
    } else {
      message = { kind: 'error', text: result.error || i18n.t('Join failed') };
    }
  }
</script>

<div class="p-2 space-y-2 border-t border-border">
  {#if message}
    <p class="text-xs {message.kind === 'error' ? 'text-destructive' : 'text-muted-foreground'}">
      {message.text}
    </p>
  {/if}

  {#if communitiesState.eligibility?.checked}
    <div class="p-2 rounded-md border border-border text-xs">
      {#if communitiesState.eligibility.satisfied}
        <p class="text-foreground">{i18n.t('You are eligible to join as member')}</p>
      {:else}
        <p class="text-destructive">{i18n.t('Your addresses do not meet the conditions')}</p>
      {/if}
    </div>
  {/if}

  <!--
    Address selection is not a formality: status-go refuses a request without it
    (`RequestToJoinCommunity.Validate` requires a non-empty list and an `airdropAddress`
    contained in it).
  -->
  <p class="text-[0.625rem] font-semibold uppercase tracking-wide text-muted-foreground">
    {i18n.t('Select address to share')}
  </p>
  <div class="space-y-1 max-h-32 overflow-y-auto">
    {#if communitiesState.walletAddresses.length === 0}
      <p class="text-xs text-muted-foreground italic">{i18n.t('No wallet addresses')}</p>
    {:else}
      {#each communitiesState.walletAddresses as addr (addr)}
        <label class="flex items-center gap-2 text-xs p-1 rounded hover:bg-secondary cursor-pointer">
          <input
            type="checkbox"
            checked={selectedAddresses.has(addr)}
            onchange={() => toggleAddress(addr)}
            class="rounded"
          />
          <span class="font-mono truncate">{addr.slice(0, 10)}…{addr.slice(-6)}</span>
          {#if airdropAddress === addr}
            <span class="text-[0.625rem] px-1 py-0.5 rounded bg-primary/10 text-primary shrink-0">
              {i18n.t('Airdrop')}
            </span>
          {/if}
        </label>
      {/each}
    {/if}
  </div>

  {#if communitiesState.walletAddresses.length > 1}
    <button
      onclick={() => {
        selectedAddresses.clear();
        for (const addr of communitiesState.walletAddresses) selectedAddresses.add(addr);
      }}
      class="text-[0.6875rem] text-primary hover:underline"
    >
      {i18n.t('Share all addresses')}
    </button>
  {/if}

  <input
    type="password"
    bind:value={password}
    placeholder={i18n.t('Password')}
    class="w-full h-8 border border-input rounded-md px-2 text-xs bg-background"
    aria-label={i18n.t('Password')}
  />
  <!--
    The password is needed because signing the revealed addresses is done by status-go,
    which verifies it through GetVerifiedWalletAccount. It is not checked here and never
    leaves the request.
  -->
  <p class="text-[0.625rem] text-muted-foreground">
    {i18n.t('The password is needed to sign the revealed addresses')}
  </p>

  <div class="flex gap-2">
    <button
      onclick={submit}
      disabled={communitiesState.isBusy || !password || selectedAddresses.size === 0}
      class="flex-1 px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-xs disabled:opacity-50"
    >
      {communitiesState.isBusy ? i18n.t('Sending...') : i18n.t('Request to join')}
    </button>
    <button
      onclick={() => onDone?.()}
      class="px-3 py-1.5 rounded-md border border-border text-xs hover:bg-secondary"
    >
      {i18n.t('Cancel')}
    </button>
  </div>
</div>
