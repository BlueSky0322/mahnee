import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { type Rollup, build } from 'vite';
import { PRECACHE_FILE, precacheList } from './precache';

// The build lists the files the service worker keeps for offline use. Built here for
// real, from a small app: an entry with styles, two features that load a library when
// first used (as an import or an export might), sharing some code, and a library that
// loads an optional extra of its own.

let root: string;

const files: Record<string, string> = {
  'index.html':
    '<!doctype html><html><head></head><body><script type="module" src="/main.js"></script></body></html>',
  'main.js': `import './style.css';
    document.querySelector('#share').onclick = () => import('shot').then((m) => m.shoot());
    document.querySelector('#pdf').onclick = () => import('pdf').then((m) => m.make());`,
  'style.css': 'body { color: red; }',
  'node_modules/shot/package.json': '{ "name": "shot", "type": "module", "main": "index.js" }',
  'node_modules/shot/index.js': `import { draw } from 'common';
    export const shoot = () => draw('shot');`,
  'node_modules/pdf/package.json': '{ "name": "pdf", "type": "module", "main": "index.js" }',
  'node_modules/pdf/index.js': `import { draw } from 'common';
    export const make = () => draw('pdf') + import('./extra.js').then((m) => m.extra());`,
  'node_modules/pdf/extra.js': 'export const extra = () => "only if asked";',
  'node_modules/common/package.json': '{ "name": "common", "type": "module", "main": "index.js" }',
  'node_modules/common/index.js': 'export const draw = (what) => `drawn by ${what}`;',
};

let output: Rollup.OutputBundle[number][];

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'precache-'));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    writeFileSync(path.join(root, name), text);
  }
  const result = (await build({
    root,
    configFile: false,
    logLevel: 'silent',
    plugins: [precacheList()],
    build: { write: false },
  })) as Rollup.RollupOutput;
  output = result.output;
}, 30_000);

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** The built chunk holding `module` (a path under the fixture's root) */
const chunkWith = (module: string) => {
  const chunk = output.find(
    (file) => file.type === 'chunk' && file.moduleIds.some((id) => id === path.join(root, module)),
  );
  if (chunk == null) throw new Error(`No chunk has ${module}`);
  return `/${chunk.fileName}`;
};

describe('the list of files kept for offline use', () => {
  test('has the entry, its styles, and what the app loads later with what that imports', () => {
    const list = output.find((file) => file.fileName === PRECACHE_FILE);
    if (list?.type !== 'asset') throw new Error('No list was written');
    const css = output.find((file) => file.fileName.endsWith('.css'))!.fileName;

    expect(JSON.parse(list.source as string)).toEqual(
      [
        chunkWith('main.js'),
        `/${css}`,
        chunkWith('node_modules/shot/index.js'),
        chunkWith('node_modules/pdf/index.js'),
        // Shared by both, so a chunk of its own that each imports
        chunkWith('node_modules/common/index.js'),
      ].sort(),
    );
  });

  test('leaves out what only a library loads for itself', () => {
    const list = output.find((file) => file.fileName === PRECACHE_FILE);
    const extra = chunkWith('node_modules/pdf/extra.js');
    expect(JSON.parse((list as Rollup.OutputAsset).source as string)).not.toContain(extra);
  });
});
