// Makes the app's fixed icons (the PNGs in web/public) from its logo, web/public/icon.svg:
// the hand holding a coin, on a tile. Run it again after changing the logo or an accent's
// colour, and commit what it writes:
//
//   NODE_PATH=<folder holding playwright-core> node tools/icons/make-icons.js
//
// It draws each icon in Chromium through an installed Playwright (playwright-core or
// playwright, found through NODE_PATH or the repository's own packages); the app doesn't
// depend on either. The browser tab's icon (icon.svg itself) follows the device's light or
// dark; these can't, so they take the light theme's accent (shade 6 of its ramp in
// shared/accents.ts). Installing the app takes the accent chosen: the default's icons are
// web/public's own, and each other accent's are in web/public/icons/<accent>/, named by
// web/public/manifest-<accent>.webmanifest, which is web/public/manifest.webmanifest with
// only its icons changed (web/src/pwa/install-icons.ts says which an accent reads).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const pub = (file) => fileURLToPath(new URL(`../../web/public/${file}`, import.meta.url));
const logo = readFileSync(pub('icon.svg'), 'utf8');
const mark = /<path class="mark" fill-rule="evenodd" d="([^"]+)"/.exec(logo)?.[1];
if (mark == null) throw new Error('web/public/icon.svg has no mark to draw');

/**
 * Each accent's tile, the light theme's shade 6, read from shared/accents.ts (which this
 * script can't import); web/src/pwa/icons.test.ts checks each PNG's tile against it
 */
const accentsTs = readFileSync(
  fileURLToPath(new URL('../../shared/accents.ts', import.meta.url)),
  'utf8',
);
const shade6 = (ramp) => [...ramp.matchAll(/'(#[0-9a-f]{6})'/g)][6][1];
const TILES = {
  cobalt: shade6(/COBALT_RAMP: AccentRamp = \[([^\]]+)\]/.exec(accentsTs)[1]),
  ...Object.fromEntries(
    [...accentsTs.matchAll(/^ {2}(\w+): \[([^\]]+)\]/gm)].map(([, name, ramp]) => [
      name,
      shade6(ramp),
    ]),
  ),
};
const DEFAULT_ACCENT = 'cobalt';
const svg = (size, viewBox, inside) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${inside}</svg>`;
const markIn = (colour, transform = '') =>
  `<path fill="${colour}" fill-rule="evenodd"${transform && ` transform="${transform}"`} d="${mark}"/>`;
/** The logo as the browser tab shows it on a light device: rounded tile, corners clear */
const logoAt = (size) => logo.replace('<svg ', `<svg width="${size}" height="${size}" `);
/** The rounded tile in `tile`, corners clear, as the logo draws it */
const rounded = (size, tile) =>
  svg(
    size,
    '0 0 256 256',
    `<rect width="256" height="256" rx="56" fill="${tile}"/>${markIn('#fff')}`,
  );
/** The whole square in `tile`, for icons the phone rounds or crops itself */
const square = (size, tile, transform) =>
  svg(
    size,
    '0 0 256 256',
    `<rect width="256" height="256" fill="${tile}"/>${markIn('#fff', transform)}`,
  );

/** What installing the app reads, on `tile` */
const installIcons = (tile) => ({
  'icon-192.png': rounded(192, tile),
  'icon-512.png': rounded(512, tile),
  // iPhones round the corners themselves, and show any clear corner as black
  'apple-touch-icon.png': square(180, tile),
  // Android may crop to a circle 80% of the icon wide: the mark is drawn smaller, to fit
  'icon-maskable-512.png': square(512, tile, 'matrix(.88 0 0 .88 15.36 15.36)'),
});

const ICONS = {
  'favicon-16.png': logoAt(16),
  'favicon-32.png': logoAt(32),
  ...installIcons(TILES[DEFAULT_ACCENT]),
  // A reminder's small icon on Android: only its shape counts, so the mark alone, filling it
  'badge-96.png': svg(96, '27.5 30.5 190 190', markIn('#fff')),
};
for (const [accent, tile] of Object.entries(TILES)) {
  if (accent === DEFAULT_ACCENT) continue;
  for (const [file, drawing] of Object.entries(installIcons(tile))) {
    ICONS[`icons/${accent}/${file}`] = drawing;
  }
}

// Each other accent's manifest: the app's own, naming that accent's icons
const manifest = JSON.parse(readFileSync(pub('manifest.webmanifest'), 'utf8'));
for (const accent of Object.keys(TILES)) {
  if (accent === DEFAULT_ACCENT) continue;
  const icons = manifest.icons.map((icon) => ({ ...icon, src: `/icons/${accent}${icon.src}` }));
  const file = `manifest-${accent}.webmanifest`;
  writeFileSync(pub(file), `${JSON.stringify({ ...manifest, icons }, null, 2)}\n`);
  console.log(`web/public/${file}`);
}

const require = createRequire(import.meta.url);
const loadPlaywright = () => {
  for (const name of ['playwright-core', 'playwright']) {
    try {
      return require(name);
    } catch {
      // Try the next
    }
  }
  throw new Error('No Playwright found: set NODE_PATH to the folder that holds playwright-core');
};

const { chromium } = loadPlaywright();
const browser = await chromium.launch();
try {
  for (const [file, drawing] of Object.entries(ICONS)) {
    const size = Number(/width="(\d+)"/.exec(drawing)[1]);
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block}</style>${drawing}`,
    );
    mkdirSync(dirname(pub(file)), { recursive: true });
    writeFileSync(pub(file), await page.screenshot({ omitBackground: true }));
    await page.close();
    console.log(`web/public/${file}`);
  }
} finally {
  await browser.close();
}
