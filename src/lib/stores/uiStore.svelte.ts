/**
 * Display preferences: font size and theme.
 *
 * Values are read from `localStorage` and applied at startup by
 * `loadUiPreferences`; the settings screen and the keyboard shortcuts only
 * change them through this store.
 *
 * @remarks
 * Font size is applied to the root `<html>` element rather than to a CSS class.
 * Layout sizes are in `rem`, so scaling the root `font-size` scales text,
 * spacing and controls together, like browser zoom. Changing text sizes alone
 * would push labels out of buttons.
 */

const FONT_KEY = 'stauri-font-size';
const THEME_KEY = 'stauri-theme';

/**
 * Lower and upper font size bounds, in pixels.
 *
 * Below 12px labels stop being readable; above 24px panels spread out enough
 * that the chat list takes half the screen.
 */
export const FONT_MIN = 12;
export const FONT_MAX = 24;

/** Default font size, in pixels. */
export const FONT_DEFAULT = 17;

export type ThemeName = 'maroon' | 'light' | 'dark' | 'green';
const THEMES: ThemeName[] = ['maroon', 'light', 'dark', 'green'];

export const uiState = $state({
  fontSize: FONT_DEFAULT,
  theme: 'maroon' as ThemeName,
});

/** Rounds the value to a whole pixel within the allowed range. */
export function clampFontSize(px: number): number {
  if (!Number.isFinite(px)) return FONT_DEFAULT;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(px)));
}

function applyFontSize(px: number): void {
  if (typeof document === 'undefined') return;
  document.documentElement.style.fontSize = `${px}px`;
}

function applyTheme(theme: ThemeName): void {
  if (typeof document === 'undefined') return;
  // Themes are driven by the attribute alone: all three are `[data-theme="…"]`,
  // and Tailwind's `dark:` utilities are wired to it through `@custom-variant`
  // in app.css.
  document.documentElement.setAttribute('data-theme', theme);
}


/**
 * Reads the stored values and applies them to the document.
 *
 * Call once at startup, before the first render of meaningful content, or the
 * interface briefly appears at the default size. A read failure is swallowed:
 * corrupt storage must not keep the app from opening.
 */
export function loadUiPreferences(): void {
  let size = FONT_DEFAULT;
  let theme: ThemeName = 'maroon';

  if (typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(FONT_KEY);
      if (raw) size = clampFontSize(Number(raw));
    } catch {
      // Storage is unavailable: keep the default value.
    }
    try {
      const saved = localStorage.getItem(THEME_KEY);
      if (saved && (THEMES as string[]).includes(saved)) theme = saved as ThemeName;
    } catch {
      // Same as above.
    }
  }

  uiState.fontSize = size;
  uiState.theme = theme;
  applyFontSize(size);
  applyTheme(theme);
}

/** Sets, stores and applies the font size. */
export function setFontSize(px: number): void {
  const size = clampFontSize(px);
  uiState.fontSize = size;
  applyFontSize(size);
  try {
    localStorage.setItem(FONT_KEY, String(size));
  } catch {
    // Not persisted: the value lasts until restart. Not a reason to fail.
  }
}

export function increaseFontSize(): void {
  setFontSize(uiState.fontSize + 1);
}

export function decreaseFontSize(): void {
  setFontSize(uiState.fontSize - 1);
}

/** Restores the default font size (Ctrl+0). */
export function resetFontSize(): void {
  setFontSize(FONT_DEFAULT);
}

export function setTheme(theme: ThemeName): void {
  uiState.theme = theme;
  applyTheme(theme);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // See `setFontSize`.
  }
}
