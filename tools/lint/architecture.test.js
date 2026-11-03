// The import boundaries (architecture.js), run through ESLint as `yarn lint` runs them,
// on code given as if it were at a path in the repository. Nothing here is a real file.

import { ESLint } from 'eslint';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import tseslint from 'typescript-eslint';
import { describe, expect, test } from 'vitest';
import { ALIASES, architectureConfig } from './architecture.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const eslint = new ESLint({
  cwd: root,
  overrideConfigFile: true,
  overrideConfig: [{ languageOptions: { parser: tseslint.parser } }, architectureConfig(root)],
});

/** What the rule says about this code at that path: one messageId per problem */
async function problems(file, code) {
  const [result] = await eslint.lintText(code, { filePath: path.join(root, file) });
  const fatal = result.messages.filter((m) => m.fatal);
  expect(fatal).toEqual([]);
  return result.messages.map((m) => m.messageId);
}

const allowed = (file, code) => expect(problems(file, code)).resolves.toEqual([]);
const refused = (file, code, messageId) =>
  expect(problems(file, code)).resolves.toEqual([messageId]);

describe('between the app, the Worker and shared code', () => {
  test.each([
    ['web/src/split/a.ts', "import { MAX_CHANGES } from '@shared/api';"],
    ['web/src/split/a.ts', "import type { Item } from '../../../shared/types';"],
    ['worker/a.ts', "import { toCents } from '../shared/rates';"],
    ['worker/routes/a.ts', "export { toCents } from '../../shared/rates';"],
    ['shared/a.ts', "import { toCents } from './rates';"],
    ['web/src/split/a.ts', "import { api } from '../api';"],
    ['web/src/split/a.ts', "import { useState } from 'react';"],
    ['worker/a.ts', "import { Hono } from 'hono';"],
    ['worker/room.ts', "import { DurableObject } from 'cloudflare:workers';"],
    ['web/src/a.ts', "const shot = () => import('modern-screenshot');"],
  ])('%s may: %s', (file, code) => allowed(file, code));

  test.each([
    ['web/src/split/a.ts', "import { Env } from '../../../worker/app';"],
    ['web/src/split/a.ts', "import type { Env } from '../../../worker/app';"],
    ['web/src/split/a.ts', "type E = import('../../../worker/app').Env;"],
    ['web/src/split/a.ts', "import x = require('../../../worker/app');"],
    ['web/src/split/a.ts', "const app = () => import('../../../worker/app');"],
    ['web/src/split/a.ts', 'const app = () => import(`../../../worker/app`);'],
    ['worker/a.ts', "import { api } from '../web/src/api';"],
    ['worker/a.ts', "const { api } = require('../web/src/api');"],
    ['shared/a.ts', "import { api } from '../web/src/api';"],
    ['shared/a.ts', "export * from '../worker/http';"],
    ['shared/a.ts', "export { json } from '../worker/http';"],
    ['web/public/sw.js', "import { api } from '../src/api';"],
    ['worker/a.ts', "import pkg from '../package.json';"],
  ])('%s may not: %s', (file, code) => refused(file, code, 'crossArea'));

  test.each([
    // Extra ../ and ./ segments are worked out before judging
    ['web/src/split/a.ts', "import { Env } from '../../../web/../worker/./app';"],
    ['web/src/split/a.ts', "import { Env } from '../../src/../../worker/app';"],
    // The alias is resolved too, so it can't be a way round
    ['web/src/split/a.ts', "import { Env } from '@shared/../worker/app';"],
    ['web/src/split/a.ts', "import { Env } from '@shared/../web/../worker/app';"],
  ])('however the path is spelled: %s %s', (file, code) => refused(file, code, 'crossArea'));

  test('tests are held to the same boundaries', async () => {
    await refused(
      'web/src/split/a.test.ts',
      "import { Env } from '../../../worker/app';",
      'crossArea',
    );
    await refused(
      'web/src/testing/a.ts',
      "import { json } from '../../../worker/http';",
      'crossArea',
    );
    await refused('worker/test/a.ts', "import { api } from '../../web/src/api';", 'crossArea');
  });

  test('an import() whose path is worked out at run time is refused, as it cannot be checked', () =>
    refused('web/src/a.ts', 'const load = (name) => import(name);', 'computed'));
});

