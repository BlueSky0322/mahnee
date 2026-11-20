import { existsSync, readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';
import { TOKENS } from '../testing/css';

// The app's icons (tools/icons/make-icons.js makes the PNGs from web/public/icon.svg): every
// one the manifest, the page and the reminders name is there at the size it's named, and
// the browser tab's follows the device's light or dark in the app's own colours.

const path = (file: string) => fileURLToPath(new NodeURL(`../../${file}`, import.meta.url));
const read = (file: string) => readFileSync(path(file), 'utf8');
const page = read('index.html');
const manifest = JSON.parse(read('public/manifest.webmanifest')) as {
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};
const sw = read('public/sw.js');

/** A PNG's width, height and whether it has see-through pixels, from its header */
function png(src: string) {
  const bytes = readFileSync(path(`public${src}`));
  expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
  const colourType = bytes[25];
  return {
    size: `${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`,
    clear: colourType === 4 || colourType === 6,
  };
}

const named = [
  ...manifest.icons.map((i) => i.src),
  /rel="apple-touch-icon"\s+href="([^"]+)"/.exec(page)![1],
  ...[...page.matchAll(/rel="icon"[^>]*?href="([^"]+)"/g)].map((m) => m[1]),
  ...[...sw.matchAll(/(?:icon|badge): '([^']+)'/g)].map((m) => m[1]),
];

test.each([...new Set(named)])('%s is there', (src) => {
  expect(existsSync(path(`public${src}`))).toBe(true);
});

test('each PNG the manifest names is the size it says', () => {
  for (const { src, sizes } of manifest.icons) expect(png(src).size).toBe(sizes);
});

test('each PNG the page links for the tab is the size it says', () => {
  const links = [
    ...page.matchAll(/rel="icon"\s+type="image\/png"\s+sizes="(\d+x\d+)"\s+href="([^"]+)"/g),
  ];
  expect(links.map((m) => m[2])).toEqual(['/favicon-16.png', '/favicon-32.png']);
  for (const [, sizes, src] of links) expect(png(src).size).toBe(sizes);
});

describe('icons the phone shapes itself', () => {
  test('the iPhone icon is 180 square with no clear corners, which iPhones show black', () => {
    expect(png('/apple-touch-icon.png')).toEqual({ size: '180x180', clear: false });
  });

  test('the maskable icon fills its square, for Android to crop', () => {
    const maskable = manifest.icons.find((i) => i.purpose === 'maskable')!;
    expect(png(maskable.src)).toEqual({ size: '512x512', clear: false });
  });

  test("a reminder's badge is the mark alone, on nothing", () => {
    expect(png('/badge-96.png')).toEqual({ size: '96x96', clear: true });
  });
});

test('installing takes fixed PNGs, never the tab icon that follows the device', () => {
  expect(manifest.icons.map((i) => i.type)).toEqual(['image/png', 'image/png', 'image/png']);
});

test("the tab icon follows the device's light or dark, in the app's accent and its ink", () => {
  const svg = read('public/icon.svg');
  const [light, dark] = svg.split('@media (prefers-color-scheme:dark)');
  const fill = (css: string, part: string) =>
    new RegExp(`\\.${part}\\{fill:(#[0-9a-f]+)\\}`).exec(css)?.[1];
  const full = (hex: string | undefined) =>
    hex?.length === 4 ? `#${[...hex.slice(1)].map((c) => c + c).join('')}` : hex;
  expect([fill(light, 'tile'), full(fill(light, 'mark'))]).toEqual([
    TOKENS.light['--accent'],
    TOKENS.light['--accent-ink'],
  ]);
  expect([fill(dark, 'tile'), fill(dark, 'mark')]).toEqual([
    TOKENS.dark['--accent'],
    TOKENS.dark['--accent-ink'],
  ]);
});
