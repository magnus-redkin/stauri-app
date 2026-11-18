// Tauri doesn't have a Node.js server to do proper SSR
// so we use adapter-static with a fallback to index.html to put the site in SPA mode
// See: https://svelte.dev/docs/kit/single-page-apps
// See: https://v2.tauri.app/start/frontend/sveltekit/ for more info

import { i18n, loadTranslations } from '$lib/i18n';
import type { LayoutLoad } from './$types';

/** Languages the interface ships with; anything else in storage is ignored. */
const SUPPORTED_LOCALES = ['en', 'ru', 'zh', 'es'];
/** Same key `SettingsMain` writes when the language is changed. */
const LOCALE_KEY = 'stauri-locale';

/**
 * The language saved by the user, or English.
 *
 * `ssr` is off, so `localStorage` exists here. A storage error or an unknown
 * value falls back to English rather than blocking start-up.
 */
function savedLocale(): string {
  try {
    const saved = localStorage.getItem(LOCALE_KEY);
    if (saved && SUPPORTED_LOCALES.includes(saved)) return saved;
  } catch {
    // Storage unavailable: use the default.
  }
  return 'en';
}

export const load: LayoutLoad = async ({ url }) => {
  const locale = savedLocale();
  // Set the locale first, then load its dictionary: `t()` reads the dictionary of
  // the active locale, so the reverse order leaves the UI in English.
  i18n.locale = locale;
  await loadTranslations(locale, url.pathname);
  return {};
};

export const ssr = false;
export const prerender = false;
