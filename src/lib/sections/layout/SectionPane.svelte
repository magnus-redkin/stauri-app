<script lang="ts">
  /**
   * Wrapper for panel content that guarantees scrolling at the layout level.
   *
   * Scrolling is a property of the layout, not of each page, so it is defined once at the
   * panel boundary and holds for every section, including ones added later. Sections that
   * scroll on their own (chat, wallet) fit the panel height exactly and produce no outer
   * scroll; a section taller than the panel and without its own scrolling overflows into
   * this wrapper's `scrollHeight`, and the wrapper scrolls for it.
   *
   * `h-full` rather than `min-h-full` is deliberate: sections set `h-full` on their root and
   * lay out a header plus a scrollable part (`flex flex-col` with `flex-1 min-h-0`).
   * Percentage heights resolve only against a parent with a definite height, which `h-full`
   * provides and `min-h-full` does not — with the latter, `flex-1` inside the section has no
   * boundary to shrink below and scrolling breaks again.
   */
  import type { Snippet } from 'svelte';

  let { children }: { children: Snippet } = $props();
</script>

<div class="h-full min-h-0 overflow-y-auto overflow-x-hidden overscroll-contain">
  {@render children()}
</div>
