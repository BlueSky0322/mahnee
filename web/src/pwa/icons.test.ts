import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { inflateSync } from 'node:zlib';
import { describe, expect, test } from 'vitest';
import { ACCENTS } from '@shared/api';
import { ACCENT_RAMPS, ACCENT_SHADE } from '@shared/accents';
import { TOKENS } from '../testing/css';
import { installFiles } from './install-icons';

// The app's icons (tools/icons/make-icons.js makes the PNGs from web/public/icon.svg): every
// one the manifest, the page and the reminders name is there at the size it's named, and
// the browser tab's follows the device's light or dark in the app's own colours. Installing
// the app takes the icon on a tile of the accent chosen, from that accent's manifest.

const path = (file: string) => fileURLToPath(new NodeURL(`../../${file}`, import.meta.url));
const read = (file: string) => readFileSync(path(file), 'utf8');
const page = read('index.html');
interface Manifest {
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
  [field: string]: unknown;
}
const manifest = JSON.parse(read('public/manifest.webmanifest')) as Manifest;
/** The manifest installing the app in `accent` reads */
const manifestOf = (accent: (typeof ACCENTS)[number]) =>
  JSON.parse(read(`public${installFiles(accent).manifest}`)) as Manifest;
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

/**
 * A PNG's pixels, as #rrggbb with how see-through each is: every row unfiltered, for 8-bit
 * RGB or RGBA, which is what Chromium writes
 */
function pixels(src: string) {
  const bytes = readFileSync(path(`public${src}`));
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  expect(bytes[24]).toBe(8);
  const channels = { 2: 3, 6: 4 }[bytes[25]]!;
  expect(channels).toBeDefined();
  const data: Buffer[] = [];
  for (let at = 8; at < bytes.length; ) {
    const length = bytes.readUInt32BE(at);
    if (bytes.toString('ascii', at + 4, at + 8) === 'IDAT') {
      data.push(bytes.subarray(at + 8, at + 8 + length));
    }
    at += length + 12;
  }
  const raw = inflateSync(Buffer.concat(data));
  const stride = width * channels;
  const rows: Uint8Array[] = [];
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const above = rows[y - 1] ?? new Uint8Array(stride);
    const row = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels] : 0;
      const b = above[i];
      const c = i >= channels ? above[i - channels] : 0;
      const p = a + b - c;
      const nearest =
        Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
            ? b
            : c;
      const predicted = [0, a, b, (a + b) >> 1, nearest][filter];
      row[i] = (line[i] + predicted) & 0xff;
    }
    rows.push(row);
  }
  const at = (x: number, y: number) => {
    const p = rows[y].subarray(x * channels, x * channels + channels);
    const hex = `#${[...p.subarray(0, 3)].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
    return { hex, alpha: channels === 4 ? p[3] : 255 };
  };
  return { width, height, at };
}

/** The tile's colour, from the middle of its top edge, and the share of pure white in it */
function drawn(src: string) {
  const { width, height, at } = pixels(src);
  let white = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (at(x, y).hex === '#ffffff') white++;
  }
  const tile = at(width >> 1, 4);
  return { tile: tile.hex, solid: tile.alpha === 255, white: white / (width * height) };
}

const named = [
  ...ACCENTS.flatMap((accent) => [
    ...manifestOf(accent).icons.map((i) => i.src),
    installFiles(accent).appleTouchIcon,
  ]),
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

describe.each(ACCENTS)('installing the app in %s', (accent) => {
  const tile = ACCENT_RAMPS[accent][ACCENT_SHADE.light];
  const files = installFiles(accent);
  const own = manifestOf(accent);

  test('reads a manifest the same as the app’s own but for its icons', () => {
    const { icons, ...rest } = own;
    const { icons: base, ...baseRest } = manifest;
    expect(rest).toEqual(baseRest);
    expect(icons.map(({ src: _src, ...icon }) => icon)).toEqual(
      base.map(({ src: _src, ...icon }) => icon),
    );
  });

  test('names icons of its own, so a browser that has one sees the change', () => {
    const srcs = [...own.icons.map((i) => i.src), files.appleTouchIcon];
    if (accent === 'cobalt') {
      expect(srcs).toEqual([...manifest.icons.map((i) => i.src), '/apple-touch-icon.png']);
    } else {
      for (const src of srcs)
        expect(src).toMatch(new RegExp(`^/icons/${accent}/[a-z0-9-]+\\.png$`));
    }
  });

  test.each(own.icons.map((i) => [i.src, i.sizes] as const))(
    '%s is %s, the white mark on the light theme’s accent',
    (src, sizes) => {
      expect(png(src).size).toBe(sizes);
      expect(drawn(src)).toMatchObject({ tile, solid: true });
      expect(drawn(src).white).toBeGreaterThan(0.1);
    },
  );

  test('the iPhone’s is 180 square, filled to the corners, the white mark on the accent', () => {
    expect(png(files.appleTouchIcon)).toEqual({ size: '180x180', clear: false });
    expect(drawn(files.appleTouchIcon)).toMatchObject({ tile, solid: true });
    expect(drawn(files.appleTouchIcon).white).toBeGreaterThan(0.1);
    // A corner is the tile too, or the iPhone would show it black
    expect(pixels(files.appleTouchIcon).at(0, 0).hex).toBe(tile);
  });

  test('the maskable icon fills its square', () => {
    const maskable = own.icons.find((i) => i.purpose === 'maskable')!;
    expect(png(maskable.src)).toEqual({ size: '512x512', clear: false });
    expect(pixels(maskable.src).at(0, 0).hex).toBe(tile);
  });
});

test('there is a manifest for each accent and no other', () => {
  const manifests = readdirSync(path('public')).filter((f) => f.endsWith('.webmanifest'));
  expect(manifests.sort()).toEqual(
    [...new Set(ACCENTS.map((a) => installFiles(a).manifest.slice(1)))].sort(),
  );
});