describe('ways round the boundaries the review found', () => {
  test.each([
    // Vite pulls these files into the bundle too
    ['web/src/a.ts', "const files = import.meta.glob('../../worker/*.ts');"],
    ['web/src/a.ts', "const files = import.meta.glob(['./x/*.ts', '../../worker/*.ts']);"],
    ['web/src/a.ts', "const url = new URL('../../worker/app.ts', import.meta.url);"],
    // Every kind of source file is checked, not only .ts
    ['worker/a.tsx', "import { api } from '../web/src/api';"],
    ['shared/a.mts', "import { api } from '../web/src/api';"],
    ['web/public/a.mjs', "import { api } from '../src/api';"],
  ])('%s may not: %s', (file, code) => refused(file, code, 'crossArea'));

  test.each([
    ['web/src/a.ts', "const files = import.meta.glob('./locales/*.json');"],
    ['web/src/a.ts', "const url = new URL('./worker-script.js', import.meta.url);"],
  ])('%s may: %s', (file, code) => allowed(file, code));

  test('a require() whose path is worked out at run time is refused', () =>
    refused('worker/a.ts', 'const load = (name) => require(name);', 'computed'));

  test('a folder named without its trailing slash is still that folder', async () => {
    await refused(
      'web/src/split/a.ts',
      "import * as all from '../components';",
      'stateImportsComponent',
    );
    await refused('web/src/split/a.ts', "import * as all from '../testing';", 'testHarness');
  });

  test('state never reaches screens through the entry points', async () => {
    await refused('web/src/split/a.ts', "import App from '../App';", 'stateImportsComponent');
    await refused('web/src/hooks/a.ts', "import { Root } from '../Root';", 'stateImportsComponent');
  });

  test.each([
    ['worker/a.ts', "import { startLocalWorker } from './test/local-worker';"],
    ['web/src/split/a.ts', "import { trip } from './actions.test';"],
    ['shared/a.ts', "import { cases } from './settle.test';"],
  ])('production code never imports tests: %s %s', (file, code) =>
    refused(file, code, 'testHarness'),
  );

  test('components/ui may use only the hooks that know nothing of the app', async () => {
    await refused(
      'web/src/components/ui/a.tsx',
      "import { useRate } from '../../hooks/useRate';",
      'uiImportsApp',
    );
    await refused(
      'web/src/components/ui/a.tsx',
      "import { navigate } from '../../hooks/useRoute';",
      'uiImportsApp',
    );
    await allowed(
      'web/src/components/ui/a.tsx',
      "import { useIsMobile } from '../../hooks/useBreakpoints';",
    );
  });
});

describe('Node and Worker runtimes', () => {
  test.each([
    ['shared/a.ts', "import { readFileSync } from 'node:fs';"],
    ['shared/a.ts', "import { readFileSync } from 'fs';"],
    ['shared/a.ts', "import { readFile } from 'fs/promises';"],
    ['web/src/offline/a.ts', "import { runInNewContext } from 'node:vm';"],
    // The Worker runs without nodejs_compat
    ['worker/a.ts', "import { createHash } from 'node:crypto';"],
  ])('production code may not import Node built-ins: %s %s', (file, code) =>
    refused(file, code, 'nodeBuiltin'),
  );

  test.each([
    ['worker/test/local-worker.ts', "import { spawn } from 'node:child_process';"],
    ['web/src/testing/sw.ts', "import { runInNewContext } from 'node:vm';"],
    ['web/src/offline/outbox.test.ts', "import { readFileSync } from 'node:fs';"],
    ['shared/settle.test.ts', "import { readFileSync } from 'node:fs';"],
  ])('tests and their harness may: %s %s', (file, code) => allowed(file, code));

  test.each([
    ['shared/a.ts', "import { DurableObject } from 'cloudflare:workers';"],
    ['web/src/a.ts', "import { DurableObject } from 'cloudflare:workers';"],
  ])('only the Worker may import cloudflare: modules: %s', (file, code) =>
    refused(file, code, 'cloudflareModule'),
  );
});

