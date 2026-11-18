<script lang="ts">
  import { i18n } from '$lib/i18n';

  let {
    selectedNetwork = $bindable('mainnet'),
    onSelect
  }: {
    selectedNetwork: string;
    onSelect?: (network: string) => void;
  } = $props();

  let isTestnetExpanded = $state(false);

  const mainnet = 'mainnet';
  const testnets = ['sepolia', 'holesky'];

  function selectNetwork(net: string) {
    selectedNetwork = net;
    if (onSelect) onSelect(net);
    isTestnetExpanded = false; // Collapse after a choice.
  }

  function toggleTestnet() {
    // Only toggles the visibility of the list; it never selects a network.
    isTestnetExpanded = !isTestnetExpanded;
  }

  // Whether a testnet is selected, for highlighting the button.
  const isTestnetSelected = $derived(selectedNetwork !== mainnet);
</script>

<div class="w-full max-w-md space-y-2">
  <button
    onclick={() => selectNetwork(mainnet)}
    class="w-full flex items-center gap-3 px-4 py-3 rounded-lg border transition-colors {selectedNetwork === mainnet ? 'border-success bg-success/10' : 'border-border hover:bg-secondary'}"
  >
    <div class="w-2 h-2 rounded-full {selectedNetwork === mainnet ? 'bg-success' : 'bg-muted-foreground/40'}"></div>
    <span class="font-medium text-foreground">Mainnet</span>
  </button>

  <div class="relative">
    <button
      onclick={toggleTestnet}
      class="w-full flex items-center justify-between px-4 py-3 rounded-lg border transition-colors {isTestnetSelected ? 'border-warning bg-warning/10' : 'border-border hover:bg-secondary'}"
    >
      <div class="flex items-center gap-3">
        <div class="w-2 h-2 rounded-full {isTestnetSelected ? 'bg-warning' : 'bg-muted-foreground/40'}"></div>
        <span class="font-medium text-foreground">Testnet</span>
      </div>
      <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="text-muted-foreground transition-transform {isTestnetExpanded ? 'rotate-180' : ''}">
        <polyline points="6 9 12 15 18 9"></polyline>
      </svg>
    </button>

    {#if isTestnetExpanded}
      <div class="mt-2 ml-4 space-y-1">
        {#each testnets as net (net)}
          <button
            onclick={() => selectNetwork(net)}
            class="w-full text-left px-4 py-2 rounded-md text-sm transition-colors {selectedNetwork === net ? 'bg-warning/10 text-warning font-medium' : 'hover:bg-secondary text-muted-foreground'}"
          >
            {net.charAt(0).toUpperCase() + net.slice(1)}
          </button>
        {/each}
      </div>
    {/if}
  </div>
</div>
