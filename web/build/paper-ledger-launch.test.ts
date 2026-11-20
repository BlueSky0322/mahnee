// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, test } from 'vitest';
import { ACCENTS } from '../../shared/api';
import type { Accent } from '../../shared/api';
import { ACCENT_RAMPS, ACCENT_SHADE } from '../../shared/accents';
import { LAUNCH_BACKGROUNDS } from './launch-images';

// What shows before the app's code loads takes the "Paper ledger" colours (the design's
// R-System board): the paper ground, and the logo on a tile of the saved accent (cobalt until
// another is chosen), its hand and coin in the ink written on it. The page asks
// Google Fonts for Geist and Geist Mono, and no longer for Inter.

const read = (path: string) =>
  readFileSync(fileURLToPath(new NodeURL(path, import.meta.url)), 'utf8');
const indexHtml = read('../index.html');
const manifest = JSON.parse(read('../public/manifest.webmanifest')) as Record<string, string>;

const GROUND = { light: '#f3f1ec', dark: '#0f1012' } as const;
const COBALT = { light: '#2d4bd8', dark: '#93a5ff' } as const;
const ON_ACCENT = { light: '#ffffff', dark: '#0f1012' } as const;

const hex = (rgb: string) => {
  const m = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb);
  return m == null
    ? rgb.toLowerCase()
    : '#' +
        m
          .slice(1, 4)
          .map((n) => Number(n).toString(16).padStart(2, '0'))
          .join('');
};

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  document.documentElement.removeAttribute('data-launch');
  document.documentElement.removeAttribute('data-accent');
});

/**
 * index.html's first screen with `theme` (and `accent`, when one is saved) decided, as its
 * script leaves them (scripts don't run)
 */
function firstScreen(theme: 'light' | 'dark', accent?: Accent) {
  document.head.innerHTML = /<head>([\s\S]*)<\/head>/.exec(indexHtml)![1];
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(indexHtml)![1];
  document.documentElement.setAttribute('data-launch', theme);
  if (accent) document.documentElement.setAttribute('data-accent', accent);
  const launch = document.getElementById('launch')!;
  return {
    page: hex(getComputedStyle(document.documentElement).backgroundColor),
    launch: hex(getComputedStyle(launch).backgroundColor),
    tile: hex(getComputedStyle(launch.querySelector('rect')!).fill),
    mark: Array.from(launch.querySelectorAll('path')).map((p) => hex(getComputedStyle(p).fill)),
  };
}

/** The status bar's colour index.html's script sets, for a phone in `theme` */
function statusBar(theme: 'light' | 'dark') {
  const script = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)![1];
  let colour = '';
  runInNewContext(script, {
    localStorage: { getItem: () => null },
    matchMedia: (query: string) => ({ matches: query === `(prefers-color-scheme: ${theme})` }),
    document: {
      documentElement: { setAttribute: () => {} },
      querySelectorAll: () => [
        { setAttribute: (_name: string, value: string) => (colour = value) },
      ],
    },
  });
  return colour;
}

test('the iPhone launch screens are the paper ground, light and dark', () => {
  expect(LAUNCH_BACKGROUNDS).toEqual(GROUND);
});

describe.each(['light', 'dark'] as const)('the first screen, %s', (theme) => {
  test('paints the paper ground behind the logo, on a cobalt tile', () => {
    expect(firstScreen(theme)).toEqual({
      page: GROUND[theme],
      launch: GROUND[theme],
      tile: COBALT[theme],
      mark: [ON_ACCENT[theme], ON_ACCENT[theme]],
    });
  });

  // The accent's own shade on each theme, as the app draws it (shared/accents.ts)
  test.each(ACCENTS)('draws the tile in a saved %s', (accent) => {
    const shade = ACCENT_RAMPS[accent][ACCENT_SHADE[theme]];
    expect(firstScreen(theme, accent)).toMatchObject({ tile: shade });
  });

  test('colours the status bar the ground', () => {
    expect(statusBar(theme)).toBe(GROUND[theme]);
  });
});

test('the first screen takes only an accent the app offers', () => {
  expect(indexHtml).toContain(`/^(${ACCENTS.join('|')})$/.test(saved.accent)`);
});

test("before the script runs, the status bar takes the device's light or dark ground", () => {
  document.head.innerHTML = /<head>([\s\S]*)<\/head>/.exec(indexHtml)![1];
  const bars = Array.from(document.querySelectorAll('meta[name="theme-color"]'));
  expect(bars.map((m) => [m.getAttribute('media'), m.getAttribute('content')])).toEqual([
    ['(prefers-color-scheme: light)', GROUND.light],
    ['(prefers-color-scheme: dark)', GROUND.dark],
  ]);
});

test("an installed app opens on the light ground, the design's default", () => {
  expect([manifest.background_color, manifest.theme_color]).toEqual([GROUND.light, GROUND.light]);
});

test('the page asks for Geist and Geist Mono in one request, and never for Inter', () => {
  const stylesheets = [
    ...indexHtml.matchAll(/href="(https:\/\/fonts\.googleapis\.com\/css[^"]*)"/g),
  ];
  expect(stylesheets).toHaveLength(1);
  const families = new NodeURL(stylesheets[0][1]).searchParams.getAll('family');
  expect(families.sort()).toEqual(['Geist Mono:wght@400;500', 'Geist:wght@400;500;600']);
  expect(indexHtml).not.toMatch(/family=Inter\b/);
});
