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
 * The last lines of a subsection may be single links, one per line —
 * `[Full document](web3im.md)`, `[Status](https://status.im)`. They become the section's
 * footer buttons and are removed from the body, because the screen renders them as
 * buttons rather than as text. Several are allowed: a section usually points at its own
 * document and at an outside source.
 */

/** One footer link of a subsection. */
export interface DocLink {
  /** Text shown on the button. */
  label: string;
  /** Target as written in the document: a bundled `.md` path or an `http(s)` address. */
  target: string;
}

/** One subsection of the About document. */
export interface AboutSection {
  /** Stable identifier derived from the heading; the selected value in the menu. */
  id: string;
  /** Heading text exactly as written in the file. */
  title: string;
  /** Markdown of the body, without the trailing links. */
  body: string;
  /** Footer links, in file order; empty when the subsection has none. */
  links: DocLink[];
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
    const { body, links } = takeLinks(buffer.join('\n'));
    const base = sectionId(title);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    sections.push({
      id: count === 1 ? base : `${base}-${count}`,
      title,
      body,
      links,
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
 * Removes the footer links from the end of a section body.
 *
 * @param body - Raw body lines joined.
 * @returns The body without the link lines, and the links in file order.
 * @remarks
 * Any run of consecutive link-only lines at the end counts, so a section can point at
 * its own document and at an outside source without one of them being swallowed as text.
 */
function takeLinks(body: string): { body: string; links: DocLink[] } {
  const lines = body.split('\n');
  // Trailing blank lines are not part of the body.
  let end = lines.length - 1;
  while (end >= 0 && lines[end].trim() === '') end--;
  if (end < 0) return { body: '', links: [] };

  const links: DocLink[] = [];
  while (end >= 0) {
    const match = LINK_LINE.exec(lines[end].trim());
    if (!match) break;
    links.unshift({ label: match[1], target: match[2] });
    end--;
  }

  if (links.length === 0) return { body: body.trim(), links: [] };
  return { body: lines.slice(0, end + 1).join('\n').trim(), links };
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
