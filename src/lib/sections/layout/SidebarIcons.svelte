<script lang="ts">
  import { Home, User, MessageCircle, Wallet, Store, Settings, Blocks } from "lucide-svelte";
  import { i18n } from '$lib/i18n';
  import { statusState } from '$lib/stores/statusStore.svelte';

  let {
    activeSection = $bindable(),
    onSelect,
  }: {
    activeSection: string;
    /**
     * Called on every click, including a repeated click on the already active tab.
     *
     * Without it, tapping the current icon does nothing: `activeSection` does not change and
     * effects that watch it never run. The dApps section relies on this — a repeated click
     * returns to the start of the component.
     */
    onSelect?: (id: string) => void;
  } = $props();

  const navItems = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'profile', icon: User, label: 'Profile' },
    { id: 'chat', icon: MessageCircle, label: 'Chat' },
    // The community directory is a provider rather than a section of its own
    // (docs/ru/providers_and_dapps.md): it returns a list of addresses and the app performs
    // the join request. It lives in the dApps section instead of taking a place in the main
    // navigation next to what the user already has.
    { id: 'dapps', icon: Blocks, label: 'dApps' },
    { id: 'wallet', icon: Wallet, label: 'Wallet' },
    { id: 'market', icon: Store, label: 'Market' },
  ];
</script>

<nav class="w-16 flex flex-col items-center py-4 border-r border-border bg-secondary gap-2 shadow-sm z-20 relative">
  {#each navItems as item (item.id)}
    <div class="relative group">
      <button
        class="p-3 rounded-lg transition-colors {activeSection === item.id ? 'bg-primary text-primary-foreground shadow-md' : 'hover:bg-black/5 text-muted-foreground'}"
        onclick={() => { activeSection = item.id; onSelect?.(item.id); }}
      >
        <item.icon size={22} />

        {#if item.id === 'chat' && statusState.pendingRequestsCount > 0}
          <span class="absolute top-1 right-1 flex h-4 w-4 items-center justify-center rounded-full bg-red-500 text-[0.625rem] font-bold text-white">
            {statusState.pendingRequestsCount}
          </span>
        {/if}
      </button>

      <div class="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-3 py-1.5 bg-popover text-popover-foreground text-sm font-medium rounded-md shadow-lg border border-border opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 whitespace-nowrap">
        {item.label}
      </div>
    </div>
  {/each}

  <div class="flex-1"></div>

  <div class="relative group">
    <button
      class="p-3 rounded-lg transition-colors {activeSection === 'settings' ? 'bg-primary text-primary-foreground shadow-md' : 'hover:bg-black/5 text-muted-foreground'}"
      onclick={() => { activeSection = 'settings'; onSelect?.('settings'); }}
    >
      <Settings size={22} />
    </button>
    <div class="absolute left-full top-1/2 -translate-y-1/2 ml-2 px-3 py-1.5 bg-popover text-popover-foreground text-sm font-medium rounded-md shadow-lg border border-border opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity z-50 whitespace-nowrap">
      Settings
    </div>
  </div>
</nav>
