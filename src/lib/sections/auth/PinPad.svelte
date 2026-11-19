<script lang="ts">
  /**
   * PIN entry: dots and a numeric keypad.
   *
   * @remarks
   * A keypad rather than an `<input type="number">`: the system keyboard on Android
   * offers suggestions, autocorrect and copy-paste, and the PIN would end up in the
   * keyboard's learning dictionary and on the clipboard. Digits only, own layout, no
   * input method involved.
   *
   * The component holds the entered digits and nothing else: it does not compare them
   * and does not know the stored PIN, which lives encrypted on the Rust side.
   */
  import { i18n } from '$lib/i18n';

  let {
    /** Digits entered so far, owned by the caller so it can submit them. */
    value = $bindable(''),
    /** Longest PIN accepted; the keypad stops adding digits here. */
    maxLength = 12,
    /** Shortest PIN accepted; the confirm button stays disabled below it. */
    minLength = 4,
    /** Text above the dots. */
    title = '',
    /** Whether a confirm button is shown; `false` submits at `maxLength`. */
    confirmable = true,
    busy = false,
    error = '',
    onSubmit,
    onBack,
  }: {
    value: string;
    maxLength?: number;
    minLength?: number;
    title?: string;
    confirmable?: boolean;
    busy?: boolean;
    error?: string;
    onSubmit: () => void;
    onBack?: () => void;
  } = $props();

  // Layout of a phone keypad, with the two action keys on the bottom row.
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'back', '0', 'ok'];

  const canSubmit = $derived(value.length >= minLength && !busy);

  function press(key: string) {
    if (busy) return;
    if (key === 'back') {
      value = value.slice(0, -1);
      return;
    }
    if (key === 'ok') {
      if (canSubmit) onSubmit();
      return;
    }
    if (value.length >= maxLength) return;
    value += key;
    // With no confirm button the PIN submits itself when it is full: that is the flow
    // for a fixed-length PIN, where an extra press is only a chance to mistype.
    if (!confirmable && value.length === maxLength) onSubmit();
  }
</script>

<div class="flex flex-col items-center justify-center min-h-screen gap-6 p-4 bg-background">
  {#if onBack}
    <button
      onclick={onBack}
      disabled={busy}
      class="self-start text-sm text-muted-foreground hover:underline disabled:opacity-50"
    >
      ← {i18n.t('Back')}
    </button>
  {/if}

  <h1 class="text-2xl font-bold text-center text-foreground max-w-md">{title}</h1>

  <!--
    Dots, not the digits: a PIN is often entered in front of other people, and the
    length alone is what the user needs to see.
  -->
  <div class="flex items-center gap-3 h-10" aria-label={i18n.t('PIN length')}>
    {#each Array(maxLength) as _, i (i)}
      <div
        class="w-3 h-3 rounded-full transition-colors {i < value.length
          ? 'bg-primary'
          : 'bg-muted-foreground/30'}"
      ></div>
    {/each}
  </div>

  {#if error}
    <p class="text-sm text-destructive text-center max-w-md" aria-live="polite">{error}</p>
  {:else}
    <!-- Placeholder keeps the keypad from jumping when an error appears. -->
    <p class="text-sm text-transparent max-w-md">&nbsp;</p>
  {/if}

  <div class="grid grid-cols-3 gap-3 w-full max-w-xs">
    {#each keys as key (key)}
      {#if key === 'back'}
        <button
          onclick={() => press(key)}
          disabled={busy || value.length === 0}
          aria-label={i18n.t('Delete last digit')}
          class="h-16 rounded-lg border border-border text-lg font-medium text-foreground hover:bg-secondary transition disabled:opacity-30"
        >
          ⌫
        </button>
      {:else if key === 'ok'}
        <button
          onclick={() => press(key)}
          disabled={!confirmable || !canSubmit}
          aria-label={i18n.t('Confirm PIN')}
          class="h-16 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 transition disabled:opacity-30"
        >
          ✓
        </button>
      {:else}
        <button
          onclick={() => press(key)}
          disabled={busy}
          class="h-16 rounded-lg border border-border text-xl font-medium text-foreground hover:bg-secondary transition disabled:opacity-50"
        >
          {key}
        </button>
      {/if}
    {/each}
  </div>
</div>
