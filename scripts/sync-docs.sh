#!/usr/bin/env bash
# sync-docs.sh — copies the documents shown in the app into static/docs/ and
# generates one tiny page per document.
#
# Each page loads viewer.js with `data-doc` set: the viewer reads the name from
# its own script tag rather than the address, because `WebviewUrl::App` takes a
# path and a query string in it is not reliable.
#
# The file list mirrors DOC_WHITELIST in src-tauri/src/dapp.rs: a document added
# there must be added here too.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FILES=(
  ru/web3im.md ru/architecture.md ru/auth_and_sync.md ru/comparison.md
  en/web3im.md en/architecture.md en/auth_and_sync.md en/comparison.md
)

for f in "${FILES[@]}"; do
  src="$ROOT/docs/$f"
  dir="$ROOT/static/docs/$(dirname "$f")"
  mkdir -p "$dir"
  cp "$src" "$ROOT/static/docs/$f"
  page="${f%.md}.html"
  cat > "$dir/$(basename "${f%.md}").html" <<HTML
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Stauri — $(basename "$f")</title>
  <link rel="stylesheet" href="/docs/viewer.css" />
</head>
<body>
  <main id="doc"><p>Loading…</p></main>
  <script src="/docs/viewer.js" data-doc="$f"></script>
</body>
</html>
HTML
  echo "  $page"
done
echo "synced ${#FILES[@]} documents into static/docs/"
