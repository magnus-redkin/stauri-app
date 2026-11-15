/**
 * Vite config for the SvelteKit frontend, shared by the Tauri dev server and Vitest.
 *
 * The dev server port is fixed at 1420 because Tauri's devUrl points there, and
 * src-tauri is kept out of the watcher so a Rust rebuild does not reload the
 * frontend. In `test` mode Svelte resolves to its browser build, without which
 * components cannot mount under happy-dom.
 */
import { defineConfig } from "vite";
import { sveltekit } from "@sveltejs/kit/vite";
import process from "node:process";
import tailwindcss from '@tailwindcss/vite';

const host = process.env.TAURI_DEV_HOST;

/**
 * Strips debug output from the production bundle.
 *
 * Vite 8 runs on rolldown and no longer applies `esbuild.drop` — the option is
 * deprecated and silently ignored. rolldown has `compress.dropConsole`, but it
 * is reachable only through `build.rolldownOptions.output.minify`, overwriting
 * the minify settings Vite assembles itself: fragile and version-dependent.
 * Removing the calls through the rollup `renderChunk` hook is deterministic and
 * does not depend on bundler internals.
 *
 * Only calls standing as a whole expression are removed; `const x = console.log(...)`
 * is kept, because there its result would matter.
 *
 * @param {{ methods: string[] }} options - Console methods to drop, e.g. `['log', 'debug']`.
 */
function dropConsolePlugin({ methods }) {
  const names = methods.map((m) => `console.${m}`).join('|');
  // The whole call including its arguments (nested parentheses and strings included).
  const call = `(?:${names})\\s*\\(`;
  return {
    name: 'stauri:drop-console',
    apply: 'build',
    enforce: 'post',
    /**
     * @param {string} code
     */
    renderChunk(code) {
      let out = '';
      let i = 0;
      while (i < code.length) {
        const match = new RegExp(call, 'g');
        match.lastIndex = i;
        const found = match.exec(code);
        if (!found) {
          out += code.slice(i);
          break;
        }
        out += code.slice(i, found.index);
        // Find the matching closing parenthesis, skipping strings and templates.
        let depth = 1;
        let j = found.index + found[0].length;
        let quote = null;
        while (j < code.length && depth > 0) {
          const ch = code[j];
          if (quote) {
            if (ch === '\\') { j += 2; continue; }
            if (ch === quote) quote = null;
          } else if (ch === '"' || ch === "'" || ch === '`') {
            quote = ch;
          } else if (ch === '(') {
            depth++;
          } else if (ch === ')') {
            depth--;
          }
          j++;
        }
        // Make sure this is a statement expression, not part of an assignment.
        const before = out.replace(/\s+$/, '');
        const isStatementStart = before === '' || /[;{}]$/.test(before);
        if (isStatementStart) {
          i = j; // remove it entirely
        } else {
          out += code.slice(found.index, j);
          i = j;
        }
      }
      return { code: out, map: null };
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [
    tailwindcss(),
    sveltekit(),
    ...(mode === 'production'
      ? [dropConsolePlugin({ methods: ['log', 'debug', 'info', 'warn', 'trace'] })]
      : []),
  ],

  // Svelte 5 + Vitest: resolve the browser build of Svelte so components mount in tests.
  resolve: mode === 'test' ? { conditions: ['browser'] } : {},

  test: {
    include: ['src/**/*.{test,spec}.{js,ts}'],
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },

  // Tauri development options
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || "127.0.0.1",
    hmr: host
      ? {
        protocol: "ws",
        host,
        port: 1421,
      }
    : undefined,
    watch: {
      ignored: ["**/src-tauri/**"],
    },
  },
}));
