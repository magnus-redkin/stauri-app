/**
 * Entry flow state machine: what the mobile login screen shows and why.
 *
 * Split from the components on purpose. Everything that decides *which screen comes
 * next* — whether a profile exists, whether it has a PIN, whether the attempt limit is
 * reached — lives here, in plain TypeScript with no platform calls. The screens only
 * render `phase` and call the transitions.
 *
 * @remarks
 * The rules encoded here are the ones that produced bugs when they were spread across
 * components:
 *
 * * a profile belongs to a network, so the profile list follows the selected network and
 *   is not global;
 * * the PIN screen appears only when there is something to unlock — on a clean phone
 *   asking for a PIN before the user has ever created a profile makes no sense;
 * * a profile without a PIN is not an error: it is a profile created before this scheme,
 *   and it keeps the password prompt.
 */

/** Network a profile belongs to. Profiles of the two never share storage. */
export type Network = 'mainnet' | 'testnet';

/** A profile known on this device. */
export interface ProfileSummary {
  /** Key uid, `0x…`; also the storage slot name. */
  keyUid: string;
  /** Display name, when status-go reported one. */
  name?: string;
}

/** What the user is looking at. */
export type EntryPhase =
  /**
   * The full entry screen: the network, the profiles on it, and what to do next.
   *
   * @remarks
   * Every start lands here, even with one profile. The screen shows the picker and the
   * two ways in; opening a profile is one tap, and choosing another one is possible
   * without backing out of a PIN pad first.
   */
  | { kind: 'login' }
  /** PIN pad to open an existing profile. */
  | { kind: 'enter-pin'; profile: ProfileSummary }
  /**
   * Password prompt for a profile that has no PIN.
   *
   * @remarks
   * Profiles created before this scheme, and every profile on a device that cannot keep
   * an envelope. They keep the password path instead of being locked out.
   */
  | { kind: 'password'; profile: ProfileSummary }
  /**
   * PIN pad to choose a PIN for a new profile.
   *
   * @remarks
   * `password` is present when this device holds the password — a freshly created
   * profile, or one from before this scheme being converted. A profile that arrived over
   * pairing has no password here: it stayed on the Rust side, and the pad calls
   * `savePinFromPending` instead.
   */
  | { kind: 'set-pin'; profile: ProfileSummary; password?: string }
  /**
   * PIN for a profile that will be created when this pad is confirmed.
   *
   * @remarks
   * The account is created *after* the PIN is chosen. Creating it first left a profile
   * behind whose password nobody knew if the user quit before finishing the pad — an
   * account that could never be opened and that looked like a real one on the next start.
   */
  | { kind: 'create-pin' }
  /** Seed phrase of a new profile is being shown. */
  | { kind: 'create-seed'; password: string }
  /**
   * The display name of the freshly created profile.
   *
   * @remarks
   * The account already exists and is open: the name is a setting, and skipping the step
   * keeps the default the backend created it with.
   */
  | { kind: 'create-name' }
  /** Choosing how to restore an existing profile. */
  | { kind: 'restore-method' }
  /** Typing the twelve words. */
  | { kind: 'restore-phrase' }
  /** Choosing the transport for pairing with another device. */
  | { kind: 'pairing-method' }
  /**
   * This device shows a connection string for the other one to read.
   *
   * @remarks
   * The role is decided by the flow, not by the user: the device that has the profile
   * sends, the empty one receives.
   */
  | { kind: 'pairing-show'; role: 'sender' | 'receiver'; connectionString: string }
  /** The user pastes the string shown on the other device, and the transfer runs. */
  | { kind: 'pairing-enter'; role: 'sender' | 'receiver' }
  /** The profile arrived and needs a PIN to be usable here. */
  | { kind: 'pairing-set-pin'; profile: ProfileSummary; password: string };

/** Input the machine needs from outside; supplied by the screens. */
export interface EntryContext {
  /** Selected network; profiles of the other one are not shown. */
  network: Network;
  /** Profiles known for {@link network}. */
  profiles: ProfileSummary[];
  /** Whether this build can keep a PIN at all. */
  canStorePin: boolean;
}

/** What asking the store about a profile answered. */
export type PinState =
  /** A PIN is set and the attempt limit is not reached; the flow asks for it. */
  | 'ready'
  /** No PIN: a profile from before this scheme, or one that arrived without one. */
  | 'missing'
  /**
   * Too many wrong PINs were entered.
   *
   * The envelope is refused until the profile is restored from its seed phrase. Showing
   * a keypad would be a screen that cannot succeed.
   */
  | 'locked-out'
  /**
   * An envelope exists but cannot be read.
   *
   * @remarks
   * A truncated file, a version this build does not know, an envelope from another
   * platform, or a paired profile whose password was never wrapped under a PIN. The
   * password behind it was generated by the application, so neither the keypad nor the
   * password prompt can open the profile: the phrase is the only way, and saying so is
   * better than offering a door that does not open.
   */
  | 'damaged';

/**
 * What to do when the application starts or the network changes.
 *
 * @param _ctx - Current context.
 * @returns The phase to show.
 * @remarks
 * Always `login`. The screen it renders already lists the profiles of the selected
 * network, so there is no separate list to route to — and a device with one profile no
 * longer jumps straight to a PIN pad that offers no way back to the network choice.
 */
