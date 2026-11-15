<script lang="ts">
  import "../app.css";
  import { onMount } from "svelte";
  let { children } = $props();

  /**
   * Suppresses the webview's built-in context menu (Back, Reload, Inspect).
   *
   * Reloading the webview loses the login session: afterwards the password is no
   * longer accepted ("Login timeout: no response from backend") and signing in
   * only works after restarting the app.
   *
   * @remarks
   * The listener runs in the capture phase so it fires before component handlers.
   * Input fields and editable regions are exempt: on Android a long press there
   * opens the "Paste" menu, without which no text (invite key, address) can be
   * pasted. The listener itself only handles the event, it does not provide a
   * context menu of its own.
   */
  onMount(() => {
    const block = (e: Event) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"], [contenteditable=""]')) {
        return;
      }
      e.preventDefault();
    };
    document.addEventListener("contextmenu", block, true);
    return () => document.removeEventListener("contextmenu", block, true);
  });
</script>

{@render children()}
