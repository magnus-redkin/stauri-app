import { renderMarkdown } from '../utils/markdown';

// The document name comes from the script tag that loaded this file, not from
// the address: `WebviewUrl::App` takes a path, and a query string in it is not
// reliable. Every document has a small generated page (scripts/sync-docs.mjs).
const doc = document.currentScript?.getAttribute('data-doc') ?? '';
const target = document.getElementById('doc')!;

// Only bundled documents: a name with a parent segment or a scheme is refused.
if (!/^(ru|en)\/[\w.-]+\.md$/.test(doc)) {
  target.textContent = 'Document not found.';
} else {
  // Absolute: the page sits in /docs/<lang>/, while `doc` already carries the language.
  fetch(`/docs/${doc}`)
    .then((r) => { if (!r.ok) throw new Error(String(r.status)); return r.text(); })
    .then((text) => {
      target.innerHTML = renderMarkdown(text);
      // Links to other bundled documents open in this same viewer.
      target.addEventListener('click', (e) => {
        const a = (e.target as HTMLElement).closest('a[data-doc]') as HTMLAnchorElement | null;
        if (!a) return;
        e.preventDefault();
        // Follow a link inside the same window: replace the page with the
        // generated page of the target document.
        const next = a.getAttribute('data-doc')!.replace(/^\.\//, '').replace(/\.md$/, '.html');
        window.location.href = `/docs/${next}`;
      });
    })
    .catch(() => { target.textContent = 'Could not load the document.'; });
}