export function initialPhase(_ctx: EntryContext): EntryPhase {
  return { kind: 'login' };
}

/**
 * Turns a PIN lookup into the next phase.
 *
 * @param profile - Profile the user tapped.
 * @param lookup - What the store answered.
 * @param canStorePin - Whether this build keeps PINs at all.
 * @returns The phase to show.
 * @remarks
 * `locked-out` and `damaged` map to `restore-phrase` rather than to the keypad: the
 * envelope will not open any more, and the phrase is the only thing that brings the
 * profile back.
 */
export function phaseAfterPinLookup(
  profile: ProfileSummary,
  lookup: PinState,
  canStorePin: boolean
): EntryPhase {
  // No envelope on this device: the profile can only be opened by its password. Saying so
  // on the profile's own screen is better than dropping the user back to the start, where
  // they would have to pick the profile a second time.
  if (!canStorePin) return { kind: 'password', profile };
  switch (lookup) {
    case 'ready':
      return { kind: 'enter-pin', profile };
    case 'missing':
      // Created before this scheme: the password prompt still works.
      return { kind: 'password', profile };
    case 'locked-out':
    case 'damaged':
      return { kind: 'restore-phrase' };
  }
}

/**
 * Validates a PIN being typed to open, lock or send a profile.
 *
 * @param pin - Text entered.
 * @param maxLength - The longest PIN any creation could have stored on this platform.
 * @returns `null` when the input can be a stored PIN, otherwise a locale key.
 * @remarks
 * Deliberately loose. The creation rule is strict, but a stored PIN has to stay
 * typeable: rejecting it here would leave a profile nobody can open, behind a rule its
 * owner has no way to see. The backend draws the same line.
 */
export function pinOpenProblem(pin: string, maxLength: number): string | null {
  const length = [...pin].length;
  if (length === 0) return 'Enter your PIN';
  if (length > maxLength) return 'The PIN is too long';
  return null;
}

/** Whether a digit PIN is a pattern a thumb draws without thinking. */
function isTrivialPin(pin: string): boolean {
  if (!/^\d{3,}$/.test(pin)) return false;
  const digits = [...pin].map((c) => c.charCodeAt(0));
  if (digits.every((d) => d === digits[0])) return true;
  const ascending = digits.every((d, i) => i === 0 || d === digits[i - 1] + 1);
  const descending = digits.every((d, i) => i === 0 || d === digits[i - 1] - 1);
  return ascending || descending;
}

/**
 * Validates a PIN being **created**, against the backend's policy.
 *
 * @param pin - Text entered.
 * @param rules - What the backend enforces on this platform.
 * @returns `null` when the PIN will be accepted, otherwise a locale key.
 * @remarks
 * This is feedback, not the gate: `save_pin` in Rust applies the same rules and is the
 * only thing that decides what gets stored. Kept in step with `creation_problem` by
 * shape — digits on the phone, four character classes on the desktop.
 */
export function pinCreationProblem(
  pin: string,
  rules: { creation_min: number; max_length: number; digits_only: boolean; require_classes: boolean }
): string | null {
  const length = [...pin].length;
  if (length < rules.creation_min) return 'The PIN is too short';
  if (length > rules.max_length) return 'The PIN is too long';
  if (rules.digits_only && !/^\d+$/.test(pin)) return 'The PIN must be digits';
  if (isTrivialPin(pin)) return 'The PIN is too easy to guess';
  if (rules.require_classes) {
    const lower = /[a-z]/.test(pin);
    const upper = /[A-Z]/.test(pin);
    const digit = /\d/.test(pin);
    const symbol = /[^A-Za-z0-9]/.test(pin);
    if (!(lower && upper && digit && symbol)) {
      return 'The PIN must mix lowercase, uppercase, digits and symbols';
    }
  }
  return null;
}

/**
 * Validates a network value coming from the interface.
 *
 * @param value - Value from the network picker.
 * @returns The network, or `null` for an unknown one.
 * @remarks
 * The value reaches the Rust side as part of a filesystem path, so an unknown one is
 * refused here rather than passed on.
 */
export function parseNetwork(value: string): Network | null {
  return value === 'mainnet' || value === 'testnet' ? value : null;
}

/**
 * Transport options for pairing with another device.
 *
 * @returns The options in display order, with the unsupported ones marked.
 * @remarks
 * `wifi` is the transport status-go actually implements: local pairing connects over TCP
 * on the local network (`multiaddr` + mDNS in the library), so no cable is involved.
 * `usb` is listed for development — it needs `adb reverse` on the machine and USB
 * debugging enabled, which an ordinary user will not do, so the screen says so. `qr` has
 * no implementation yet and is disabled rather than hidden: it is the transport the
 * camera permission exists for.
 */
export function pairingMethods(): Array<{ id: 'wifi' | 'usb' | 'qr'; enabled: boolean }> {
  return [
    { id: 'wifi', enabled: true },
    { id: 'usb', enabled: true },
    { id: 'qr', enabled: false },
  ];
}
