// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { afterEach, describe, expect, test } from 'vitest';
import { LAUNCH_BACKGROUNDS } from './launch-images';

// What shows before the app's code loads takes the "Paper ledger" colours (the design's
// R-System board): the paper ground, and the logo drawn in the cobalt accent. The page asks
// Google Fonts for Geist and Geist Mono, and no longer for Inter.

const read = (path: string) =>
  readFileSync(fileURLToPath(new NodeURL(path, import.meta.url)), 'utf8');
const indexHtml = read('../index.html');
const manifest = JSON.parse(read('../public/manifest.webmanifest')) as Record<string, string>;

const GROUND = { light: '#f3f1ec', dark: '#0f1012' } as const;
const COBALT = { light: '#2d4bd8', dark: '#93a5ff' } as const;

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
});

/** index.html's first screen with `theme` decided, as its script leaves it (scripts don't run) */
function firstScreen(theme: 'light' | 'dark') {
  document.head.innerHTML = /<head>([\s\S]*)<\/head>/.exec(indexHtml)![1];
  document.body.innerHTML = /<body>([\s\S]*)<\/body>/.exec(indexHtml)![1];
  document.documentElement.setAttribute('data-launch', theme);
  const launch = document.getElementById('launch')!;
  return {
    page: hex(getComputedStyle(document.documentElement).backgroundColor),
    launch: hex(getComputedStyle(launch).backgroundColor),
    logo: Array.from(launch.querySelectorAll('path')).map((p) => hex(getComputedStyle(p).stroke)),
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
      querySelector: () => ({ setAttribute: (_name: string, value: string) => (colour = value) }),
    },
  });
  return colour;
}

test('the iPhone launch screens are the paper ground, light and dark', () => {
  expect(LAUNCH_BACKGROUNDS).toEqual(GROUND);
});

describe.each(['light', 'dark'] as const)('the first screen, %s', (theme) => {
  test('paints the paper ground behind the logo, and draws the logo in cobalt', () => {
    expect(firstScreen(theme)).toEqual({
      page: GROUND[theme],
      launch: GROUND[theme],
      logo: [COBALT[theme], COBALT[theme], COBALT[theme]],
    });
  });

  test('colours the status bar the ground', () => {
    expect(statusBar(theme)).toBe(GROUND[theme]);
  });
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
