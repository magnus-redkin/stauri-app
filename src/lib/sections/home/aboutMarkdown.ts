/**
 * Loads the About document of the interface language.
 *
 * @remarks
 * The markdown is imported with `?raw` and compiled into the bundle rather than fetched
 * at runtime: the desktop app is unsigned in the wild, the Android package has no
 * `docs/` folder of its own, and fetching a `tauri://` path differs between the two.
 *
 * The imports are explicit rather than a `import.meta.glob` pattern: a glob that
 * silently matches nothing leaves the menu empty with no build error, which is exactly
 * how the first version shipped a blank About screen. A missing file here fails the
 * build instead.
 */
import en from '../../../../docs/en/about.md?raw';
import ru from '../../../../docs/ru/about.md?raw';
import es from '../../../../docs/es/about.md?raw';
import zh from '../../../../docs/zh/about.md?raw';
import { i18n } from '$lib/i18n';

/** Document per locale; a language without a file shows English. */
const DOCUMENTS: Record<string, string> = { en, ru, es, zh };

/**
 * Markdown of the About document in the current language.
 *
 * @returns Raw markdown, English when the language has no file.
 * @remarks
 * The file is the source of subsections: add a `##` heading to it and the menu gains an
 * item in the next build, with no code change.
 */
export function aboutMarkdown(): string {
  return DOCUMENTS[i18n.locale ?? 'en'] ?? DOCUMENTS.en;
}
