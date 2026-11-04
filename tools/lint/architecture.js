// The import boundaries between the app (web/src), the service worker (web/public),
// the Worker (worker) and the code they share (shared), checked by `yarn lint`.
//
// Every import is resolved to the file it names (relative paths, the @shared alias and
// absolute paths alike, with any extra ../ worked out) before it's judged, so the rules
// hold however the path is spelled. Covered: import and export ... from (types too),
// import() and require() with a literal path, import('x').Type, import x = require('x'),
// and Vite's import.meta.glob('...') and new URL('...', import.meta.url). An import() or
// require() whose path is worked out at run time can't be checked, so it's refused.
// Not covered: /// <reference> comments (TypeScript's settings keep runtimes apart),
// and paths differing only in letter case (the typecheck refuses those).
// See AGENTS.md and docs/feature-map.md for why these boundaries exist.

import { builtinModules } from 'node:module';
import path from 'node:path';

/** Path aliases, the same as web/tsconfig.json's paths and the Vite configs */
export const ALIASES = { '@shared/': 'shared/' };

/** What each part may import from the others */
const ALLOWED_AREAS = {
  web: ['web', 'shared'],
  worker: ['worker', 'shared'],
  shared: ['shared'],
  serviceWorker: ['serviceWorker'],
};

const AREA_NAMES = {
  web: 'the app (web/src)',
  worker: 'the Worker (worker)',
  shared: 'shared code (shared)',
  serviceWorker: 'the service worker (web/public)',
  outside: 'files outside the app, Worker and shared code',
};

/** The app's entry points, which put the screens together */
const WEB_ENTRY_POINTS = ['web/src/main.tsx', 'web/src/Root.tsx', 'web/src/App.tsx'];

/** What generic building blocks (components/ui) may lean on besides each other: the
 * hooks that know nothing of the app, and utilities */
const UI_MAY_IMPORT = [
  'web/src/components/ui/',
  'web/src/hooks/useBackDismiss',
  'web/src/hooks/useBreakpoints',
  'web/src/utils/',
];

const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith('_')));

const posix = (p) => p.split(path.sep).join('/');

/** Whether a path is this folder or inside it */
const within = (p, dir) => p === dir || p.startsWith(`${dir}/`);

/** Which part a file belongs to, and whether it's a test or test harness */
export function classify(relativePath) {
  const p = posix(relativePath);
  // With or without its extension, as an import names it
  const isTestFile = /\.test(\.[cm]?[jt]sx?)?$/.test(p);
  if (p.startsWith('web/src/testing/')) return { area: 'web', test: true, path: p };
  if (p.startsWith('web/src/')) return { area: 'web', test: isTestFile, path: p };
  if (p.startsWith('web/public/')) return { area: 'serviceWorker', test: false, path: p };
  if (p.startsWith('worker/test/')) return { area: 'worker', test: true, path: p };
  if (p.startsWith('worker/')) return { area: 'worker', test: isTestFile, path: p };
  if (p.startsWith('shared/')) return { area: 'shared', test: isTestFile, path: p };
  return { area: 'outside', test: false, path: p };
}

/** What an import specifier names: a file in the repository, a Node built-in or a package */
export function resolveSpecifier(specifier, fromFile, root, aliases = ALIASES) {
  for (const [prefix, dir] of Object.entries(aliases)) {
    // '@shared/x', and '@shared' itself
    if (specifier.startsWith(prefix) || specifier === prefix.replace(/\/$/, '')) {
      return { kind: 'file', file: path.resolve(root, dir, specifier.slice(prefix.length)) };
    }
  }
  if (specifier.startsWith('.') || path.isAbsolute(specifier)) {
    return { kind: 'file', file: path.resolve(path.dirname(fromFile), specifier) };
  }
  if (specifier.startsWith('node:') || NODE_BUILTINS.has(specifier.split('/')[0])) {
    return { kind: 'builtin' };
  }
  if (specifier.startsWith('cloudflare:')) return { kind: 'cloudflare' };
  return { kind: 'package' };
}

