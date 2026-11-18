import { describe, it, expect } from 'vitest';
import { renderMarkdown, isSafeHref, escapeHtml } from '$lib/utils/markdown';
import { readFileSync } from 'node:fs';

describe('renderMarkdown', () => {
  it('escapes raw HTML so it cannot run', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)> and <script>x</script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).toContain('&lt;img');
  });
  it('drops javascript: links to plain text', () => {
    const html = renderMarkdown('[click](javascript:alert(1))');
    expect(html).not.toContain('<a ');
    expect(html).toContain('click');
  });
  it('keeps bundled .md links and https links', () => {
    expect(isSafeHref('ru/comparison.md')).toBe(true);
    expect(isSafeHref('comparison.md#x')).toBe(true);
    expect(isSafeHref('https://status.im')).toBe(true);
    expect(isSafeHref('../secret.md')).toBe(false);
    expect(isSafeHref('file:///etc/passwd')).toBe(false);
  });
  it('renders the real documents without leaking markup', () => {
    for (const f of ['docs/ru/web3im.md', 'docs/ru/comparison.md', 'docs/ru/architecture.md', 'docs/en/architecture.md']) {
      const html = renderMarkdown(readFileSync(f, 'utf8'));
      expect(html.length).toBeGreaterThan(500);
      expect(html).toMatch(/<(h[1-4]|p|ul|ol|table|pre)\b/);
    }
  });
  it('escapeHtml covers the five characters', () => {
    expect(escapeHtml(`<&>"'`)).toBe('&lt;&amp;&gt;&quot;&#39;');
  });
});
