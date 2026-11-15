import { describe, it, expect } from 'vitest';
import {
  checkNewPassword,
  checkPassword,
  isPasswordValid,
  passwordRules,
  PASSWORD_MIN_LENGTH,
} from './password';

describe('passwordRules', () => {
  it('хороший пароль проходит все правила', () => {
    expect(passwordRules('Stauri#2026')).toEqual([
      { id: 'length', ok: true },
      { id: 'lower', ok: true },
      { id: 'upper', ok: true },
      { id: 'digit', ok: true },
      { id: 'symbol', ok: true },
    ]);
    expect(isPasswordValid('Stauri#2026')).toBe(true);
  });

  it('короткий пароль не проходит правило длины', () => {
    const rules = passwordRules('Ab1#xyz');
    expect(rules.find((r) => r.id === 'length')?.ok).toBe(false);
    expect(isPasswordValid('Ab1#xyz')).toBe(false);
  });

  it('ровно 8 символов — уже достаточно', () => {
    expect(isPasswordValid('Abcde1#x')).toBe(true);
  });

  it('кириллица не считается латинскими буквами', () => {
    // The Cyrillic password below is 9 characters with a digit and a symbol, but no
    // Latin letters, so neither letter rule may pass.
    const rules = passwordRules('Пароль123#');
    expect(rules.find((r) => r.id === 'lower')?.ok).toBe(false);
    expect(rules.find((r) => r.id === 'upper')?.ok).toBe(false);
    expect(isPasswordValid('Пароль123#')).toBe(false);
  });

  it('пробел не считается символом: он не должен закрывать правило', () => {
    const rules = passwordRules('Password1 ');
    expect(rules.find((r) => r.id === 'symbol')?.ok).toBe(false);
    expect(isPasswordValid('Password1 ')).toBe(false);
  });

  it('каждое правило проверяется отдельно', () => {
    const onlyDigits = passwordRules('12345678');
    expect(onlyDigits.filter((r) => r.ok).map((r) => r.id)).toEqual(['length', 'digit']);

    const noDigit = passwordRules('Password#');
    expect(noDigit.find((r) => r.id === 'digit')?.ok).toBe(false);

    const noUpper = passwordRules('password#1');
    expect(noUpper.find((r) => r.id === 'upper')?.ok).toBe(false);
  });

  it('эмодзи считается одним символом длины, но не буквой', () => {
    const rules = passwordRules('🔒🔒🔒🔒🔒🔒🔒🔒');
    expect(rules.find((r) => r.id === 'length')?.ok).toBe(true);
    expect(rules.find((r) => r.id === 'lower')?.ok).toBe(false);
  });
});

describe('checkNewPassword', () => {
  it('возвращает ошибку на пустой пароль', () => {
    expect(checkNewPassword('', '').error).toBe('Enter a password');
  });

  it('сообщает о несоответствии подтверждения', () => {
    expect(checkNewPassword('Stauri#2026', 'Stauri#2027').error).toBe('Passwords do not match');
  });

  it('принимает совпадающий сильный пароль', () => {
    expect(checkNewPassword('Stauri#2026', 'Stauri#2026').error).toBeNull();
  });

  it('слабый пароль отклоняется до сверки подтверждения', () => {
    const { error } = checkNewPassword('weak', 'weak');
    expect(error).toContain(String(PASSWORD_MIN_LENGTH));
  });

  it('пустое подтверждение при сильном пароле — тоже ошибка', () => {
    expect(checkNewPassword('Stauri#2026', '').error).toBe('Passwords do not match');
  });
});

describe('checkPassword (вход)', () => {
  it('принимает сильный пароль', () => {
    expect(checkPassword('Stauri#2026').error).toBeNull();
  });

  it('отклоняет пустой пароль', () => {
    expect(checkPassword('').error).toBe('Enter a password');
  });

  it('отклоняет слабый пароль из старого профиля', () => {
    // Profiles created before these rules opened with passwords like these.
    expect(checkPassword('qwer').error).toContain('at least 8 characters');
    expect(checkPassword('mypassword').error).toContain('at least 8 characters');
  });

  it('не требует подтверждения', () => {
    // Creation and login apply the same rules to the same password.
    expect(checkPassword('Stauri#2026')).toEqual(checkNewPassword('Stauri#2026', 'Stauri#2026'));
  });
});
