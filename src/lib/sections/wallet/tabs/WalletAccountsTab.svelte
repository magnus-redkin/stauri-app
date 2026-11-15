<script lang="ts">
  /**
   * Wallet accounts of the current profile.
   *
   * Shows only what the backend actually knows: address, derivation path and name. Adding
   * and removing accounts is a separate piece of work — `accounts_addAccount` and
   * `accounts_deleteAccount` in status-go require a password and a decision about what
   * happens to the balance — so this screen honestly lists existing accounts instead of
   * offering buttons that do nothing.
   */
  import { i18n } from '$lib/i18n';
  import { walletState } from '$lib/stores/walletStore.svelte';

  let copied = $state('');

  async function copy(address: string) {
    try {
      await navigator.clipboard.writeText(address);
      copied = address;
      setTimeout(() => { if (copied === address) copied = ''; }, 2000);
    } catch (e) {
      console.error(e);
    }
  }

  /** Shortens an address for a heading, keeping only its start and end. */
  function short(addr: string): string {
    if (addr.length <= 14) return addr;
    return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
  }
</script>

<div class="h-full flex flex-col p-6 overflow-auto">
  <h3 class="text-lg font-semibold mb-1">{i18n.t('Manage accounts')}</h3>
  <p class="text-xs text-muted-foreground mb-4 max-w-md">
    {i18n.t('These are the wallet accounts of this profile. Each has its own address on every EVM network.')}
  </p>

  {#if walletState.accounts.length === 0}
    <p class="text-muted-foreground text-sm">{i18n.t('No wallet addresses')}</p>
  {:else}
    <div class="border border-border rounded-lg divide-y divide-border max-w-xl">
      {#each walletState.accounts as account (account.address)}
        <div class="p-4 flex items-start justify-between gap-3">
          <div class="min-w-0">
            <div class="text-sm font-medium text-foreground">
              {account.name || short(account.address)}
            </div>
            <div class="text-xs font-mono text-muted-foreground mt-1 break-all">
              {account.address}
            </div>
            {#if account.path}
              <div class="text-xs text-muted-foreground mt-1">
                {i18n.t('Path')}: <span class="font-mono">{account.path}</span>
              </div>
            {/if}
          </div>

          <button
            onclick={() => copy(account.address)}
            class="shrink-0 px-3 py-1.5 rounded-md border border-border text-xs hover:bg-secondary transition-colors"
          >
            {copied === account.address ? i18n.t('Copied!') : i18n.t('Copy')}
          </button>
        </div>
      {/each}
    </div>
  {/if}

  <!--
    An honest boundary: adding accounts is not implemented. The user learns it from the
    screen rather than from a button that does nothing.
  -->
  <p class="text-xs text-muted-foreground mt-4 max-w-xl">
    {i18n.t('Adding and removing accounts will be available later.')}
  </p>
</div>
