import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test, expect } from 'vitest';

test('the script policy permits same-origin bundles and the exact inline startup code', () => {
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const sources = headers
    .match(/\bscript-src\s+([^;\n]+)/)?.[1]
    .trim()
    .split(/\s+/);
  const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter(
    ([, attrs]) => !/\bsrc\s*=/.test(attrs),
  );
  const hashes = inline.map(
    ([, , code]) => `'sha256-${createHash('sha256').update(code).digest('base64')}'`,
  );
  expect(new Set(sources)).toEqual(new Set(["'self'", ...hashes]));
});
