import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generatePassword, GENERATED_PASSWORD_LENGTH } from './credentials';
import { isPasswordValid } from '$lib/utils/password';
import { invoke } from '@tauri-apps/api/core';

// Hoisted to the top level: `vi.mock` is lifted above the imports anyway, and the
// previous attempt to mock inside `beforeEach` was rejected by vitest.
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

const invokeMock = vi.mocked(invoke);

describe('generatePassword', () => {
  it('удовлетворяет тем же правилам, что требуются при входе', () => {
    // The password is never shown to the user, so a value that `checkPassword` would
    // refuse could not be corrected by hand: the profile would be unopenable.
    for (let i = 0; i < 200; i++) {
      expect(isPasswordValid(generatePassword())).toBe(true);
    }
  });

  it('всегда содержит все четыре класса символов', () => {
    // Checked per character rather than through `isPasswordValid`, to name the class
    // that went missing when this fails.
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toMatch(/[A-Z]/);
      expect(p).toMatch(/[a-z]/);
      expect(p).toMatch(/[0-9]/);
      expect(p).toMatch(/[^A-Za-z0-9\s]/);
    }
  });

  it('имеет заявленную длину', () => {
    expect(generatePassword()).toHaveLength(GENERATED_PASSWORD_LENGTH);
  });

  it('не повторяется', () => {
    // A constant would pass every rule above; two draws being equal means the source
    // is not random at all.
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) seen.add(generatePassword());
    expect(seen.size).toBe(50);
  });

  it('не содержит визуально неоднозначных символов', () => {
    // `I`, `l`, `O`, `0`, `1` are left out of the alphabet: the password is read aloud
    // or copied off a screen when something goes wrong with a profile.
    for (let i = 0; i < 100; i++) {
      expect(generatePassword()).not.toMatch(/[IlO01]/);
    }
  });

  it('берёт случайность из crypto, а не из Math.random', () => {
    // Math.random is not a cryptographic source: a predictable password would make the
    // database bruteforceable regardless of its length.
    const spy = vi.spyOn(Math, 'random');
    generatePassword();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('гарантированные классы не всегда стоят первыми', () => {
    // One uppercase, one lowercase, one digit and one symbol are placed first and the
    // array is then shuffled. Without the shuffle every password would start with the
    // same character pattern, which is visible in the trace.
    const firstClasses = new Set(
      Array.from({ length: 60 }, () => {
        const c = generatePassword()[0];
        return /[A-Z]/.test(c) ? 'u' : /[a-z]/.test(c) ? 'l' : /[0-9]/.test(c) ? 'd' : 's';
      })
    );
    expect(firstClasses.size).toBeGreaterThan(1);
  });
});

describe('credential commands', () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it('сообщает об отсутствии хранилища, а не падает, когда команда недоступна', async () => {
    // A build without the command (or a webview outside Tauri) must fall back to the
    // password prompt rather than break the screen with an exception.
    invokeMock.mockRejectedValue(new Error('command not found'));
    const { credentialsAvailable } = await import('./credentials');
    await expect(credentialsAvailable()).resolves.toBe(false);
  });

  it('передаёт сеть, профиль и PIN при открытии', async () => {
    invokeMock.mockResolvedValue('the-password');
    const { openPin } = await import('./credentials');

    await expect(openPin('testnet', '0xabc', '1379')).resolves.toBe('the-password');
    expect(invokeMock).toHaveBeenCalledWith('credential_open_pin', {
      network: 'testnet',
      keyUid: '0xabc',
      pin: '1379',
    });
  });

  it('не проглатывает неверный PIN', async () => {
    // A wrong PIN is not "no PIN set": a silent fallback would send the user to a
    // password prompt for a password the application alone knew.
    invokeMock.mockRejectedValue(new Error('wrong PIN (9 attempt(s) left)'));
    const { openPin } = await import('./credentials');

    await expect(openPin('mainnet', '0xabc', '0000')).rejects.toThrow('wrong PIN');
  });

  it('передаёт PIN и пароль при сохранении', async () => {
    invokeMock.mockResolvedValue(undefined);
    const { savePin } = await import('./credentials');

    await savePin('mainnet', '0xabc', '1379', 'generated');
    expect(invokeMock).toHaveBeenCalledWith('credential_save_pin', {
      network: 'mainnet',
      keyUid: '0xabc',
      pin: '1379',
      password: 'generated',
    });
  });

  it('считает профиль без PIN, когда команда недоступна', async () => {
    // The flow then keeps the password prompt, which is the old flow and still works.
    invokeMock.mockRejectedValue(new Error('command not found'));
    const { hasPin } = await import('./credentials');

    await expect(hasPin('mainnet', '0xabc')).resolves.toBe(false);
  });
});
