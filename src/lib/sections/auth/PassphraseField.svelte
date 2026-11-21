<script lang="ts">
  /**
   * PIN entry on a desktop: one masked field, no keypad.
   *
   * @remarks
   * The secret is the same one the phone keeps (`credentials.rs`), and it goes through
   * the same Argon2id derivation. What differs is only the way it is typed: with a mouse,
   * a numeric keypad is slow and every click is visible to whoever watches the screen,
   * which is the opposite of what a PIN is for. A password field accepts letters, digits
   * and symbols, and the keyboard hides the strokes.
   *
   * Like {@link PinPad}, the component holds the entered text and nothing else: it does
   * not compare it and does not know the stored secret.
   */
  import type { Snippet } from 'svelte';
  import { i18n } from '$lib/i18n';

  let {
    /** Text entered so far, owned by the caller so it can submit it. */
    value = $bindable(''),
    /** Longest secret accepted; the field stops accepting characters here. */
    maxLength = 64,
    /** Shortest secret accepted; the button stays disabled below it. */
    minLength = 4,
    /** Text above the field. */
    title = '',
    /** Whether the four character classes must all be present, as on creation. */
    checklist = false,
    busy = false,
    error = '',
    onSubmit,
    onBack,
    /** Extra content under the field — a checkbox, a hint, a countdown. */
    below,
  }: {
    value: string;
    maxLength?: number;
    minLength?: number;
    title?: string;
    checklist?: boolean;
    busy?: boolean;
    error?: string;
    onSubmit: () => void;
    onBack?: () => void;
    below?: Snippet;
  } = $props();

  const length = $derived([...value].length);
  const hasLower = $derived(/[a-z]/.test(value));
  const hasUpper = $derived(/[A-Z]/.test(value));
  const hasDigit = $derived(/\d/.test(value));
  const hasSymbol = $derived(/[^A-Za-z0-9]/.test(value));
  const longEnough = $derived(length >= minLength);

  /**
   * Whether the PIN can be submitted.
   *
   * @remarks
   * On creation the four classes are a hard requirement, because the backend will refuse
   * anything less. On the screens that open an existing PIN only the length is checked:
   * what is stored there is not re-judged.
   */
  const canSubmit = $derived(
    (checklist ? longEnough && hasLower && hasUpper && hasDigit && hasSymbol : longEnough) &&
      !busy
  );

  /** Puts the cursor in the field: it is the only thing to do on this screen. */
  function focusOnMount(node: HTMLInputElement): void {
    node.focus();
  }

  function submit(): void {
    if (canSubmit) onSubmit();
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

  <p class="text-sm text-muted-foreground text-center max-w-md">
    {i18n.t('Any characters: letters, digits and symbols.')}
  </p>

  <!--
    `type="password"` and no reveal toggle: the field exists because a PIN typed where
    someone can watch it is already compromised. `autocomplete="off"` keeps the browser
    from offering to store the device PIN in its password manager, where it would outlive
    the device's own protection.
  -->
  <input
    type="password"
    bind:value
    use:focusOnMount
    maxlength={maxLength}
    onkeydown={(e) => {
      if (e.key === 'Enter') submit();
    }}
    autocomplete="off"
    autocapitalize="off"
    autocorrect="off"
    spellcheck="false"
    class="w-full max-w-md px-3 py-2 border border-input rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    placeholder={i18n.t('PIN')}
    aria-label={title || i18n.t('PIN')}
  />

  {#if checklist}
    <!--
      One line per rule, checked as the user types. A list that reveals itself only after
      a failed save makes the user guess; showing all five rows from the start turns the
      PIN into something to be built rather than something to be rejected.
    -->
    <ul class="w-full max-w-md space-y-1 text-sm" aria-live="polite">
      <li class="flex items-center gap-2">
        <span class="w-4 text-center {longEnough ? 'text-success' : 'text-muted-foreground/40'}">
          {longEnough ? '✓' : '·'}
        </span>
        <span class={longEnough ? 'text-foreground' : 'text-muted-foreground'}>
          {i18n.t('At least')} {minLength} {i18n.t('characters')}
        </span>
      </li>
      <li class="flex items-center gap-2">
        <span class="w-4 text-center {hasLower ? 'text-success' : 'text-muted-foreground/40'}">
          {hasLower ? '✓' : '·'}
        </span>
        <span class={hasLower ? 'text-foreground' : 'text-muted-foreground'}>{i18n.t('Lowercase letter')}</span>
      </li>
      <li class="flex items-center gap-2">
        <span class="w-4 text-center {hasUpper ? 'text-success' : 'text-muted-foreground/40'}">
          {hasUpper ? '✓' : '·'}
        </span>
        <span class={hasUpper ? 'text-foreground' : 'text-muted-foreground'}>{i18n.t('Uppercase letter')}</span>
      </li>
      <li class="flex items-center gap-2">
        <span class="w-4 text-center {hasDigit ? 'text-success' : 'text-muted-foreground/40'}">
          {hasDigit ? '✓' : '·'}
        </span>
        <span class={hasDigit ? 'text-foreground' : 'text-muted-foreground'}>{i18n.t('Digit')}</span>
      </li>
      <li class="flex items-center gap-2">
        <span class="w-4 text-center {hasSymbol ? 'text-success' : 'text-muted-foreground/40'}">
          {hasSymbol ? '✓' : '·'}
        </span>
        <span class={hasSymbol ? 'text-foreground' : 'text-muted-foreground'}>{i18n.t('Symbol')}</span>
      </li>
    </ul>
  {/if}

  {#if error}
    <p class="text-sm text-destructive text-center max-w-md" aria-live="polite">{error}</p>
  {:else}
    <!-- Placeholder keeps the field from jumping when an error appears. -->
    <p class="text-sm text-transparent max-w-md">&nbsp;</p>
  {/if}

  <button
    onclick={submit}
    disabled={!canSubmit}
    class="w-full max-w-md py-3 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
  >
    {busy ? i18n.t('Working…') : i18n.t('Continue')}
  </button>

  {#if below}
    {@render below()}
  {/if}
</div>