describe('inside the app', () => {
  test('state, hooks and utilities sit below the screens', async () => {
    await refused(
      'web/src/split/a.ts',
      "import SplitScreen from '../components/split/SplitScreen';",
      'stateImportsComponent',
    );
    await refused(
      'web/src/hooks/a.ts',
      "import type { Dialog } from '../components/split/SplitPageContext';",
      'stateImportsComponent',
    );
    await allowed('web/src/App.tsx', "import SplitScreen from './components/split/SplitScreen';");
    await allowed(
      'web/src/components/home/a.tsx',
      "import { useSplit } from '../../split/useSplit';",
    );
  });

  test('the test harness is for tests only', async () => {
    await refused(
      'web/src/split/a.ts',
      "import { renderApp } from '../testing/app';",
      'testHarness',
    );
    await allowed('web/src/split/a.test.ts', "import { renderApp } from '../testing/app';");
  });

  test.each([
    "import { avatarUrl } from '../../api';",
    "import { useSplitState } from '../../split/SplitStateContext';",
    "import { useProfile } from '../../profile/ProfileContext';",
    "import UserAvatar from '../common/UserAvatar';",
    "import { useSplitPage } from '../split/SplitPageContext';",
  ])('generic building blocks know nothing of the app: %s', (code) =>
    refused('web/src/components/ui/a.tsx', code, 'uiImportsApp'),
  );

  test.each([
    "import PhotoViewer from './PhotoViewer';",
    "import { useBackDismiss } from '../../hooks/useBackDismiss';",
    "import { formatMoney } from '../../utils/money';",
    "import { COMMON_CURRENCIES } from '@shared/rates';",
    "import { Modal } from '@mantine/core';",
  ])('generic building blocks may lean on: %s', (code) =>
    allowed('web/src/components/ui/a.tsx', code),
  );
});

describe('the repository config', () => {
  // One real ESLint for the whole block: each new one loads the config and its plugins again
  const real = new ESLint({ cwd: root });

  test.each([
    'web/src/api.ts',
    'web/src/components/ui/Fab.tsx',
    'web/src/testing/app.ts',
    'web/src/offline/outbox.test.ts',
    'web/public/sw.js',
    'worker/app.ts',
    'worker/test/api.test.ts',
    'shared/api.ts',
    'shared/settle.test.ts',
  ])('checks %s', async (file) => {
    const config = await real.calculateConfigForFile(file);
    expect(config.rules['architecture/boundaries']?.[0]).toBe(2);
  });

  test('refuses a bad import through the real lint config, not only switches the rule on', async () => {
    // Real files, so the type-aware rules can parse them; only this rule's verdict counts
    const cases = [
      ['shared/rates.ts', "import { api } from '../web/src/api';\nexport const x = api;\n"],
      ['worker/http.ts', "import { api } from '../web/src/api';\nexport const x = api;\n"],
      ['web/src/api.ts', "import { json } from '../../worker/http';\nexport const x = json;\n"],
    ];
    for (const [file, code] of cases) {
      const [result] = await real.lintText(code, { filePath: path.join(root, file) });
      const verdicts = result.messages.filter((m) => m.ruleId === 'architecture/boundaries');
      expect(
        verdicts.map((m) => m.messageId),
        file,
      ).toEqual(['crossArea']);
    }
    // Starts TypeScript for the shared code, the Worker and the app in turn
  }, 30_000);

  test('knows the same path aliases as the app', () => {
    const { config } = ts.readConfigFile(path.join(root, 'web/tsconfig.json'), ts.sys.readFile);
    const fromTsconfig = Object.fromEntries(
      Object.entries(config.compilerOptions.paths).map(([alias, [target]]) => [
        alias.replace('*', ''),
        path.relative(root, path.resolve(root, 'web', target.replace('*', ''))) + '/',
      ]),
    );
    expect(ALIASES).toEqual(fromTsconfig);
  });
});
