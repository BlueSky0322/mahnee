// Links in the repository's own documents lead somewhere: each relative link names a
// file that exists, each #anchor a heading in the file it points to, and each file path
// written as code (`split/actions.ts`) a file in the repository, the app or the Worker.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const documents = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  ...readdirSync(path.join(root, 'docs'))
    .filter((f) => f.endsWith('.md'))
    .map((f) => `docs/${f}`),
];

/** GitHub's anchor for a heading: lower case, punctuation dropped, spaces as hyphens */
const anchorOf = (heading) =>
  heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N} _-]/gu, '')
    .replace(/ /g, '-');

const headings = (file) =>
  readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => /^#{1,6} /.test(line))
    .map((line) => anchorOf(line.replace(/^#+ /, '')));

/** Every [text](target) outside code, skipping web addresses */
function links(file) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  return [...text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)]
    .map((m) => m[1])
    .filter((target) => !/^[a-z]+:/i.test(target));
}

const allLinks = documents.flatMap((document) =>
  links(path.join(root, document)).map((target) => [document, target]),
);

describe('links in the documents', () => {
  test('there are links to check', () => expect(allLinks.length).toBeGreaterThan(0));

  test.each(allLinks)('%s: %s leads somewhere', (document, target) => {
    const file = path.join(root, document);
    const [where, anchor] = target.split('#');
    const linked = where ? path.resolve(path.dirname(file), where) : file;
    expect(existsSync(linked), `${linked} exists`).toBe(true);
    if (anchor) expect(headings(linked)).toContain(anchor);
  });
});

/** Code spans that name a file: a folder, a name and an extension, nothing else */
function filePaths(file) {
  const text = readFileSync(file, 'utf8').replace(/```[\s\S]*?```/g, '');
  return [...text.matchAll(/`([\w./-]+\/[\w.-]+\.[a-z]{2,4})`/g)].map((m) => m[1]);
}

/** Where a path written in the docs may start from */
const PATH_ROOTS = ['', 'web/src', 'worker'];

const allPaths = documents.flatMap((document) =>
  filePaths(path.join(root, document)).map((p) => [document, p]),
);

describe('file paths in the documents', () => {
  test('there are paths to check', () => expect(allPaths.length).toBeGreaterThan(0));

  test.each(allPaths)('%s: %s exists', (_document, written) => {
    const found = PATH_ROOTS.some((start) => existsSync(path.join(root, start, written)));
    expect(found, `${written} is in the repository, web/src or worker`).toBe(true);
  });
});
