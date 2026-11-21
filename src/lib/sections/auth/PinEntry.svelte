<script lang="ts">
  /**
   * PIN entry, shaped by the platform.
   *
   * @remarks
   * The secret and the envelope are the same everywhere (`credentials.rs`); only the way
   * it is typed differs. A phone gets a numeric keypad — no system keyboard, so the PIN
   * never reaches an input method's dictionary. A desktop gets a password field: clicking
   * digits with a mouse is slow, and every click is visible to whoever watches the
   * screen, which defeats the purpose of a PIN.
   *
   * Call sites use this component instead of either one so the choice lives in one place.
   */
  import type { Snippet } from 'svelte';
  import PinPad from './PinPad.svelte';
  import PassphraseField from './PassphraseField.svelte';
  import { isAndroid } from '$lib/utils/platform';

  let {
    value = $bindable(''),
    /** Longest secret accepted; callers pass a smaller bound for a numeric keypad. */
    maxLength = 12,
    minLength = 4,
    title = '',
    /** Whether the keypad shows a confirm button; unused on desktop. */
    confirmable = true,
    /** Whether the desktop field shows the live creation checklist. */
    checklist = false,
    busy = false,
    error = '',
    onSubmit,
    onBack,
    below,
  }: {
    value: string;
    maxLength?: number;
    minLength?: number;
    title?: string;
    confirmable?: boolean;
    checklist?: boolean;
    busy?: boolean;
    error?: string;
    onSubmit: () => void;
    onBack?: () => void;
    below?: Snippet;
  } = $props();

  // The platform does not change while the page is open, so this is decided once.
  const android = isAndroid();
</script>

{#if android}
  <PinPad
    bind:value
    {maxLength}
    {minLength}
    {title}
    {confirmable}
    {busy}
    {error}
    {onSubmit}
    onBack={onBack}
    below={below}
  />
{:else}
  <PassphraseField
    bind:value
    {maxLength}
    {minLength}
    {title}
    {checklist}
    {busy}
    {error}
    {onSubmit}
    onBack={onBack}
    below={below}
  />
{/if}
