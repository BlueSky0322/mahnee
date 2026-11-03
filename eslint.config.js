// Lint rules for the app (web/src), the Worker (worker) and the code they share (shared).
// TypeScript files are checked with type information.

import js from '@eslint/js';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import { architectureConfig } from './tools/lint/architecture.js';

export default tseslint.config(
  { ignores: ['dist', 'coverage', '.wrangler', 'node_modules'] },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        // Each file's own tsconfig: web/tsconfig.json for the app, the root one for the
        // build configs and web/build
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // The app
  {
    files: ['web/src/**/*.{ts,tsx}'],
    ...react.configs.flat.recommended,
    languageOptions: {
      ...react.configs.flat.recommended.languageOptions,
      globals: globals.browser,
    },
    settings: { react: { version: 'detect' } },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    ...react.configs.flat['jsx-runtime'],
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
    },
  },
  {
    // These export hooks or helpers next to their component by design (and main.tsx is
    // the entry point); fast refresh just reloads the page for them
    files: ['web/src/profile/ProfileContext.tsx', 'web/src/main.tsx'],
    rules: { 'react-refresh/only-export-components': 'off' },
  },

  {
    rules: {
      // React and DOM handlers may return a promise; nothing awaits them, which is fine
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      // Types are imported as types, so it's clear what reaches the bundle
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
      // Dropping fields by destructuring the rest is fine
      '@typescript-eslint/no-unused-vars': ['error', { ignoreRestSiblings: true }],
    },
  },
  {
    files: ['web/src/**/*.{ts,tsx}'],
    rules: {
      // Props are typed with TypeScript instead
      'react/prop-types': 'off',
      // Apostrophes in text are harmless in JSX
      'react/no-unescaped-entities': 'off',
    },
  },

  // Tests read JSON responses loosely; that's fine there
  {
    files: ['**/*.test.{ts,tsx}', 'worker/test/**'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // What may import what, between the app, the Worker and shared code, tests included
  // (tools/lint/architecture.js)
  architectureConfig(import.meta.dirname),

  // The service worker and other plain JavaScript: no type information
  {
    files: ['**/*.js'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    files: ['web/public/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: [
      '*.config.{js,ts}',
      'web/*.config.{js,ts}',
      'web/build/**',
      'worker/test/**',
      'tools/**',
    ],
    languageOptions: { globals: globals.node },
  },
);
