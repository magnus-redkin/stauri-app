<script lang="ts">
  /**
   * Mobile entry screen: network, profile list, PIN, creation, recovery.
   *
   * @remarks
   * The screen renders the phase; every decision about *which* phase comes next is made by
   * `$lib/entry/entryFlow`, which is unit-tested without a webview. This file is layout
   * and wiring only, so a change of flow rules does not mean touching markup.
   *
   * The desktop entry (`MainEntryScreen`) is untouched and stays the path for the desktop
   * build until its own flow is revised.
   */
  import { i18n } from '$lib/i18n';
  import NetworkPicker from '$lib/sections/auth/NetworkPicker.svelte';
  import PinPad from '$lib/sections/auth/PinPad.svelte';
  import { statusState } from '$lib/stores/statusStore.svelte';
  import type { EntryPhase, Network, ProfileSummary } from '$lib/entry/entryFlow';

  let {
    phase = $bindable<EntryPhase>({ kind: 'login' }),
    hasProfiles = false,
    profileCount = 0,
    /** Digits entered on the PIN pad; the page submits them. */
    pin = $bindable(''),
    pinMin = 4,
    pinMax = 12,
    /** Whether a new PIN is being entered a second time. */
    pinConfirming = false,
    busy = false,
    error = '',
    onNetworkChange,
    onSelectProfile,
    onCreate,
    onRestorePhrase,
    onSubmitPin,
    onPinBack,
    onPair,
  }: {
    phase: EntryPhase;
    hasProfiles: boolean;
    /** How many profiles this device has; with one, the PIN is asked for directly. */
    profileCount?: number;
    pin: string;
    pinMin: number;
    pinMax: number;
    /** Whether a new PIN is being entered a second time. */
    pinConfirming?: boolean;
    busy: boolean;
    error: string;
    /** Fires when the network above the list is changed. */
    onNetworkChange: (network: Network) => void;
    onSelectProfile: (profile: ProfileSummary) => void;
    /** Starts profile creation: the password is generated, then a PIN is asked for. */
    onCreate: () => void;
    /** Opens the seed-phrase restore form. */
    onRestorePhrase: () => void;
    /** The PIN pad was confirmed. */
    onSubmitPin: () => void;
    /** Leaving the PIN pad. */
    onPinBack: () => void;
    /** Starts pairing over the chosen transport. */
    onPair: (method: 'wifi' | 'usb') => void;
  } = $props();

  // The picker speaks the config's network names (`sepolia`, `holesky`), while a
  // credential slot is scoped by `mainnet`/`testnet` only. Mapping here keeps the two
  // vocabularies apart instead of leaking the picker's names into storage.
  let pickerNetwork = $state(statusState.networkName || 'mainnet');
  const networkOf = (name: string): Network => (name === 'mainnet' ? 'mainnet' : 'testnet');

  function handleNetwork(net: string) {
    pickerNetwork = net;
    onNetworkChange(networkOf(net));
  }

  // The transport picker is gone: one path, on whatever local network both devices share.

  /** Profile label for the PIN screens. */
  function label(profile: ProfileSummary): string {
    return profile.name || `${profile.keyUid.slice(0, 10)}…`;
  }
</script>

