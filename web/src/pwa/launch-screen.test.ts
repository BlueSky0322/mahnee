// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ACCENTS } from '@shared/api';
import { ACCENT_RAMPS, ACCENT_SHADE } from '@shared/accents';
import { APPEARANCE_KEY } from '../profile/ProfileContext';
import { hideLaunchScreen } from './launch-screen';
import { hex, readBeside } from '../testing/css';
import { launchDocument, openLaunchPage } from '../testing/launch-page';

// What shows before the app's code loads takes the "Paper ledger" colours (the design's
// R-System board): the paper ground, and the logo on a tile of the saved accent (cobalt until
// another is chosen), its hand and coin in the ink written on it. The page asks
// Google Fonts for Geist and Geist Mono, and no longer for Inter.

const manifest = JSON.parse(readBeside('../../public/manifest.webmanifest', import.meta.url));

const GROUND = { light: '#f3f1ec', dark: '#0f1012' } as const;
const COBALT = { light: '#2d4bd8', dark: '#93a5ff' } as const;
const ON_ACCENT = { light: '#ffffff', dark: '#0f1012' } as const;

afterEach(() => {
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  localStorage.removeItem(APPEARANCE_KEY);
});

function firstScreen() {
  const launch = document.getElementById('launch')!;
  return {
    statusBars: Array.from(document.querySelectorAll('meta[name="theme-color"]'), (bar) =>
      bar.getAttribute('content'),
    ),
    page: hex(getComputedStyle(document.documentElement).backgroundColor),
    launch: hex(getComputedStyle(launch).backgroundColor),
    tile: hex(getComputedStyle(launch.querySelector('rect')!).fill),
    mark: Array.from(launch.querySelectorAll('path')).map((p) => hex(getComputedStyle(p).fill)),
  };
}

describe.each(['light', 'dark'] as const)('the first screen, %s', (theme) => {
  test('paints the paper ground behind the logo, on a cobalt tile', () => {
    openLaunchPage(theme);
    expect(firstScreen()).toEqual({
      statusBars: [GROUND[theme], GROUND[theme]],
      page: GROUND[theme],
      launch: GROUND[theme],
      tile: COBALT[theme],
      mark: [ON_ACCENT[theme], ON_ACCENT[theme]],
    });
  });

  // The accent's own shade on each theme, as the app draws it (shared/accents.ts)
  test.each(ACCENTS)('draws the tile in a saved %s', (accent) => {
    const shade = ACCENT_RAMPS[accent][ACCENT_SHADE[theme]];
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme, accent }));
    openLaunchPage(theme === 'light' ? 'dark' : 'light');
    expect(firstScreen()).toMatchObject({
      page: GROUND[theme],
      tile: shade,
      statusBars: [GROUND[theme], GROUND[theme]],
    });
  });

  test('follows the device when the saved theme is Auto', () => {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: 'auto' }));
    openLaunchPage(theme);
    expect(firstScreen().page).toBe(GROUND[theme]);
  });
});

test("before the script runs, the status bar takes the device's light or dark ground", () => {
  const bars = Array.from(launchDocument().querySelectorAll('meta[name="theme-color"]'));
  expect(bars.map((m) => [m.getAttribute('media'), m.getAttribute('content')])).toEqual([
    ['(prefers-color-scheme: light)', GROUND.light],
    ['(prefers-color-scheme: dark)', GROUND.dark],
  ]);
});

test("an installed app opens on the light ground, the design's default", () => {
  expect([manifest.background_color, manifest.theme_color]).toEqual([GROUND.light, GROUND.light]);
});

test('the page asks for Geist and Geist Mono in one request, and never for Inter', () => {
  const stylesheets = Array.from(
    launchDocument().querySelectorAll<HTMLLinkElement>(
      'link[rel="stylesheet"][href^="https://fonts.googleapis.com/css"]',
    ),
  );
  expect(stylesheets).toHaveLength(1);
  const families = new URL(stylesheets[0].href).searchParams.getAll('family');
  expect(families.sort()).toEqual(['Geist Mono:wght@400;500', 'Geist:wght@400;500;600']);
});

test('dismisses the launch screen when the app is ready with reduced motion', async () => {
  openLaunchPage('light');
  expect(document.getElementById('launch')).toBeTruthy();
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  hideLaunchScreen();
  await vi.waitFor(() => expect(document.getElementById('launch')).toBeNull(), { timeout: 2000 });
});
