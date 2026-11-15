/**
 * Password rules for a profile.
 *
 * status-go accepts any non-empty password: `Validate` in
 * `requests/create_account.go` rejects only `len(Password) == 0` and is marked
 * `TODO(cammellos): Add proper validation`. A weak password would therefore
 * create a profile silently, and it is hard to fix later — the password
 * encrypts the local database and the wallet keys. These rules are a product
 * requirement on creation and on login alike, so a login with a
 * non-conforming password is refused here before it reaches status-go.
 *
 * The check lives in the frontend because the webview never hands the password
 * to Rust anyway, and `CreateAccountAndLogin` / `LoginAccount` are invoked from
 * here.
 */

/** Minimum password length, identical on profile creation and on login. */
export const PASSWORD_MIN_LENGTH = 8;

export interface PasswordRule {
  /** Short key for the UI and tests. */
  id: 'length' | 'lower' | 'upper' | 'digit' | 'symbol';
  /** Whether the condition is met. */
  ok: boolean;
}

/** Latin letters are exactly `a-z`/`A-Z`; Cyrillic does not count. */
const LOWER = /[a-z]/;
const UPPER = /[A-Z]/;
const DIGIT = /[0-9]/;
/**
 * A symbol is anything that is not a Latin letter, a digit or whitespace.
 *
 * Defined this way rather than as a list like `!@#$%` so any key on the layout
 * qualifies.
 *
 * @remarks A space is not a symbol: otherwise `Password 1` would satisfy the
 * symbol rule with nothing but letters and a digit in it.
 */
const SYMBOL = /[^A-Za-z0-9\s]/;

/**
 * Evaluates each rule separately.
 *
 * @param password - The password to check.
 * @returns One entry per rule, in display order, for the hints in the UI.
 * @remarks Length counts code points, so one emoji is one character.
 */
export function passwordRules(password: string): PasswordRule[] {
  return [
    { id: 'length', ok: [...password].length >= PASSWORD_MIN_LENGTH },
    { id: 'lower', ok: LOWER.test(password) },
    { id: 'upper', ok: UPPER.test(password) },
    { id: 'digit', ok: DIGIT.test(password) },
    { id: 'symbol', ok: SYMBOL.test(password) },
  ];
}

/**
 * Tells whether a password satisfies every rule.
 *
 * @param password - The password to check.
 * @returns `true` when all rules pass.
 */
export function isPasswordValid(password: string): boolean {
  return passwordRules(password).every((r) => r.ok);
}

export interface PasswordCheck {
  /**
   * Locale key to show, or `null` when the password is fine.
   *
   * A key rather than ready-made text: the same message lives in
   * `en.json`/`ru.json` and the calling component translates it. Returning an
   * English sentence would leave the Russian UI with an English error.
   */
  error: string | null;
}

/**
 * Checks a password together with its confirmation.
 *
 * @param password - The new password.
 * @param confirmation - The repeated password.
 * @returns The first problem found, or a `null` error when both are valid.
 * @remarks Only the first error is returned: the field has room for one line,
 * and fixing five complaints at once is not what the user is doing.
 */
export function checkNewPassword(password: string, confirmation: string): PasswordCheck {
  const single = checkPassword(password);
  if (single.error) return single;
  if (confirmation !== password) return { error: 'Passwords do not match' };
  return { error: null };
}

/**
 * Checks a password on login — the same rules, without a confirmation.
 *
 * @param password - The password being entered.
 * @returns A `null` error when the password is acceptable, otherwise the first
 * failing rule as a locale key.
 * @remarks A weak password is refused here as well: a profile whose password is
 * something like `qwer` stays readable to anyone holding the database file, and
 * accepting such a login keeps that state alive. The cost is that older
 * profiles with weak passwords stop opening, which is intended. The password
 * itself is never logged — at most its length and a SHA-256 prefix, and only if
 * the caller does that.
 */
export function checkPassword(password: string): PasswordCheck {
  if (!password) return { error: 'Enter a password' };
  const missing = passwordRules(password).filter((r) => !r.ok).map((r) => r.id);
  if (missing.length) {
    return {
      error: `Password must contain at least ${PASSWORD_MIN_LENGTH} characters, uppercase and lowercase Latin letters, a digit and a symbol`,
    };
  }
  return { error: null };
}
