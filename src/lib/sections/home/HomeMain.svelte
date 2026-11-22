<script lang="ts">
  /**
   * Main part of the Home section: About content and the two main buttons.
   *
   * The content comes from `docs/<lang>/about.md`; this component only chooses what to
   * show. On a narrow screen the list of subsections and the open subsection share the
   * single pane: nothing open shows the list, something open shows it with a way back.
   *
   * @remarks
   * The document link at the foot of a subsection opens in a dApp window on the desktop
   * and in the browser on a phone: `open_dapp` has no second window on mobile yet.
   */
  import { i18n } from '$lib/i18n';
  import { invoke } from '@tauri-apps/api/core';
  import { ExternalLink, ChevronLeft } from 'lucide-svelte';
  import { renderMarkdown } from '$lib/utils/markdown';
  import { error } from '$lib/utils/log';
  import { isAndroid } from '$lib/utils/platform';
  import { docUrl, resolveDocPath, type AboutSection } from './aboutSections';
  let {
    sections,
    topic = $bindable(),
    compact,
    onNavigate,
    onBack,
  }: {
    sections: AboutSection[];
    /** Open subsection; bound, because the list on a narrow screen lives here too. */
    topic: string | null;
    compact: boolean;
    onNavigate?: (section: string) => void;
    onBack?: () => void;
  } = $props();

  const current: AboutSection | null = $derived(sections.find((s) => s.id === topic) ?? null);

  /**
   * Opens a footer link.
   *
   * @param target - Link target as written in the document: a bundled `.md` path or an
   *   `http(s)` address.
   * @remarks
   * Two kinds of target, two doors. A bundled document opens in a dApp window on the
   * desktop (`open_dapp` serves only whitelisted files, which is why the whitelist in
   * `dapp.rs` must list every linked document); a phone has no second window yet, so it
   * goes to the system handler. An outside address always goes to the system handler,
   * which checks the scheme in Rust — the shell plugin is not registered and would not
   * work here.
   */
  async function openLink(target: string): Promise<void> {
    const external = /^https?:/i.test(target);
    const url = external ? target : docUrl(resolveDocPath(target, i18n.locale ?? 'en'));
    if (!url) return;
    try {
      if (external || isAndroid()) await invoke('open_external', { url });
      else await invoke<string>('open_dapp', { url });
    } catch (e) {
      error(`[home] cannot open ${url}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
</script>

<div class="h-full flex flex-col overflow-y-auto bg-background">
  {#if compact && !current}
    <!-- The list stands in for the left panel: one pane, so only one thing at a time. -->
    <div class="border-b border-border bg-card">
      <div class="p-4 border-b border-border">
        <span class="font-bold text-lg text-primary">{i18n.t('About')}</span>
      </div>
      <div class="p-4 space-y-1">
        {#each sections as section (section.id)}
          <button
            onclick={() => (topic = section.id)}
            class="w-full text-left p-3 rounded-md transition-colors hover:bg-secondary text-muted-foreground"
          >
            {section.title}
          </button>
        {/each}
      </div>
    </div>
  {:else if current}
    <article class="max-h-[60%] overflow-y-auto p-6 border-b border-border bg-card">
      <div class="max-w-2xl mx-auto space-y-4">
        <div class="flex items-center gap-2">
          {#if compact}
            <button
              onclick={() => onBack?.()}
              class="shrink-0 p-1.5 rounded-md hover:bg-secondary text-muted-foreground"
              aria-label={i18n.t('Back')}
            >
              <ChevronLeft size={18} />
            </button>
          {/if}
          <h1 class="text-2xl font-bold text-foreground">{current.title}</h1>
        </div>
        {@html renderMarkdown(current.body)}
        {#if current.links.length > 0}
          <div class="flex flex-wrap gap-x-5 gap-y-2 pt-1">
            {#each current.links as link (link.target)}
              <button
                onclick={() => openLink(link.target)}
                class="inline-flex items-center gap-2 text-sm font-medium text-primary hover:underline text-left"
              >
                <ExternalLink size={16} class="shrink-0" />
                {link.label}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    </article>
  {/if}

  <div class="flex-1 min-h-0 flex items-center justify-center gap-6 p-6">
    <button
      onclick={() => onNavigate?.('chat')}
      class="min-w-44 px-10 py-5 rounded-xl bg-primary text-primary-foreground text-lg font-semibold shadow-sm hover:opacity-90 transition"
    >
      {i18n.t('Chat')}
    </button>
    <button
      onclick={() => onNavigate?.('wallet')}
      class="min-w-44 px-10 py-5 rounded-xl bg-primary text-primary-foreground text-lg font-semibold shadow-sm hover:opacity-90 transition"
    >
      {i18n.t('Wallet')}
    </button>
  </div>
</div>
