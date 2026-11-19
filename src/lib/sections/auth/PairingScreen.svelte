<script lang="ts">
  /**
   * Pairing screen: one device shows a connection string, the other reads it.
   *
   * @remarks
   * There is no discovery step, and that is not an oversight. status-go disables the LAN
   * beacon on Android (`PeerNotifier.Search` returns early there), so a "search for
   * devices" screen would find nothing on the platform this flow is built for. The
   * connection string is the only channel, and it is also what authenticates the
   * transfer: it carries the address, the key and the certificate, so a stranger on the
   * same Wi-Fi cannot pose as the other device.
   *
   * The string is several hundred characters of base64. It is shown with a copy button
   * and accepted with a paste button, which is honest about how it travels for now;
   * a QR camera is the follow-up, and the layout already has a slot for it.
   */
  import { i18n } from '$lib/i18n';

  let {
    /** What this device does: show a string, or read the other one's. */
    role = 'receiver',
    /** String this device produced, when it is the one showing. */
    connectionString = '',
    /** Text entered by the user, when this device reads the other one's string. */
    value = $bindable(''),
    busy = false,
    error = '',
    /** Six digits both devices compare, empty until the code is shown. */
    confirmationCode = '',
    /** Whether the code is already on screen. */
    showingCode = false,
    /** Whether this device is asking for its PIN before it shows a code. */
    promptPin = false,
    /** Digits entered on the PIN prompt. */
    pin = $bindable(''),
    pinError = '',
    pinMin = 4,
    pinMax = 12,
    /** Whether the message history travels with the profile. */
    syncHistory = $bindable(false),
    /** Produces the string on this device. */
    onStart,
    /** Runs the transfer with the string in `value`. */
    onTransfer,
    /** Confirms the PIN prompt. */
    onPin,
    /** Leaves the PIN prompt without showing a code. */
    onPinCancel,
    /** Leaves the screen. */
    onBack,
  }: {
    role: 'sender' | 'receiver';
    connectionString?: string;
    value?: string;
    busy?: boolean;
    error?: string;
    confirmationCode?: string;
    showingCode?: boolean;
    promptPin?: boolean;
    pin?: string;
    pinError?: string;
    pinMin?: number;
    pinMax?: number;
    syncHistory?: boolean;
    onStart: () => void;
    onTransfer: () => void;
    onPin: () => void;
    onPinCancel: () => void;
    onBack: () => void;
  } = $props();

  let copied = $state(false);

  async function copyString(): Promise<void> {
    try {
      await navigator.clipboard.writeText(connectionString);
      copied = true;
      setTimeout(() => (copied = false), 2000);
    } catch {
      // A clipboard the webview refuses is not fatal: the string is selectable on
      // screen, so the user can still copy it by hand.
    }
  }

  const canTransfer = $derived(value.trim().length > 0 && !busy);
</script>

