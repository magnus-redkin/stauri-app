/**
 * Formats a minimal-unit amount such as wei into a display string.
 *
 * @param weiStr - The amount as a decimal string in the smallest unit, e.g.
 * `"1000000000000000000"`.
 * @param decimals - Decimal places of the token; defaults to 18 for ETH.
 * @param maxFractionDigits - Maximum fractional digits in the output, 6 by
 * default. The rest is truncated, not rounded.
 * @returns The formatted amount, e.g. `"1"` or `"1.5"`.
 * @remarks Invalid `decimals` falls back to 18. A value that `BigInt` cannot
 * read throws instead of being swallowed, so the caller decides what to show.
 * @throws An `Error` when `weiStr` is not an integer string.
 */
export function formatBalance(
  weiStr: string | undefined | null,
  decimals: number = 18,
  maxFractionDigits: number = 6
): string {
  if (!weiStr || weiStr === '0') return '0';

  // Fall back to 18 (ETH) when decimals is not a valid count.
  const safeDecimals = Number.isInteger(decimals) && decimals >= 0 ? decimals : 18;

  let wei: bigint;
  try {
    wei = BigInt(weiStr);
  } catch (e) {
    // Not swallowed — the caller decides what to do with a broken value.
    throw new Error(`Invalid balance value: "${weiStr}"`, { cause: e });
  }

  const divisor = 10n ** BigInt(safeDecimals);
  const integerPart = wei / divisor;
  const fractionalPart = wei % divisor;

  // A zero fractional part means an integer value.
  if (fractionalPart === 0n) {
    return integerPart.toString();
  }

  // Pad the fractional part with leading zeros.
  let fracStr = fractionalPart.toString().padStart(safeDecimals, '0');

  // Truncate to the display limit.
  if (fracStr.length > maxFractionDigits) {
    fracStr = fracStr.substring(0, maxFractionDigits);
  }

  // Drop trailing zeros.
  fracStr = fracStr.replace(/0+$/, '');

  if (!fracStr) {
    return integerPart.toString();
  }

  return `${integerPart}.${fracStr}`;
}
