/**
 * A small, safe Markdown renderer for the bundled documents.
 *
 * Covers what the repository documents use: headings, paragraphs, bullet and
 * numbered lists, fenced code, tables, bold, inline code and links. Anything
 * else is shown as plain text.
 *
 * @remarks
 * Safety comes from order: every character is HTML-escaped first, and only then
 * are Markdown markers turned into tags. Raw HTML in a document therefore shows
 * as text and cannot run. Links are kept only when they point to another bundled
 * document (`*.md`) or to `http(s)`; anything else (`javascript:`, `data:`) is
 * dropped to plain text.
 *
 * A full Markdown library would be a new dependency for four pages of text.
 */

/** Escapes the five characters that are special in HTML. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Whether a link target may become an `<a>`.
 *
 * @param href - Target as written in the document.
 * @returns `true` for bundled `.md` files and for `http(s)` addresses.
 */
export function isSafeHref(href: string): boolean {
  if (/^https?:\/\//i.test(href)) return true;
  if (/^[\w./-]+\.md(#[\w-]+)?$/.test(href) && !href.includes('..')) return true;
  return false;
}

/** Inline formatting on text that is already escaped. */
function inline(escaped: string): string {
  // Code spans first, so their content is not formatted again.
  const codes: string[] = [];
  let out = escaped.replace(/`([^`]+)`/g, (_, code) => {
    codes.push(`<code class="px-1 rounded bg-secondary font-mono text-[0.9em]">${code}</code>`);
    return `\u0000${codes.length - 1}\u0000`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match, label, href) => {
    // `href` is escaped text; un-escape `&amp;` only for the safety check.
    const raw = href.replace(/&amp;/g, '&');
    if (!isSafeHref(raw)) return label;
    const target = /^https?:/i.test(raw) ? ' target="_blank" rel="noopener noreferrer"' : '';
    // Bundled documents open in the same app window, through the Home handler.
    const data = /^https?:/i.test(raw) ? '' : ` data-doc="${raw.replace(/#.*$/, '')}"`;
    return `<a href="${raw}" class="text-primary underline underline-offset-2"${target}${data}>${label}</a>`;
  });
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  out = out.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
  return out;
}

/** Splits a table row into trimmed cells. */
function cells(line: string): string[] {
  return line.replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

/**
 * Renders a Markdown document to HTML.
 *
 * @param source - Markdown text.
 * @returns HTML that is safe to place with `{@html}`.
 */
export function renderMarkdown(source: string): string {
  const lines = escapeHtml(source).split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block.
    if (line.startsWith('```')) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i++;
      }
      i++; // closing fence
      out.push(
        `<pre class="p-3 rounded-md bg-secondary text-xs font-mono overflow-x-auto whitespace-pre">${body.join('\n')}</pre>`
      );
      continue;
    }

    // Table: a header row followed by a separator row.
    if (line.startsWith('|') && i + 1 < lines.length && /^\|[\s:|-]+\|?$/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) {
        rows.push(cells(lines[i]));
        i++;
      }
      const th = head.map((c) => `<th class="px-2 py-1 text-left font-semibold">${inline(c)}</th>`).join('');
      const tb = rows
        .map((r) => `<tr class="border-t border-border">${r.map((c) => `<td class="px-2 py-1 align-top">${inline(c)}</td>`).join('')}</tr>`)
        .join('');
      out.push(
        `<div class="overflow-x-auto"><table class="w-full text-sm border border-border rounded-md"><thead class="bg-secondary"><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`
      );
      continue;
    }

    // Heading.
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      const level = h[1].length;
      const cls = ['', 'text-2xl font-bold', 'text-xl font-bold', 'text-lg font-semibold', 'text-base font-semibold'][level];
      out.push(`<h${level} class="${cls} text-foreground mt-6 mb-2">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^---+$/.test(line.trim())) {
      out.push('<hr class="my-4 border-border" />');
      i++;
      continue;
    }

    // Lists.
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const tag = ordered ? 'ol' : 'ul';
      const items: string[] = [];
      while (i < lines.length && (/^\s*[-*]\s+/.test(lines[i]) || /^\s*\d+\.\s+/.test(lines[i]))) {
        items.push(`<li>${inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''))}</li>`);
        i++;
      }
      const style = ordered ? 'list-decimal' : 'list-disc';
      out.push(`<${tag} class="${style} pl-6 space-y-1 text-sm">${items.join('')}</${tag}>`);
      continue;
    }

    // Blank line.
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph: consecutive plain lines.
    const para: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== '' &&
      !lines[i].startsWith('```') &&
      !lines[i].startsWith('|') &&
      !/^#{1,4}\s/.test(lines[i]) &&
      !/^\s*([-*]|\d+\.)\s+/.test(lines[i]) &&
      !/^---+$/.test(lines[i].trim())
    ) {
      para.push(lines[i]);
      i++;
    }
    out.push(`<p class="text-sm leading-relaxed text-foreground">${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}
