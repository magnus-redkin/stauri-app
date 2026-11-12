<script lang="ts">
  /**
   * Мобильная оболочка (AD/AT): одна панель, без понятий LP/RP.
   *
   * Клик по пункту нижнего меню открывает раздел и сбрасывает его историю.
   * Стрелки ← / → появляются только когда внутри раздела есть переходы: история
   * ведётся по разделу, а не по всему приложению. Нижнее меню видно всегда.
   */
  import type { Snippet } from 'svelte';
  import { ArrowLeft, ArrowRight, Home, User, MessageCircle, Wallet, Blocks, Store } from 'lucide-svelte';
  import { onMount } from 'svelte';
  import { invoke } from '@tauri-apps/api/core';

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
    /** Содержимое текущего раздела (одна панель). */
    content: Snippet;
    title?: string;
    /** Иконки справа в титульной строке (Chat: 4, Wallet: reload и edit). */
    actions?: Snippet;
    /**
     * История переходов внутри раздела. Раздел сам кладёт шаги через `push`
     * и возвращает назад через `back`. Здесь только отображение стрелок.
     */
    history: { canBack: boolean; canForward: boolean; back: () => void; forward: () => void };
  } = $props();

  // Порядок из спецификации: Home, Profile, Chat, Wallet, dApps, Market.
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

  /**
   * Диагностика safe-area (временная, до релиза убрать).
   * Замеряет, отдаёт ли WebView значения env(safe-area-inset-*), и пишет в трассу.
   */
  let probe: HTMLDivElement | null = $state(null);
  onMount(() => {
    if (!probe) return;
    const cs = getComputedStyle(probe);
    const note = {
      kind: 'safe-area',
      top: cs.paddingTop,
      bottom: cs.paddingBottom,
      innerHeight: window.innerHeight,
      dvh: probe.getBoundingClientRect().height,
    };
    invoke('status_call', { endpoint: 'TraceNote', body: JSON.stringify(note) }).catch(() => {});
  });
</script>

<div class="flex flex-col h-[100dvh] min-h-0 overflow-hidden bg-background">
  <!-- Диагностика safe-area: невидимый замер, см. скрипт. -->
  <div bind:this={probe} aria-hidden="true" class="absolute inset-0 pointer-events-none invisible" style="padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom);"></div>
  <!-- Титульная строка: [←][→] [название раздела] [иконки справа].
       pt-[20px] — отступ под служебную строку Android (часы, сеть, батарея). -->
  <header class="shrink-0 flex items-center gap-2 px-3 pt-[max(20px,env(safe-area-inset-top))] pb-2 border-b border-border bg-secondary">
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

  <!-- Нижнее меню разделов: видно всегда -->
  <!-- Нижнее меню разделов: видно всегда. pb-[20px] — отступ над системными кнопками Android. -->
  <nav class="shrink-0 flex items-stretch justify-around border-t border-border bg-secondary pb-[max(25px,env(safe-area-inset-bottom))]">
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
