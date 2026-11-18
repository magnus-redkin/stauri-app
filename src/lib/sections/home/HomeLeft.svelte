<script lang="ts">
  /**
   * Left panel of the Home section: the About menu.
   *
   * Mirrors the left panels of the other sections (`bg-card`, one highlighted
   * row). Clicking the open topic again closes it, so the section can return to
   * its start screen.
   */
  import { i18n } from '$lib/i18n';
  import { TOPICS, type TopicId } from './homeTopics';

  let {
    active,
    onSelect,
  }: { active: TopicId | null; onSelect: (id: TopicId | null) => void } = $props();
</script>

<div class="flex flex-col h-full border-r border-border bg-card">
  <div class="p-4 border-b border-border">
    <span class="font-bold text-lg text-primary">{i18n.t('About')}</span>
  </div>

  <div class="p-2 space-y-1">
    {#each TOPICS as topic (topic.id)}
      <button
        onclick={() => onSelect(active === topic.id ? null : topic.id)}
        aria-current={active === topic.id ? 'true' : undefined}
        class="w-full text-left p-3 rounded-md transition-colors {active === topic.id
          ? 'bg-secondary font-medium text-foreground'
          : 'hover:bg-secondary text-muted-foreground'}"
      >
        {i18n.t(topic.title)}
      </button>
    {/each}
  </div>
</div>
