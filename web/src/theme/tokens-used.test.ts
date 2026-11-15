import { readFileSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';

// A colour or size named by a CSS variable that nothing defines is silently dropped by the
// browser, and no type check sees it. Every var(--name) the app uses must be defined: in
// theme/tokens.css or elsewhere in the app's own styles and code, or by Mantine. And the
// earlier look's colour names are gone, so nothing still draws in them.

/** web/, from this file in web/src/theme */
const web = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..') + '/';

/** The app's own files that can name a CSS variable, tests and their harness left out */
const files = [
  ...readdirSync(join(web, 'src'), { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.(css|ts|tsx)$/.test(f))
    .filter((f) => !/\.test\.tsx?$/.test(f) && !f.startsWith('testing'))
    .map((f) => join(web, 'src', f)),
  join(web, 'index.html'),
  ...readdirSync(join(web, 'public'))
    .filter((f) => /\.(css|js|html|webmanifest)$/.test(f))
    .map((f) => join(web, 'public', f)),
].map((path) => ({ path: path.slice(web.length), text: readFileSync(path, 'utf8') }));

const mantine = readFileSync(
  createRequire(import.meta.url).resolve('@mantine/core/styles.css'),
  'utf8',
);

/** Every variable Mantine's stylesheet names: it sets some of them from its components */
const mantineNames = new Set(mantine.match(/--[a-zA-Z0-9-]+/g));

/** Names declared (`--name:`) in the app's CSS, or set from its code (`'--name'` as a string) */
const defined = new Set(
  files
    .map((f) => f.text)
    .flatMap((text) => [
      ...[...text.matchAll(/(--[a-zA-Z0-9-]+)\s*:/g)].map((m) => m[1]),
      ...[...text.matchAll(/['"`](--[a-zA-Z0-9-]+)['"`]/g)].map((m) => m[1]),
    ]),
);

const used = files.flatMap(({ path, text }) =>
  [...text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)/g)].map((m) => ({ path, name: m[1] })),
);

/** The earlier look's colours and the Splitfoolish leftovers */
const OLD_COLOURS =
  /--sf-(bg|surface|text|text-secondary|text-muted|text-label|positive|negative|divider|border|accent|accent-tint|tag|hover|tint|badge|badge-text|shadow-sm|shadow-md|shadow-lg|avatar|place|place-tint|person-[0-9a-z-]+|series-[0-9a-z-]+|fill)\b/g;

/** The app's own variables that aren't colours, which keep their names */
const KEPT = ['--sf-safe-bottom', '--sf-keyboard'];

test('every CSS variable the app uses is defined somewhere', () => {
  expect(used.length).toBeGreaterThan(0);
  const undefinedNames = used.filter(
    ({ name }) => !defined.has(name) && !mantineNames.has(name) && !name.startsWith('--mantine-'),
  );
  expect(undefinedNames).toEqual([]);
});

test("the earlier look's colour names are gone", () => {
  const left = files.flatMap(({ path, text }) =>
    [...text.matchAll(OLD_COLOURS)].map((m) => `${path}: ${m[0]}`),
  );
  expect(left).toEqual([]);
});

test('the only --sf- variables left are the kept ones that are not colours', () => {
  const names = new Set(files.flatMap(({ text }) => text.match(/--sf-[a-z0-9-]+/g) ?? []));
  expect([...names].filter((n) => !KEPT.includes(n))).toEqual([]);
});
