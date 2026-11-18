// build-viewer.mjs — compiles the document viewer into static/docs/viewer.js.
//
// The viewer is a classic script (no modules), so the window that opens a
// document needs no bundler at runtime. It uses the same Markdown renderer as the
// app (src/lib/utils/markdown.ts): there is one renderer, not two.
//
// Run by hand after changing the renderer or the viewer entry:
//   node scripts/build-viewer.mjs
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(ROOT, 'src/lib/docs-viewer/entry.ts');
const out = mkdtempSync(join(tmpdir(), 'stauri-viewer-'));

await build({
  configFile: false,
  logLevel: 'warn',
  build: {
    outDir: out,
    emptyOutDir: true,
    minify: true,
    lib: { entry, formats: ['iife'], name: 'viewer', fileName: () => 'viewer.js' },
  },
});

copyFileSync(join(out, 'viewer.js'), join(ROOT, 'static/docs/viewer.js'));
rmSync(out, { recursive: true, force: true });
console.log('built static/docs/viewer.js');
