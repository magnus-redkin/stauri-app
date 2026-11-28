<script lang="ts">
  /**
   * Left panel of the dApps section: everything the user added, plus the built-in sources.
   *
   * Rows come in two kinds and behave differently only on click: a plugin opens inside the
   * section, an external dApp opens in its own window. The built-in sources (feeds and the
   * community directory) stay until they are replaced by plugins; see
   * `docs/en/dapp-connect.md`.
   */
  import { i18n } from '$lib/i18n';
  import { ScrollArea } from '$lib/components/ui/scroll-area/index.js';
  import { dappsState, selectProvider, removeProvider, resetDappsView } from '$lib/stores/dappsStore.svelte';
  import { pluginsState, loadDapps, openDapp, removeDapp, showAddDapp } from '$lib/stores/pluginsStore.svelte';

  const providers = $derived(dappsState.providers);

  // The list is read once per section visit; add and remove refresh it themselves.
  $effect(() => {
    if (!pluginsState.loaded) void loadDapps();
  });
</script>

<div class="flex flex-col h-full min-h-0 border-r border-border bg-card">
  <div class="p-4 border-b border-border flex items-center gap-2">
    <span class="font-bold text-lg text-primary">{i18n.t('dApps')}</span>
    <button
      onclick={() => { resetDappsView(); showAddDapp(); }}
      class="ml-auto p-1.5 rounded-md border border-border hover:bg-secondary"
      aria-label={i18n.t('Add a dApp')}
      title={i18n.t('Add a dApp')}
    >
      ✎
    </button>
  </div>

  {#if pluginsState.error}
    <p class="px-3 pb-2 text-xs text-destructive">{pluginsState.error}</p>
  {/if}

  <ScrollArea class="flex-1 min-h-0">
    <div class="p-2 space-y-1">
      <div class="px-2 pt-2 text-[0.6875rem] uppercase text-muted-foreground">{i18n.t('Added dApps')}</div>
      {#if pluginsState.items.length === 0}
        <p class="px-2 py-1 text-muted-foreground text-sm italic">{i18n.t('No dApps yet')}</p>
      {/if}
      {#each pluginsState.items as dapp (dapp.id)}
        <div class="group/row relative">
          <button
            onclick={() => openDapp(dapp)}
            class="w-full text-left p-3 pr-8 rounded-md hover:bg-secondary transition-colors {pluginsState.selected?.id === dapp.id ? 'bg-secondary' : ''}"
          >
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold">
                {dapp.kind === 'plugin' ? '◈' : '↗'}
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-medium text-foreground truncate">{dapp.name}</div>
                <div class="text-xs text-muted-foreground truncate">
                  {dapp.kind === 'plugin'
                    ? `${i18n.t('Plugin')}${dapp.version ? ` · v${dapp.version}` : ''}`
                    : i18n.t('External window')}
                </div>
              </div>
            </div>
          </button>
          <button
            onclick={(e) => { e.stopPropagation(); removeDapp(dapp); }}
            class="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:text-destructive transition-opacity"
            title={i18n.t('Remove')}
            aria-label={i18n.t('Remove')}
          >
            ×
          </button>
        </div>
      {/each}

      <div class="px-2 pt-4 text-[0.6875rem] uppercase text-muted-foreground">{i18n.t('Built-in')}</div>
      {#each providers as provider (provider.kind)}
        <div class="group/row relative">
          <button
            onclick={() => selectProvider(provider.kind)}
            class="w-full text-left p-3 pr-8 rounded-md hover:bg-secondary transition-colors {dappsState.active === provider.kind && !pluginsState.selected ? 'bg-secondary' : ''}"
          >
            <div class="flex items-center gap-2">
              <div class="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-primary text-xs font-bold">
                {provider.icon}
              </div>
              <div class="flex-1 min-w-0">
                <div class="font-medium text-foreground truncate">{i18n.t(provider.title)}</div>
                <div class="text-xs text-muted-foreground truncate">{i18n.t(provider.subtitle)}</div>
              </div>
            </div>
          </button>
          {#if provider.removable}
            <button
              onclick={(e) => { e.stopPropagation(); removeProvider(provider.kind); }}
              class="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded text-muted-foreground opacity-0 group-hover/row:opacity-100 focus:opacity-100 hover:text-destructive transition-opacity"
              title={i18n.t('Remove')}
              aria-label={i18n.t('Remove')}
            >
              ×
            </button>
          {/if}
        </div>
      {/each}
    </div>
  </ScrollArea>
</div>
