<script lang="ts">
  /**
   * Pairing screen: one device hands the profile to the other across the local network.
   *
   * @remarks
   * The screen renders the phase it is given and calls the handlers; discovery, the
   * handshake and the transfer live in Rust (`lanpair.rs`). Neither person reads a long
   * code: the only thing they read is six digits, and the digits agree on both screens
   * only when the two devices share one secret — which an attacker relaying between two
   * handshakes cannot produce.
   *
   * The sending side starts with the PIN pad, because the code must not appear on a phone
   * left on a table. The receiving side has nothing to unlock yet: it chooses its PIN
   * after the profile arrives.
   */
  import { i18n } from '$lib/i18n';
  import PinPad from './PinPad.svelte';

  let {
    /** What this device does. */
    role = 'receiver',
    /** `idle`, `waiting`, `codes`, `transferring`, `done` or `failed`. */
    phase = 'waiting',
    /** Six digits both devices compare, empty until the handshake finishes. */
    digits = '',
    error = '',
    /** This device's address, shown on the receiving side while it waits. */
    localAddress = '',
    /** Digits entered on the PIN pad, on the sending side. */
    pin = $bindable(''),
    pinError = '',
    pinMin = 4,
    pinMax = 12,
    /** Whether the message history travels with the profile. */
    syncHistory = $bindable(true),
    /** Whether Sync was pressed on this device and the other side is still deciding. */
    confirmed = false,
    /** Confirms the PIN, which starts the search. */
    onPin,
    /** Leaves without starting. */
    onPinCancel,
    /** Presses Sync after the digits match on both screens. */
    onConfirm,
    /** Tries a direct probe at the address typed on the sending side. */
    onAddress,
    /** Leaves the screen. */
    onBack,
  }: {
    role: 'sender' | 'receiver';
    phase?: 'idle' | 'waiting' | 'codes' | 'transferring' | 'done' | 'failed';
    digits?: string;
    error?: string;
    localAddress?: string;
    pin?: string;
    pinError?: string;
    pinMin?: number;
    pinMax?: number;
    syncHistory?: boolean;
    confirmed?: boolean;
    onPin: () => void;
    onPinCancel: () => void;
    onConfirm: () => void;
    onAddress?: (address: string) => void;
    onBack: () => void;
  } = $props();

  /** Address typed by the user when the search finds nothing. */
  let typedAddress = $state('');

  /** Whether the sending side is still behind the PIN. */
  const askingPin = $derived(role === 'sender' && phase === 'idle');

  const title = $derived(
    role === 'sender'
      ? i18n.t('Sync with another device')
      : i18n.t('Get a profile from another device')
  );
</script>

{#if askingPin}
  <!--
    The code is a key to the profile, so the sender proves who is holding the phone
    before anything is issued. The same pad as everywhere else in the app: a PIN is
    entered one way, not two.
  -->
  <PinPad
    bind:value={pin}
    minLength={pinMin}
    maxLength={pinMax}
    title={i18n.t('Enter your PIN to start the transfer')}
    error={pinError}
    onSubmit={onPin}
    onBack={onPinCancel}
  >
    {#snippet below()}
      <!--
        History is decided here because status-go prepares the payload the moment the
        server starts; the receiving device cannot influence it afterwards.
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
    {/snippet}
  </PinPad>
{:else}
  <div class="flex flex-col items-center justify-center min-h-screen gap-5 p-4 bg-background">
    <button
      onclick={onBack}
      disabled={phase === 'transferring'}
      class="self-start text-sm text-muted-foreground hover:underline disabled:opacity-50"
    >
      ← {i18n.t('Back')}
    </button>

    <h1 class="text-2xl font-bold text-center text-foreground max-w-md">{title}</h1>

    {#if phase === 'waiting'}
      <!--
        Discovery is a probe on the local network, so "waiting" is the normal state for a
        moment. The hint names the four causes that produce exactly this screen and
        nothing else, instead of leaving five minutes of silence to interpret.
      -->
      <div class="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
      <p class="text-sm font-semibold text-center text-foreground max-w-md">
        {i18n.t('Waiting for the other device')}
      </p>
      <p class="text-sm text-muted-foreground text-center max-w-md">
        {i18n.t('Both devices must be on the same network: the same Wi-Fi, or a USB cable with tethering on. A guest network, client isolation or a VPN will keep them apart.')}
      </p>

      {#if role === 'sender'}
        <!--
          Broadcast is the first attempt, and it is the one routers drop most often. A
          direct probe at a typed address runs exactly the same exchange; the six digits
          still decide whether the other side is the right one.
        -->
        <div class="w-full max-w-md flex gap-2">
          <input
            type="text"
            bind:value={typedAddress}
            inputmode="decimal"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            placeholder={i18n.t('Address of the other device')}
            class="flex-1 rounded-md border border-border bg-card px-3 py-2 font-mono text-sm text-foreground"
            aria-label={i18n.t('Address of the other device')}
          />
          <button
            onclick={() => {
              const value = typedAddress.trim();
              if (value) onAddress?.(value);
            }}
            disabled={!typedAddress.trim()}
            class="px-4 py-2 bg-secondary text-secondary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {i18n.t('Connect')}
          </button>
        </div>
        <p class="text-xs text-muted-foreground text-center max-w-md">
          {i18n.t('If the search finds nothing, type the address shown on the other device.')}
        </p>
      {:else if localAddress}
        <p class="text-sm text-muted-foreground text-center max-w-md">
          {i18n.t('This device')}:
          <span class="font-mono text-foreground">{localAddress}</span>
        </p>
        <p class="text-xs text-muted-foreground text-center max-w-md">
          {i18n.t('If the search finds nothing, type this address on the other device.')}
        </p>
      {/if}
    {:else if phase === 'codes'}
      <!--
        The digits are what two people read to each other. A substituted peer produces
        different digits, and a mismatch is the moment to stop.
      -->
      <p class="text-sm font-semibold text-center text-foreground max-w-md">
        {i18n.t('Comparison digits')}
      </p>
      <p class="text-sm text-muted-foreground text-center max-w-md">
        {i18n.t('They must match the digits on the other device. If they differ, stop.')}
      </p>
      <div
        class="w-full max-w-md rounded-lg border-2 border-primary bg-card py-4 text-center font-mono text-4xl font-bold tracking-[0.3em] text-foreground"
        aria-label={i18n.t('Comparison digits')}
      >
        {digits || '······'}
      </div>
      <button
        onclick={onConfirm}
        disabled={confirmed}
        class="w-full max-w-md py-3 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
      >
        {i18n.t('Sync')}
      </button>
      {#if confirmed}
        <!-- Both sides press; after this one the screen waits for the other device. -->
        <p class="text-sm text-muted-foreground text-center max-w-md">
          {i18n.t('Waiting for confirmation on the other device')}
        </p>
      {/if}
    {:else if phase === 'transferring'}
      <div class="h-8 w-8 rounded-full border-2 border-primary border-t-transparent animate-spin"></div>
      <p class="text-sm font-semibold text-center text-foreground max-w-md">
        {i18n.t('Transferring the profile…')}
      </p>
      <p class="text-xs text-muted-foreground text-center max-w-md">
        {i18n.t('Keep both screens open. This can take a minute for a large history.')}
      </p>
    {:else if phase === 'done'}
      <p class="text-sm font-semibold text-center text-foreground max-w-md">
        {i18n.t('Done')}
      </p>
    {/if}

    {#if error}
      <p class="text-sm text-destructive text-center max-w-md" aria-live="polite">{error}</p>
    {/if}
  </div>
{/if}