<div class="flex flex-col items-center justify-center min-h-screen gap-5 p-4 bg-background">
  <button
    onclick={onBack}
    disabled={busy}
    class="self-start text-sm text-muted-foreground hover:underline disabled:opacity-50"
  >
    ← {i18n.t('Back')}
  </button>

  <h1 class="text-2xl font-bold text-center text-foreground max-w-md">
    {role === 'sender' ? i18n.t('Show this device\'s code') : i18n.t('Get a profile from another device')}
  </h1>

  {#if promptPin}
    <!--
      The code is a five-minute key to the profile, so the sender proves who is holding
      the phone before showing it. The same `openPin` as the entry flow: wrong attempts
      count towards the same limit, so this is not a free guessing oracle.
    -->
    <p class="text-sm text-muted-foreground text-center max-w-md">
      {i18n.t('Enter your PIN to show the code.')}
    </p>
    <input
      type="password"
      inputmode="numeric"
      bind:value={pin}
      onkeydown={(e) => {
        if (e.key === 'Enter' && !busy) onPin();
      }}
      placeholder={i18n.t('PIN')}
      autocomplete="off"
      class="w-full max-w-md rounded-md border border-input bg-background px-3 py-3 text-center font-mono text-lg tracking-[0.4em] text-foreground"
      aria-label={i18n.t('PIN')}
    />
    {#if pinError}
      <p class="text-destructive text-sm text-center max-w-md" aria-live="polite">{pinError}</p>
    {/if}
    <button
      onclick={onPin}
      disabled={busy || pin.length < pinMin}
      class="w-full max-w-md py-3 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
    >
      {busy ? i18n.t('Working…') : i18n.t('Show the code')}
    </button>
    <button onclick={onPinCancel} class="text-sm text-muted-foreground hover:underline">
      {i18n.t('Cancel')}
    </button>
  {:else if role === 'sender'}
    {#if connectionString === ''}
      <!--
        The sender is the device that *has* the profile, so it is the one that produces the
        code. Starting the server is a separate press: it stays open until the transfer
        finishes, and opening a window no one asked for is worse than one extra tap.
      -->
      <p class="text-sm text-muted-foreground text-center max-w-md">
        {i18n.t('The code is shown here and entered on the other device.')}
      </p>
      <button
        onclick={onStart}
        disabled={busy}
        class="w-full max-w-md py-3 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
      >
        {busy ? i18n.t('Working…') : i18n.t('Show the code')}
      </button>
    {:else}
      {#if showingCode}
        <!--
          The digits are what the two people read to each other. A string swapped on its
          way across yields different digits, so a mismatch is the moment to stop — the
          comparison replaces the check the user could not otherwise make.
        -->
        <p class="text-sm text-muted-foreground text-center max-w-md">
          {i18n.t('Compare this with the other device. If the digits differ, stop.')}
        </p>
        <div
          class="w-full max-w-md rounded-lg border-2 border-primary bg-card py-4 text-center font-mono text-4xl font-bold tracking-[0.3em] text-foreground"
          aria-label={i18n.t('Confirmation code')}
        >
          {confirmationCode}
        </div>
      {/if}

      <p class="text-sm text-muted-foreground text-center max-w-md">
        {i18n.t('Enter this code on the other device.')}
      </p>
      <!--
        A textarea rather than a one-line input: the string is long enough that a single
        line hides most of it, and the user needs to see that it all arrived.
      -->
      <textarea
        readonly
        value={connectionString}
        rows="5"
        class="w-full max-w-md rounded-md border border-border bg-card p-3 font-mono text-xs text-foreground break-all resize-none"
        aria-label={i18n.t('Connection code')}
      ></textarea>

      <button
        onclick={copyString}
        class="w-full max-w-md py-2 border border-border rounded-md text-sm font-medium hover:bg-secondary transition"
      >
        {copied ? i18n.t('Copied') : i18n.t('Copy the code')}
      </button>

      <!--
        History is a choice. status-go transfers the whole message database with no date
        window, so the box starts unticked and says what it costs.
      -->
      <label class="flex w-full max-w-md items-start gap-2 text-sm text-foreground">
        <input type="checkbox" bind:checked={syncHistory} class="mt-1" />
        <span>
          {i18n.t('Also transfer message history')}
          <span class="block text-xs text-muted-foreground">
            {i18n.t('All messages on this device travel, with no date limit.')}
          </span>
        </span>
      </label>

      <!--
        No paste field here. The sender's job ends at showing the code: the other device
        reads it and connects, and the sender only waits. Offering a field and a button
        named "Start the transfer" on this side made the two roles look identical and left
        the user unsure which device was supposed to do what.
      -->
      <p class="text-xs text-muted-foreground text-center max-w-md">
        {i18n.t('The code stops working in five minutes. Keep this screen open until the transfer finishes.')}
      </p>
    {/if}
  {:else}
    <p class="text-sm text-muted-foreground text-center max-w-md">
      {i18n.t('Paste the code shown on the other device.')}
    </p>

    <!--
      A plain text input, not a textarea and not a clipboard API call. Long-press →
      Paste works in every Android WebView, while `navigator.clipboard.readText()` needs
      a permission a webview may refuse without telling the page; the field is also
      where a user actually expects to put a code.
    -->
    <input
      type="text"
      bind:value
      placeholder={i18n.t('Connection code')}
      autocomplete="off"
      autocapitalize="off"
      autocorrect="off"
      spellcheck="false"
      class="w-full max-w-md rounded-md border border-border bg-card px-3 py-2 font-mono text-xs text-foreground"
      aria-label={i18n.t('Connection code')}
    />

    {#if confirmationCode}
      <!--
        The digits of the string that was pasted. They must equal the six on the other
        screen; pressing again after a mismatch is what starts the transfer, so a wrong
        code is never sent by accident on the first press.
      -->
      <p class="text-sm text-muted-foreground text-center max-w-md">
        {i18n.t('Compare this with the other device. If the digits differ, stop.')}
      </p>
      <div
        class="w-full max-w-md rounded-lg border-2 border-primary bg-card py-4 text-center font-mono text-4xl font-bold tracking-[0.3em] text-foreground"
        aria-label={i18n.t('Confirmation code')}
      >
        {confirmationCode}
      </div>
    {/if}

    <button
      onclick={onTransfer}
      disabled={!canTransfer}
      class="w-full max-w-md py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
    >
      {busy
        ? i18n.t('Working…')
        : confirmationCode
          ? i18n.t('The digits match — start the transfer')
          : i18n.t('Show the confirmation code')}
    </button>
  {/if}

  {#if error}
    <p class="text-destructive text-sm text-center max-w-md" aria-live="polite">{error}</p>
  {/if}
</div>
