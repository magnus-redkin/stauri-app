<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import { Wallet, Pencil } from 'lucide-svelte';
  import { walletState } from '$lib/stores/walletStore.svelte';
  import { selectWalletTab } from '$lib/stores/walletView.svelte';
</script>

<div class="flex flex-col h-full border-r border-border bg-card">
  <div class="p-4 border-b border-border flex justify-between items-center">
    <span class="font-bold text-lg text-primary">{i18n.t('Wallet')}</span>
  </div>

  <ScrollArea class="flex-1 min-h-0">
    <div class="p-4 border-b border-border bg-secondary/30">
      <div class="flex items-center justify-between">
        <div>
          <div class="text-sm font-medium text-foreground">
            {i18n.t('All accounts')}
          </div>
          <div class="text-xs text-muted-foreground mt-1">
            {walletState.balances.length} {i18n.t('tokens')}
          </div>
        </div>
      </div>

      {#if walletState.address}
        <div class="mt-2">
          <div class="text-xs font-mono text-muted-foreground break-all">
            {walletState.address.substring(0, 10)}...
          </div>
        </div>
      {/if}

      <!--
        "Manage accounts" switches to the accounts tab of the wallet rather than navigating
        to the profile section: the profile holds the name and avatar, not the wallet
        accounts the label refers to.
      -->
      <button
        onclick={() => selectWalletTab('accounts')}
        class="mt-4 w-full flex items-center gap-2 text-sm text-muted-foreground hover:text-primary transition-colors"
        title={i18n.t('Manage accounts')}
      >
        <div class="relative">
          <Wallet size={20} />
          <Pencil size={10} class="absolute -bottom-1 -right-1 text-primary" />
        </div>
        <span>{i18n.t('Manage accounts')}</span>
      </button>
    </div>
  </ScrollArea>
</div>