/** Why an import breaks a boundary, or null when it's fine */
export function checkImport(specifier, fromFile, root, aliases = ALIASES) {
  const from = classify(path.relative(root, fromFile));
  if (from.area === 'outside') return null;
  const target = resolveSpecifier(specifier, fromFile, root, aliases);

  if (target.kind === 'builtin') {
    // Node runs the tests; the app, the Worker (no nodejs_compat) and shared code don't
    return from.test ? null : { messageId: 'nodeBuiltin', data: { from: AREA_NAMES[from.area] } };
  }
  if (target.kind === 'cloudflare') {
    return from.area === 'worker' && !from.test
      ? null
      : { messageId: 'cloudflareModule', data: { from: AREA_NAMES[from.area] } };
  }
  if (target.kind === 'package') return null;

  const to = classify(path.relative(root, target.file));
  if (!ALLOWED_AREAS[from.area].includes(to.area)) {
    return {
      messageId: 'crossArea',
      data: { from: AREA_NAMES[from.area], to: AREA_NAMES[to.area] },
    };
  }
  if (from.test) return null;
  // Production code never reaches into tests or their harness, which run in Node
  if (to.test || within(to.path, 'web/src/testing') || within(to.path, 'worker/test')) {
    return { messageId: 'testHarness' };
  }
  if (from.area !== 'web') return null;

  // Inside the app, only screens and the entry points draw screens...
  const fromComponents = within(from.path, 'web/src/components');
  const toEntryPoint = WEB_ENTRY_POINTS.some((entry) =>
    within(to.path, entry.replace(/\.tsx$/, '')),
  );
  if (
    (within(to.path, 'web/src/components') || toEntryPoint) &&
    !fromComponents &&
    !WEB_ENTRY_POINTS.includes(from.path)
  ) {
    return { messageId: 'stateImportsComponent' };
  }
  // ...and generic building blocks know nothing of the app's features or its API
  if (
    within(from.path, 'web/src/components/ui') &&
    to.area === 'web' &&
    !UI_MAY_IMPORT.some((dir) => to.path.startsWith(dir))
  ) {
    return { messageId: 'uiImportsApp', data: { to: to.path } };
  }
  return null;
}

/** The literal path an import names, or undefined when it's worked out at run time */
function literalPath(node) {
  if (node == null) return undefined;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) {
    return node.quasis[0].value.cooked ?? undefined;
  }
  if (node.type === 'TSLiteralType') return literalPath(node.literal);
  return undefined;
}

const boundaries = {
  meta: {
    type: 'problem',
    docs: { description: 'Keeps the app, the Worker and shared code apart' },
    schema: [
      {
        type: 'object',
        properties: {
          root: { type: 'string' },
          aliases: { type: 'object', additionalProperties: { type: 'string' } },
        },
        required: ['root'],
        additionalProperties: false,
      },
    ],
    messages: {
      crossArea: '{{from}} may not import {{to}}. Put what both need in shared/ (see AGENTS.md).',
      nodeBuiltin:
        '{{from}} may not import Node built-ins: it does not run in Node. Only tests and their harness may.',
      cloudflareModule: '{{from}} may not import cloudflare: modules; only the Worker runs there.',
      testHarness:
        'Production code may not import tests or their harness (web/src/testing, worker/test).',
      stateImportsComponent:
        'Only screens (web/src/components) and the entry points may import components; state, hooks and utilities sit below them.',
      uiImportsApp:
        'components/ui knows nothing of the app: it may not import {{to}}. Put this in components/common, or pass it in.',
      computed:
        "An import() or require() whose path is worked out at run time can't be checked against the boundaries; use a literal path.",
    },
  },
  create(context) {
    const [{ root, aliases = ALIASES }] = context.options;
    const file = context.physicalFilename ?? context.filename;

    const check = (sourceNode, reportNode = sourceNode) => {
      const specifier = literalPath(sourceNode);
      if (specifier === undefined) return;
      const problem = checkImport(specifier, file, root, aliases);
      if (problem) context.report({ node: reportNode, ...problem });
    };

    return {
      ImportDeclaration: (node) => check(node.source),
      ExportNamedDeclaration: (node) => node.source && check(node.source),
      ExportAllDeclaration: (node) => check(node.source),
      ImportExpression(node) {
        if (literalPath(node.source) === undefined) {
          context.report({ node, messageId: 'computed' });
        } else check(node.source);
      },
      TSImportType: (node) => check(node.source ?? node.argument, node),
      TSExternalModuleReference: (node) => check(node.expression),
      CallExpression(node) {
        const { callee } = node;
        const [first] = node.arguments;
        if (callee.type === 'Identifier' && callee.name === 'require') {
          if (literalPath(first) === undefined) context.report({ node, messageId: 'computed' });
          else check(first, node);
        }
        // Vite: import.meta.glob('./a/*.ts') or import.meta.glob(['./a/*', './b/*'])
        if (
          callee.type === 'MemberExpression' &&
          callee.object.type === 'MetaProperty' &&
          callee.property.type === 'Identifier' &&
          callee.property.name === 'glob' &&
          first
        ) {
          const patterns = first.type === 'ArrayExpression' ? first.elements : [first];
          for (const pattern of patterns) check(pattern, node);
        }
      },
      // A file's address, which Vite bundles: new URL('../x.ts', import.meta.url)
      NewExpression(node) {
        const [first, second] = node.arguments;
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'URL' &&
          second?.type === 'MemberExpression' &&
          second.object.type === 'MetaProperty'
        ) {
          check(first, node);
        }
      },
    };
  },
};

export const plugin = { rules: { boundaries } };

/** The lint config that applies the rule to every part, tests included */
export const architectureConfig = (root) => ({
  files: ['web/src', 'web/public', 'worker', 'shared'].map(
    (dir) => `${dir}/**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}`,
  ),
  plugins: { architecture: plugin },
  rules: { 'architecture/boundaries': ['error', { root, aliases: ALIASES }] },
});
