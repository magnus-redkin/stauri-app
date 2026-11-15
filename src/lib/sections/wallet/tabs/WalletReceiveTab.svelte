<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { walletState } from '$lib/stores/walletStore.svelte';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import QrCode from '$lib/components/QrCode.svelte';

  let copied = $state(false);

  async function copyAddress() {
    if (!walletState.address) return;
    try {
      await navigator.clipboard.writeText(walletState.address);
      copied = true;
      setTimeout(() => copied = false, 2000);
    } catch (e) { console.error(e); }
  }
</script>

<div class="h-full flex flex-col p-6 overflow-auto">
  <h3 class="text-lg font-semibold mb-4">{i18n.t('Receive')}</h3>

  {#if !walletState.address}
    <p class="text-muted-foreground text-sm">{i18n.t('No wallet address')}</p>
  {:else}
    <div class="flex flex-col items-center gap-4 max-w-md">
      <!--
        The QR code is drawn locally, so the address never leaves the app. A remote image
        service would both sit outside the CSP and receive the user's address on every
        visit to the tab.
      -->
      <QrCode value={walletState.address} size={192} />

      <div class="w-full">
        <label class="text-sm font-medium">{i18n.t('Your address')}</label>
        <div class="mt-1 flex gap-2">
          <input
            readonly
            value={walletState.address}
            class="flex-1 h-10 border border-input rounded-md px-3 bg-secondary font-mono text-xs"
          />
          <button
            onclick={copyAddress}
            class="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium"
          >
            {copied ? i18n.t('Copied!') : i18n.t('Copy')}
          </button>
        </div>
      </div>

      <!--
        One address serves every EVM network: USDT sent on Optimism arrives at the same
        address as ETH. The limitation is explained before the transfer, not after it.
      -->
      <div class="w-full p-3 rounded-md bg-secondary/60 border border-border">
        <p class="text-xs text-muted-foreground">
          {i18n.t('This address works on all EVM networks. The sender must choose the right network — funds sent on a wrong network may not appear here.')}
        </p>
        {#if statusState.networkName}
          <p class="text-xs text-muted-foreground mt-2">
            {i18n.t('Network')}: <span class="font-medium text-foreground">{statusState.networkName}</span>
            {#if statusState.isTestnet}
              <span class="text-orange-600">({i18n.t('testnet')})</span>
            {/if}
          </p>
        {/if}
      </div>

      <p class="text-xs text-muted-foreground text-center">
        {i18n.t('Send only supported tokens to this address.')}
      </p>
    </div>
  {/if}
</div>
