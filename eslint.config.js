/**
 * ESLint flat config for the SvelteKit + TypeScript frontend.
 *
 * The shared configs are layered in order (JS, TypeScript, Svelte), and two
 * per-file blocks hand the Svelte parser its TypeScript parser underneath.
 * console.log is rejected in src/ while warn and error are allowed, so
 * diagnostics survive without debug noise.
 */
import js from '@eslint/js';
import ts from 'typescript-eslint';
import svelte from 'eslint-plugin-svelte';
import globals from 'globals';
import svelteParser from 'svelte-eslint-parser';

export default [
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs['flat/recommended'],
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
    },
  },
  {
    // Parser setup for Svelte files (Svelte 5 + TypeScript)
    files: ['**/*.svelte'],
    languageOptions: {
      parser: svelteParser,
      parserOptions: {
        parser: ts.parser,
        extraFileExtensions: ['.svelte'],
      },
    },
  },
  {
    // Setup for .svelte.ts files (Svelte 5 runes)
    files: ['**/*.svelte.ts'],
    languageOptions: {
      parser: ts.parser,
    },
  },
  {
    // console.log is banned in source code
    files: ['src/**/*.{js,ts,svelte}'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // The rule is off for shadcn components, which use <a href>
    files: ['src/lib/components/ui/**/*.svelte'],
    rules: {
      'svelte/no-navigation-without-resolve': 'off',
    },
  },
  {
    ignores: ['build/', 'dist/', '.svelte-kit/', 'node_modules/', 'src-tauri/'],
  },
];
