// Makes the app's fixed icons (the PNGs in web/public) from its logo, web/public/icon.svg:
// the hand holding a coin, on the cobalt tile. Run it again after changing the logo, and
// commit what it writes:
//
//   NODE_PATH=<folder holding playwright-core> node tools/icons/make-icons.js
//
// It draws each icon in Chromium through an installed Playwright (playwright-core or
// playwright, found through NODE_PATH or the repository's own packages); the app doesn't
// depend on either. The browser tab's icon (icon.svg itself) follows the device's light or
// dark; these can't, so they keep the light theme's cobalt.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const pub = (file) => fileURLToPath(new URL(`../../web/public/${file}`, import.meta.url));
const logo = readFileSync(pub('icon.svg'), 'utf8');
const mark = /<path class="mark" fill-rule="evenodd" d="([^"]+)"/.exec(logo)?.[1];
if (mark == null) throw new Error('web/public/icon.svg has no mark to draw');

const COBALT = '#2d4bd8';
const svg = (size, viewBox, inside) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="${viewBox}">${inside}</svg>`;
const markIn = (colour, transform = '') =>
  `<path fill="${colour}" fill-rule="evenodd"${transform && ` transform="${transform}"`} d="${mark}"/>`;
/** The logo as the browser tab shows it on a light device: rounded tile, corners clear */
const rounded = (size) => logo.replace('<svg ', `<svg width="${size}" height="${size}" `);
/** The whole square cobalt, for icons the phone rounds or crops itself */
const square = (size, transform) =>
  svg(
    size,
    '0 0 256 256',
    `<rect width="256" height="256" fill="${COBALT}"/>${markIn('#fff', transform)}`,
  );

const ICONS = {
  'favicon-16.png': rounded(16),
  'favicon-32.png': rounded(32),
  'icon-192.png': rounded(192),
  'icon-512.png': rounded(512),
  // iPhones round the corners themselves, and show any clear corner as black
  'apple-touch-icon.png': square(180),
  // Android may crop to a circle 80% of the icon wide: the mark is drawn smaller, to fit
  'icon-maskable-512.png': square(512, 'matrix(.88 0 0 .88 15.36 15.36)'),
  // A reminder's small icon on Android: only its shape counts, so the mark alone, filling it
  'badge-96.png': svg(96, '27.5 30.5 190 190', markIn('#fff')),
};

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
    writeFileSync(pub(file), await page.screenshot({ omitBackground: true }));
    await page.close();
    console.log(`web/public/${file}`);
  }
} finally {
  await browser.close();
}
