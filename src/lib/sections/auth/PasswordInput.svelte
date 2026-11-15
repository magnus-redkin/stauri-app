<script lang="ts">
  import { i18n } from '$lib/i18n';

  let {
    value = $bindable(),
    placeholder = i18n.t('Password'),
    onEnter,
    autofocus = false,
    disabled = false
  }: {
    value: string;
    placeholder?: string;
    onEnter?: () => void;
    autofocus?: boolean;
    disabled?: boolean;
  } = $props();

  let input: HTMLInputElement | undefined = $state();

  // The effect runs when `input` changes, that is, once the DOM node exists. The short
  // delay lets Svelte finish rendering before focus is moved.
  $effect(() => {
    if (autofocus && input) {
      const timer = setTimeout(() => input?.focus(), 50);
      return () => clearTimeout(timer);
    }
  });

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter' && onEnter) {
      e.preventDefault();
      onEnter();
    }
  }
</script>

<input
  bind:this={input}
  type="password"
  bind:value
  {placeholder}
  {disabled}
  onkeydown={handleKeydown}
  class="w-full px-3 py-2 border border-input rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
/>
