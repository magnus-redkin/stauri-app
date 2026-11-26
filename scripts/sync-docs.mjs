// sync-docs.mjs — copies the documents shown in the app into static/docs/ and
// generates one tiny page per document.
//
// Node rather than shell on purpose: `pnpm build` is the Tauri `beforeBuildCommand`,
// and on Windows Tauri runs that through `cmd`, where `bash` is not necessarily on
// PATH. The same script therefore has to work under bash and cmd alike.
//
// Each page loads viewer.js with `data-doc` set: the viewer reads the name from its
// own script tag rather than the address, because `WebviewUrl::App` takes a path and a
// query string in it is not reliable.
//
// The file list mirrors DOC_WHITELIST in src-tauri/src/dapp.rs: a document added there
// must be added here too.

import { cpSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const FILES = [
  'ru/web3im.md',
  'ru/architecture.md',
  'ru/auth_and_sync.md',
  'ru/comparison.md',
  'en/web3im.md',
  'en/architecture.md',
  'en/auth_and_sync.md',
  'en/comparison.md',
];

for (const file of FILES) {
  const src = join(ROOT, 'docs', file);
  const targetDir = join(ROOT, 'static', 'docs', dirname(file));
  mkdirSync(targetDir, { recursive: true });
  cpSync(src, join(ROOT, 'static', 'docs', file));

  const stem = basename(file, '.md');
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stauri — ${basename(file)}</title>
  <link rel="stylesheet" href="/docs/viewer.css" />
</head>
<body>
  <main id="doc"><p>Loading…</p></main>
  <script src="/docs/viewer.js" data-doc="${file}"></script>
</body>
</html>
`;
  writeFileSync(join(targetDir, `${stem}.html`), html);
  console.log(`  ${file.replace(/\.md$/, '.html')}`);
}

console.log(`synced ${FILES.length} documents into static/docs/`);
