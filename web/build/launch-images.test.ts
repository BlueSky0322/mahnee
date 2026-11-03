import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, test } from 'vitest';
import { LAUNCH_BACKGROUNDS, solidPng } from './launch-images';

// The first screen in index.html runs before the app's code, so it keeps its own copy of
// the backgrounds; the iPhone launch screens use the same ones.

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const indexHtml = read('../index.html');
const firstScreenScript = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)![1];

/**
 * Runs index.html's first-screen script with `saved` stored and the phone set to `system`:
 * the theme it paints, and the status bar's colour
 */
function openApp(saved: string | null, system: 'light' | 'dark') {
  const set: Record<string, string> = {};
  const statusBar = { setAttribute: (_name: string, value: string) => (set.statusBar = value) };
  runInNewContext(firstScreenScript, {
    localStorage: {
      getItem: () => (saved == null ? null : JSON.stringify({ theme: saved })),
    },
    matchMedia: (query: string) => ({ matches: query === `(prefers-color-scheme: ${system})` }),
    document: {
      documentElement: { setAttribute: (_name: string, value: string) => (set.theme = value) },
      querySelector: () => statusBar,
    },
  });
  return set;
}

describe('the first screen', () => {
  test.each([
    ['the theme chosen in the app, over the phone’s', 'dark', 'light', 'dark'],
    ['the theme chosen in the app, over the phone’s', 'light', 'dark', 'light'],
    ['the phone’s theme on Auto', 'auto', 'dark', 'dark'],
    ['the phone’s theme on Auto', 'auto', 'light', 'light'],
    ['the phone’s theme before anything is saved', null, 'light', 'light'],
  ] as const)('takes %s (saved %s, phone %s)', (_what, saved, system, expected) => {
    expect(openApp(saved, system)).toEqual({
      theme: expected,
      statusBar: LAUNCH_BACKGROUNDS[expected],
    });
  });

  test("uses the app's own backgrounds, as the iPhone launch screens do", () => {
    const tokens = read('../src/theme/tokens.css');
    const [dark, light] = [...tokens.matchAll(/--sf-bg:\s*(#[0-9a-f]{6})/g)].map((m) => m[1]);
    expect(LAUNCH_BACKGROUNDS).toEqual({ dark, light });
    expect(indexHtml).toContain(`background: ${dark}`);
    expect(indexHtml).toContain(`background: ${light}`);
  });
});

test('an iPhone launch screen is exactly the size asked for, or iOS shows white instead', () => {
  const png = solidPng(1179, 2556, LAUNCH_BACKGROUNDS.dark);
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1179, 2556]);
});
