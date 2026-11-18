import { describe, it, expect, afterEach } from 'vitest';
import { i18n } from '$lib/i18n';
import { load } from '../routes/+layout';

// `$lib/i18n` is mocked globally in test-setup.ts (t() returns the key), so these
// tests check the locale that load() selects, not translated text. Text is
// checked in the running app.
describe('language saved by the user is active at start-up', () => {
  afterEach(() => localStorage.removeItem('stauri-locale'));

  it('uses the saved locale', async () => {
    localStorage.setItem('stauri-locale', 'ru');
    await load({ url: new URL('http://localhost/') } as any);
    expect(i18n.locale).toBe('ru');
  });

  it('falls back to English for an unknown saved value', async () => {
    localStorage.setItem('stauri-locale', 'xx');
    await load({ url: new URL('http://localhost/') } as any);
    expect(i18n.locale).toBe('en');
  });

  it('falls back to English when nothing is saved', async () => {
    await load({ url: new URL('http://localhost/') } as any);
    expect(i18n.locale).toBe('en');
  });
});
