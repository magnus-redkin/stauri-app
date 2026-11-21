<script lang="ts">
  /**
   * Mobile shell: a single pane, with no left/right panel split.
   *
   * Tapping an item of the bottom menu opens the section and resets that section's own
   * history. The ← / → buttons appear only when the current section has steps to go back or
   * forward to: history is tracked per section, not across the whole app. The bottom menu is
   * always visible.
   */
  import type { Snippet } from 'svelte';
  import { ArrowLeft, ArrowRight, Home, User, MessageCircle, Wallet, Blocks, Store } from 'lucide-svelte';

  let {
    activeSection = $bindable(),
    onSelect,
    content,
    title = '',
    actions,
    history,
  }: {
    activeSection: string;
    onSelect?: (id: string) => void;
    /** Content of the current section (the single pane). */
    content: Snippet;
    title?: string;
    /** Icons at the right of the title bar (Chat: 4, Wallet: reload and edit). */
    actions?: Snippet;
    /**
     * Navigation history inside the section. The section pushes steps through `push` and
     * walks back through `back`; this component only renders the arrows.
     */
    history: { canBack: boolean; canForward: boolean; back: () => void; forward: () => void };
  } = $props();

  // Order from the specification: Home, Profile, Chat, Wallet, dApps, Market.
  const menu = [
    { id: 'home', icon: Home, label: 'Home' },
    { id: 'profile', icon: User, label: 'Profile' },
    { id: 'chat', icon: MessageCircle, label: 'Chat' },
    { id: 'wallet', icon: Wallet, label: 'Wallet' },
    { id: 'dapps', icon: Blocks, label: 'dApps' },
    { id: 'market', icon: Store, label: 'Market' },
  ];

  function pick(id: string) {
    activeSection = id;
    onSelect?.(id);
  }
</script>

<div class="flex flex-col flex-1 min-h-0 overflow-hidden bg-background">
  <!-- Title bar: [←][→] [section name] [icons on the right]. The system bars are kept off
       the content by the activity's window inset padding (MainActivity.kt), so this only
       needs its own spacing. -->
  <header class="shrink-0 flex items-center gap-2 px-3 pt-3 pb-2 border-b border-border bg-secondary">
    {#if history.canBack}
      <button
        type="button"
 onclick={() => history.back()}
        class="h-11 w-11 shrink-0 rounded-md flex items-center justify-center bg-card"
        aria-label="Back"
      >
 <ArrowLeft size={24} />
      </button>
    {/if}
    {#if history.canForward}
      <button
        type="button"
        onclick={() => history.forward()}
 class="h-11 w-11 shrink-0 rounded-md flex items-center justify-center bg-card"
        aria-label="Forward"
      >
        <ArrowRight size={24} />
      </button>
    {/if}

    <span class="flex-1 min-w-0 truncate font-semibold text-primary text-lg">{title}</span>

    {#if actions}
      <div class="shrink-0 flex items-center gap-1">
        {@render actions()}
      </div>
    {/if}
  </header>

  <div class="flex-1 min-h-0 overflow-hidden relative">
    {@render content()}
  </div>

  <!-- Bottom section menu, always visible. The navigation bar below it is kept clear by the
       activity's window inset padding, so no extra fallback is needed here. -->
  <nav class="shrink-0 flex items-stretch justify-around border-t border-border bg-secondary pb-2">
    {#each menu as item (item.id)}
      <button
 type="button"
        onclick={() => pick(item.id)}
 class="flex-1 py-2 flex flex-col items-center gap-0.5 {activeSection === item.id ? 'text-primary' : 'text-muted-foreground'}"
        aria-label={item.label}
      >
        <item.icon size={22} />
        <span class="text-[0.625rem]">{item.label}</span>
      </button>
    {/each}
  </nav>
</div>