{#if phase.kind === 'enter-pin'}
  <!--
    Opening an existing profile. The PIN is the only interaction: the password behind it is
    generated and never shown, and there is no system prompt on the way.
  -->
  <PinPad
    bind:value={pin}
    minLength={pinMin}
    maxLength={pinMax}
    title={`${i18n.t('Enter your PIN')} · ${label(phase.profile)}`}
    {busy}
    {error}
    onSubmit={onSubmitPin}
    onBack={profileCount > 1 ? onPinBack : undefined}
  />

{:else if phase.kind === 'password'}
  <!--
    A profile from before the PIN scheme, or one synced from a device that had none. The
    password is its only key, so the field is the way in — and it is asked once: the page
    follows it with the PIN pad, so the profile stops needing a typed password from here.
  -->
  <div class="flex flex-col items-center justify-center min-h-screen gap-5 p-4 bg-background">
    <h1 class="text-2xl font-bold text-center text-foreground max-w-md">
      {i18n.t('Enter the password')} · {label(phase.profile)}
    </h1>
    <p class="text-sm text-muted-foreground text-center max-w-md">
      {i18n.t('This profile was created before PINs. Enter its password once — then choose a PIN for it.')}
    </p>
    <input
      type="password"
      value={pin}
      oninput={(e) => (pin = (e.currentTarget as HTMLInputElement).value)}
      onkeydown={(e) => {
        if (e.key === 'Enter' && !busy) onSubmitPin();
      }}
      class="w-full max-w-md px-3 py-2 border border-input rounded-md bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      placeholder={i18n.t('Password')}
      aria-label={i18n.t('Password')}
    />
    <button
      onclick={onSubmitPin}
      disabled={busy || pin.length === 0}
      class="w-full max-w-md py-3 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
    >
      {busy ? i18n.t('Working…') : i18n.t('Log In')}
    </button>
    <button onclick={onPinBack} class="text-sm text-muted-foreground hover:underline">
      ← {i18n.t('Back')}
    </button>
  </div>

{:else if phase.kind === 'set-pin' || phase.kind === 'create-pin'}
  <!--
    A new profile: the PIN is what the user will remember, and it is chosen *before* the
    account exists. Confirmed twice by the page before it is saved, so a mistyped PIN
    cannot lock the profile behind a value its owner does not know — and quitting before
    the second entry leaves nothing behind to clean up.
  -->
  <PinPad
    bind:value={pin}
    minLength={pinMin}
    maxLength={pinMax}
    title={pinConfirming
      ? i18n.t('Repeat the PIN')
      : i18n.t('Choose a PIN for this profile')}
    {busy}
    {error}
    onSubmit={onSubmitPin}
  />

{:else}
  <div class="flex flex-col items-center justify-center min-h-screen gap-6 p-4 bg-background">
    {#if phase.kind === 'login'}
      <h1 class="text-3xl font-bold text-foreground">Stauri</h1>

      <NetworkPicker bind:selectedNetwork={pickerNetwork} onSelect={handleNetwork} />

      <div class="w-full max-w-md h-px bg-border my-2"></div>

      <!--
        The network, then the profile. Everything on this screen is about one question —
        which profile to open — so the choices sit under one heading instead of being
        spread over three separate screens with their own Back buttons.
      -->
      <h2 class="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {i18n.t('Profile')}
      </h2>

      <div class="w-full max-w-md space-y-2">
        {#if hasProfiles}
          <button
            onclick={() => (phase = { kind: 'pick-profile' })}
            disabled={busy}
            class="w-full py-3 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
          >
            {i18n.t('Select Profile & Log in')}
          </button>
        {/if}

        <!--
          Creation is the first action on a clean device: it is the only one that does not
          need a profile to already exist.
        -->
        <button
          onclick={onCreate}
          disabled={busy}
          class="{hasProfiles ? 'border border-border' : 'bg-primary text-primary-foreground'} w-full py-3 rounded-md text-sm font-medium transition hover:opacity-90 disabled:opacity-50"
        >
          {i18n.t('Create Profile')}
        </button>

        <button
          onclick={() => (phase = { kind: 'restore-method' })}
          class="w-full py-3 border border-border rounded-md text-sm font-medium hover:bg-secondary transition"
        >
          {i18n.t('Restore or sync')}
        </button>
      </div>

    {:else if phase.kind === 'pick-profile'}
      <h1 class="text-2xl font-bold text-foreground">{i18n.t('Select Profile & Log in')}</h1>

      <!--
        The network lives here too, not only on the first screen. A profile belongs to one
        network, and the desktop entry used to show the picker on every screen; hiding it
        once the list is open made a profile created in the other network unreachable
        without going back.
      -->
      <NetworkPicker bind:selectedNetwork={pickerNetwork} onSelect={handleNetwork} />

      {#if statusState.accounts.length === 0}
        <p class="text-sm text-muted-foreground text-center max-w-md">
          {i18n.t('No profiles on this device for this network.')}
        </p>
      {:else}
        <div class="w-full max-w-md space-y-2">
          {#each statusState.accounts as account (account['key-uid'])}
            <!--
              The display name is the label; the key prefix is the fallback, and is what a
              user sees when status-go has no name for the profile.
            -->
            <button
              onclick={() =>
                onSelectProfile({
                  keyUid: account['key-uid'],
                  name: account.name || account.alias || undefined,
                })}
              disabled={busy}
              class="w-full flex items-center gap-3 px-4 py-3 rounded-lg border border-border hover:bg-secondary transition text-left disabled:opacity-50"
            >
              <div class="w-9 h-9 rounded-full bg-secondary flex items-center justify-center text-xs text-muted-foreground">
                {(account.name || '?').slice(0, 1).toUpperCase()}
              </div>
              <div class="min-w-0">
                <div class="text-sm font-medium text-foreground truncate">
                  {account.name || i18n.t('Unnamed profile')}
                </div>
                <div class="text-xs text-muted-foreground font-mono">
                  {account['key-uid'].slice(0, 16)}…
                </div>
              </div>
            </button>
          {/each}
        </div>
      {/if}

      <button
        onclick={() => (phase = { kind: 'login' })}
        class="text-sm text-muted-foreground hover:underline"
      >
        ← {i18n.t('Back')}
      </button>

    {:else if phase.kind === 'restore-method'}
      <h1 class="text-2xl font-bold text-foreground">{i18n.t('Restore or sync')}</h1>

      <div class="w-full max-w-md space-y-2">
        <button
          onclick={onRestorePhrase}
          class="w-full px-4 py-3 rounded-lg border border-border hover:bg-secondary transition text-left"
        >
          <div class="text-sm font-medium text-foreground">{i18n.t('Enter recovery phrase')}</div>
          <div class="text-xs text-muted-foreground">{i18n.t('History on this device starts empty')}</div>
        </button>

        <button
          onclick={() => onPair('wifi')}
          class="w-full px-4 py-3 rounded-lg border border-border hover:bg-secondary transition text-left"
        >
          <div class="text-sm font-medium text-foreground">{i18n.t('Sync from another device')}</div>
          <div class="text-xs text-muted-foreground">{i18n.t('Both devices on the same local network')}</div>
        </button>

        <button
          disabled
          class="w-full px-4 py-3 rounded-lg border border-border opacity-50 cursor-not-allowed text-left"
        >
          <div class="text-sm font-medium text-foreground">{i18n.t('Log in with Keycard')}</div>
          <div class="text-xs text-muted-foreground">{i18n.t('coming soon')}</div>
        </button>
      </div>

      <button
        onclick={() => (phase = { kind: 'login' })}
        class="text-sm text-muted-foreground hover:underline"
      >
        ← {i18n.t('Back')}
      </button>

    {:else if phase.kind === 'pairing-method'}
      <!--
        No longer reached: the "Wi-Fi or USB" picker is gone. The transfer runs on
        whatever local network both devices share, and a cable only matters when a modem
        runs over it — offering a choice implied the cable did something by itself. The
        branch stays so the phase union remains exhaustive.
      -->
      <p class="text-sm text-muted-foreground">{i18n.t('Sync from another device')}</p>

    {:else if phase.kind === 'restore-phrase'}
      <!--
        Rendered by the page, not here: the recovery form is `RecoveryScreen`, which is
        already tested against the real backend and knows the locked-local-profile case.
        This branch only exists so the union stays exhaustive.
      -->
      <p class="text-sm text-muted-foreground">{i18n.t('Enter recovery phrase')}</p>

    {:else if phase.kind === 'pairing-enter'}
      <!--
        Rendered by the page, not here: the screen needs the connection string and the
        transfer state, which the page owns. This branch only exists so the union stays
        exhaustive.
      -->
      <p class="text-sm text-muted-foreground">{i18n.t('Sync with another device')}</p>
    {/if}

    {#if error}
      <p class="text-destructive text-sm text-center max-w-md" aria-live="polite">{error}</p>
    {/if}
  </div>
{/if}
