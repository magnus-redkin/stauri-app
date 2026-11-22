<script lang="ts">
  /**
   * Left panel of the Home section: the About menu.
   *
   * The items are the `##` headings of the language's About document, in file order.
   *
   * Mirrors the left panels of the other sections (`bg-card`, one highlighted
   * row). Clicking the open topic again closes it, so the section can return to
   * its start screen.
   */
  import { i18n } from '$lib/i18n';
  import type { AboutSection } from './aboutSections';

  let {
    sections,
    active,
    onSelect,
  }: {
    sections: AboutSection[];
    active: string | null;
    onSelect: (id: string | null) => void;
  } = $props();
</script>

<div class="flex flex-col h-full border-r border-border bg-card">
  <div class="p-4 border-b border-border">
    <span class="font-bold text-lg text-primary">{i18n.t('About')}</span>
  </div>

  <div class="p-2 space-y-1">
    {#each sections as section (section.id)}
      <button
        onclick={() => onSelect(active === section.id ? null : section.id)}
        aria-current={active === section.id ? 'true' : undefined}
        class="w-full text-left p-3 rounded-md transition-colors {active === section.id
          ? 'bg-secondary font-medium text-foreground'
          : 'hover:bg-secondary text-muted-foreground'}"
      >
        {section.title}
      </button>
    {/each}
  </div>
</div>
