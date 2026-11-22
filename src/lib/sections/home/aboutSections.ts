/**
 * Parser for the About document: `## Heading` opens a subsection, the text under it
 * belongs to it.
 *
 * @remarks
 * The text lives in `docs/<lang>/about.md`, not in the locale catalogs, so the list of
 * subsections is whatever the file contains — adding a `##` there adds an item to the
 * menu without touching code. `###` and deeper stay part of the body; only level two
 * splits the document.
 *
 * The last line of a subsection may be a single link — `[Full document](ru/web3im.md)`.
 * It becomes the section's footer link and is removed from the body, because the screen
 * renders it as a button rather than as text.
 */

/** Target of the document link at the foot of a subsection. */
export type DocTarget = string;

/** One subsection of the About document. */
export interface AboutSection {
  /** Stable identifier derived from the heading; the selected value in the menu. */
  id: string;
  /** Heading text exactly as written in the file. */
  title: string;
  /** Markdown of the body, without the trailing document link. */
  body: string;
  /** Document link, when the subsection carries one. */
  link?: DocTarget;
}

/** Heading line: exactly two hashes, so `###` stays inside the body. */
const HEADING = /^##\s+(.*)$/;
/** A line that is one Markdown link and nothing else. */
const LINK_LINE = /^\[([^\]]+)\]\(([^)\s]+)\)$/;

/**
 * Turns a heading into an identifier.
 *
 * @param title - Heading text.
 * @returns Lower-case, hyphen-separated form; letters of any alphabet are kept.
 * @remarks
 * The id is only used to remember which subsection is open, so a lossy slug is enough —
 * two headings that slug alike are told apart by {@link parseAbout}.
 */
export function sectionId(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '') || 'section'
  );
}

/**
 * Splits the About document into subsections.
 *
 * @param markdown - Whole file.
 * @returns Subsections in file order; empty when the file has no `##` heading.
 * @remarks
 * Text before the first heading is dropped: a title of the page, a note to translators
 * or a table of contents would otherwise render as a section with no heading.
 */
export function parseAbout(markdown: string): AboutSection[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const sections: AboutSection[] = [];
  const seen = new Map<string, number>();

  let title: string | null = null;
  let buffer: string[] = [];

  const flush = () => {
    if (title === null) return;
    const { body, link } = takeLink(buffer.join('\n'));
    const base = sectionId(title);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    sections.push({
      id: count === 1 ? base : `${base}-${count}`,
      title,
      body,
      ...(link ? { link } : {}),
    });
  };

  for (const line of lines) {
    const match = HEADING.exec(line);
    if (match) {
      flush();
      title = match[1].trim();
      buffer = [];
    } else if (title !== null) {
      buffer.push(line);
    }
  }
  flush();
  return sections;
}

/**
 * Removes the document link from the end of a section body.
 *
 * @param body - Raw body lines joined.
 * @returns The body without the link line, and the link when there was one.
 */
function takeLink(body: string): { body: string; link?: DocTarget } {
  const lines = body.split('\n');
  // Trailing blank lines are not part of the body.
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === '') end--;
  if (end < 0) return { body: '' };

  const match = LINK_LINE.exec(lines[end].trim());
  if (!match) return { body: body.trim() };

  return { body: lines.slice(0, end).join('\n').trim(), link: match[2] };
}

/**
 * Builds the repository path of a linked document.
 *
 * @param target - Link target as written in the subsection.
 * @param language - Language of the document that carries the link.
 * @returns Path under `docs/`, e.g. `docs/ru/web3im.md`.
 * @remarks
 * A target that starts with a language folder is taken as written, so an English page
 * can point at the Russian comparison document that has no translation yet. Anything
 * else is resolved next to the page itself. `..` is refused: the link reaches a window
 * that loads bundled files by name.
 */
export function resolveDocPath(target: string, language: string): string {
  const clean = target.trim();
  if (clean.includes('..') || clean.startsWith('/')) return '';
  if (/^(en|ru|es|zh)\//.test(clean)) return `docs/${clean}`;
  return `docs/${language}/${clean}`;
}

/** Base address of the repository, used to open a document in a dApp window. */
export const DOCS_BASE_URL = 'https://github.com/magnus-redkin/stauri-app/blob/main';

/**
 * Turns a resolved path into the address the dApp window opens.
 *
 * @param path - Path from {@link resolveDocPath}.
 * @returns Address, or an empty string when the path is not usable.
 */
export function docUrl(path: string): string {
  if (!path) return '';
  return `${DOCS_BASE_URL}/${path}`;
}
