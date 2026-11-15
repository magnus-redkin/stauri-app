import i18n from 'sveltekit-i18n';
import type { Config } from 'sveltekit-i18n';
import { locales } from './locales';

/**
 * Flattens a locale dictionary into the key/value table sveltekit-i18n loads.
 *
 * In `en` the key already equals the value; every other locale falls back to the key when
 * its translation is empty, so an untranslated string still renders as readable text.
 *
 * @param lang - Locale whose dictionary is flattened.
 * @returns Every key of that dictionary mapped to its text or to the key itself.
 */
function transformLocales(lang: keyof typeof locales): Record<string, string> {
  const source = locales[lang] as Record<string, string>;
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(source)) {
    result[key] = value || key;
  }
  return result;
}

const config: Config = {
  fallbackLocale: 'en',
  loaders: [
    { locale: 'en', namespace: '', loader: async () => transformLocales('en') },
    { locale: 'ru', namespace: '', loader: async () => transformLocales('ru') },
    { locale: 'zh', namespace: '', loader: async () => transformLocales('zh') },
    { locale: 'es', namespace: '', loader: async () => transformLocales('es') },
  ],
  initLocale: 'en',
};

const i18nInstance = new i18n(config);

export const {
  t,
  locale,
  locales: localesStore,
  loading,
  loadTranslations,
} = i18nInstance;

export { i18nInstance as i18n };
