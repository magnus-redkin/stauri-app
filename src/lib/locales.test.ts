/**
 * Integrity of the translation catalogs.
 *
 * @remarks
 * The key of a message *is* its English text, so nothing at build time ties a call site
 * to a catalog entry: a typo in an `i18n.t('…')` literal, or a string added to `en` and
 * forgotten in the other locales, fails silently — the screen renders the key or English
 * inside a Russian UI. These tests make that a build failure instead.
 *
 * Dynamic calls (`i18n.t(someVariable)`) cannot be checked statically; the catalogs they
 * index must stay complete by the same rules, and the key-set comparison still holds
 * them together.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, 'locales');
const srcDir = join(here, '..');

/** Locale files shipped with the app. `en` is the source of truth for keys. */
const LOCALES = ['en', 'ru', 'es', 'zh'] as const;

function catalog(locale: string): Record<string, string> {
  return JSON.parse(readFileSync(join(localesDir, `${locale}.json`), 'utf8')) as Record<string, string>;
}

/** Every file under `src` that can hold a `i18n.t('…')` call. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      // The catalogs themselves and node_modules are not call sites.
      if (entry === 'node_modules' || entry === 'locales') continue;
      sourceFiles(path, out);
    } else if (/\.(svelte|ts)$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Literal message keys used by the code, as `{ key, file }` pairs. */
function usedKeys(): Array<{ key: string; file: string }> {
  const found: Array<{ key: string; file: string }> = [];
  // Single or double quotes, one line: every call site in this project passes a literal.
  const pattern = /i18n\.t\(\s*(['"])((?:\\.|(?!\1).)*)\1\s*\)/g;
  for (const file of sourceFiles(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(pattern)) {
      found.push({ key: match[2], file: file.slice(srcDir.length + 1) });
    }
  }
  return found;
}

describe('translation catalogs', () => {
  const en = catalog('en');

  it('каждый ключ есть во всех локалях', () => {
    // A missing key renders the English text inside the translated interface. Reporting
    // the whole list at once makes the fix one pass instead of one test run per string.
    for (const locale of LOCALES) {
      const keys = new Set(Object.keys(catalog(locale)));
      const missing = Object.keys(en).filter((key) => !keys.has(key));
      expect(missing, `${locale}: нет ключей`).toEqual([]);
    }
  });

  it('в локалях нет ключей, которых нет в en', () => {
    // A stale key is a translation nobody sees any more, and it is how the catalogs drift
    // apart: a typo'd key in `en` left the correct one behind in the other locales.
    for (const locale of LOCALES) {
      const keys = Object.keys(catalog(locale));
      const extra = keys.filter((key) => !(key in en));
      expect(extra, `${locale}: лишние ключи`).toEqual([]);
    }
  });

  it('нет пустых переводов', () => {
    for (const locale of LOCALES) {
      const empty = Object.entries(catalog(locale))
        .filter(([, value]) => typeof value !== 'string' || value.trim() === '')
        .map(([key]) => key);
      expect(empty, `${locale}: пустые значения`).toEqual([]);
    }
  });

  it('каждый литерал i18n.t() есть в каталогах', () => {
    // The failure names the file, because the same English sentence can appear in one
    // place with a typo and in another correctly — "Сonnected" with a Cyrillic `С` was
    // exactly that, and searching the rendered UI would never show it.
    const missing = new Map<string, string[]>();
    for (const { key, file } of usedKeys()) {
      for (const locale of LOCALES) {
        if (!(key in catalog(locale))) {
          const files = missing.get(key) ?? [];
          files.push(`${locale}:${file}`);
          missing.set(key, files);
        }
      }
    }
    expect([...missing.entries()]).toEqual([]);
  });
});
