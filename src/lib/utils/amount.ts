/**
 * Converts amounts between what a person enters and what the network accepts.
 *
 * Token amounts are integers in the smallest unit: 18 decimal places make one
 * ether. A `Number` holds 53 bits exactly, about 15–16 significant digits —
 * `0.1` is not representable at all and `1e18` is already inexact — so
 * `parseFloat(amount) * 10 ** decimals` can send an amount other than the one
 * that was entered. All arithmetic here stays in `bigint`; `Number` is used
 * only where the value is known to be small (string length, digit count).
 *
 * A failed parse throws instead of returning a best-effort value: this sits on
 * the path that sends money, and a silent rounding would show one amount on
 * screen while another leaves the wallet.
 */

/**
 * Reason a parse was rejected.
 *
 * A code rather than display text: the UI translates it into the user's
 * language, while `message` stays English for the logs.
 */
export type AmountErrorCode =
  | 'amount-empty'
  | 'amount-invalid'
  | 'amount-too-many-decimals'
  | 'amount-bad-decimals';

/** Thrown when an amount cannot be parsed; `code` selects the localized message. */
export class AmountError extends Error {
  readonly code: AmountErrorCode;

  constructor(code: AmountErrorCode, message: string) {
    super(message);
    this.name = 'AmountError';
    this.code = code;
  }
}

/**
 * Parses an entered amount into the token's smallest unit.
 *
 * Accepts what a person actually types: `0.5`, `12`, `0,5` (comma as the
 * decimal separator) and the calculator forms `.5` and `5.` (a trailing
 * separator means no fractional part).
 *
 * Rejects an empty string, letters, two separators, exponent notation and a
 * minus sign. More fractional digits than the token has is an input error too,
 * not a rounding case: `0.1234567` at `decimals = 6` would otherwise lose part
 * of the amount without telling anyone.
 *
 * @param raw - The raw string from the input field.
 * @param decimals - Decimal places of the token, from 0 to 77.
 * @returns The amount in the smallest unit, e.g. wei for ETH.
 * @throws An `AmountError` when the input is empty, malformed, carries too many
 * decimal places, or `decimals` is not a valid count.
 */
export function parseAmount(raw: string, decimals: number): bigint {
  const value = String(raw ?? '').trim().replace(',', '.');

  if (!value) throw new AmountError('amount-empty', 'Enter an amount');
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    throw new AmountError('amount-bad-decimals', `Invalid token decimals: ${decimals}`);
  }

  // Digits and at most one separator; anything else is an input error, so
  // `1e18`, `1.2.3`, `-1` and `1 000` do not match.
  const match = value.match(/^(\d*)(?:\.(\d*))?$/);
  if (!match) throw new AmountError('amount-invalid', 'Enter a valid number');

  const [, wholeRaw = '', fracRaw = ''] = match;
  if (!wholeRaw && !fracRaw) throw new AmountError('amount-empty', 'Enter an amount');

  if (fracRaw.length > decimals) {
    throw new AmountError(
      'amount-too-many-decimals',
      `Too many decimals: this token has ${decimals}`
    );
  }

  // Leading zeros carry no value — `007` and `7` are the same number — and a
  // long digit string only slows `BigInt` down.
  const whole = wholeRaw.replace(/^0+/, '') || '0';
  const frac = fracRaw.padEnd(decimals, '0');

  return BigInt(whole + frac);
}

/**
 * Renders a smallest-unit amount back into a decimal string.
 *
 * No leading zeros and no trailing zeros: `1000000000000000000` at
 * `decimals = 18` gives `"1"`, and `1500000` at `decimals = 6` gives `"1.5"`.
 *
 * @param units - The amount in the smallest unit.
 * @param decimals - Decimal places of the token, 0 or more.
 * @returns An exact decimal string, unrounded.
 * @remarks This is the exact value, not a screen format; `formatBalance` in
 * `utils/format.ts` rounds for display.
 * @throws An `AmountError` when `decimals` is not a non-negative integer.
 */
export function formatUnits(units: bigint, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new AmountError('amount-bad-decimals', `Invalid token decimals: ${decimals}`);
  }

  const negative = units < 0n;
  const abs = negative ? -units : units;

  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;

  const fracStr = frac === 0n
    ? ''
    : '.' + frac.toString().padStart(decimals, '0').replace(/0+$/, '');

  return (negative ? '-' : '') + whole.toString() + fracStr;
}

/**
 * Compares an amount with a balance held in the same unit.
 *
 * Checked on the send confirmation step so an overdraft is refused before the
 * network is called, with a readable message rather than an RPC
 * `insufficient funds` reply.
 *
 * @param amount - The amount to send, in the smallest unit.
 * @param balance - The available balance, in the same unit.
 * @returns `true` when the amount is strictly greater than the balance.
 */
export function exceedsBalance(amount: bigint, balance: bigint): boolean {
  return amount > balance;
}
