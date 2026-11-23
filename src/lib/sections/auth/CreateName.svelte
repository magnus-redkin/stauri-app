<script lang="ts">
  /**
   * Display name of a freshly created profile.
   *
   * @remarks
   * The account already exists and is open, so this is a setting, not a step that can
   * fail the creation: skipping keeps the name the backend created it with. The same
   * validation the profile editor uses applies here, so a name accepted on this screen
   * cannot be refused a minute later in the editor.
   */
  import { i18n } from '$lib/i18n';
  import { displayNameError } from '$lib/utils/displayName';

  let {
    /** Name to start from; the backend's default when nothing was chosen yet. */
    initial = 'New stauri user',
    busy = false,
    error = '',
    onSave,
    onSkip,
  }: {
    initial?: string;
    busy?: boolean;
    error?: string;
    onSave: (name: string) => void;
    onSkip: () => void;
  } = $props();

  let name = $state(initial);
  const problem = $derived(displayNameError(name));

  /**
   * Puts the caret in the field with the default name selected.
   *
   * @remarks
   * The field arrives pre-filled with the name the profile was created under, and the
   * usual intent is to replace it, not to append to it. Selecting it means one Backspace
   * clears the whole value and typing overwrites it, instead of deleting eleven
   * characters one press at a time. On focus rather than on mount alone: tapping back in
   * after a failed save should behave the same way.
   */
  function selectAllOnFocus(event: FocusEvent): void {
    const input = event.currentTarget as HTMLInputElement | null;
    input?.select();
  }

  let field = $state<HTMLInputElement | null>(null);
  $effect(() => {
    field?.focus();
  });

  function save(): void {
    if (!problem && !busy) onSave(name.trim());
  }
</script>

<div class="flex flex-col items-center justify-center min-h-screen gap-5 p-4 bg-background">
  <h1 class="text-2xl font-bold text-center text-foreground max-w-md">
    {i18n.t('Display name')}
  </h1>
  <p class="text-sm text-muted-foreground text-center max-w-md">
    {i18n.t('This is how other people see you. You can change it later.')}
  </p>

  <input
    type="text"
    bind:this={field}
    bind:value={name}
    onfocus={selectAllOnFocus}
    onkeydown={(e) => {
      if (e.key === 'Enter') save();
    }}
    maxlength={40}
    autocomplete="off"
    spellcheck="false"
    class="w-full max-w-md px-3 py-2 border border-input rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
    placeholder={i18n.t('Display name')}
    aria-label={i18n.t('Display name')}
  />

  {#if problem}
    <p class="text-sm text-destructive text-center max-w-md" aria-live="polite">{i18n.t(problem)}</p>
  {:else if error}
    <p class="text-sm text-destructive text-center max-w-md" aria-live="polite">{error}</p>
  {:else}
    <p class="text-sm text-transparent max-w-md">&nbsp;</p>
  {/if}

  <button
    onclick={save}
    disabled={!!problem || busy}
    class="w-full max-w-md py-3 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
  >
    {busy ? i18n.t('Working…') : i18n.t('Continue')}
  </button>

  <button onclick={onSkip} disabled={busy} class="text-sm text-muted-foreground hover:underline disabled:opacity-50">
    {i18n.t('Skip for now')}
  </button>
</div>
