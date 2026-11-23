// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import { URL as NodeURL, fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test } from 'vitest';
import { ACCENTS, type Accent } from '@shared/api';
import { ACCENT_NAMES } from '@shared/accents';
import { APPEARANCE_KEY } from '../profile/ProfileContext';
import { fakeServer, renderApp, setupAppTests } from '../testing/app';
import { installFiles } from './install-icons';

// Installing the app takes the accent chosen in Look and start: the page names that
// accent's manifest and iPhone icon, from the first moment (index.html's first script, from
// what the device kept) and as the accent changes, so an install prompt, Add to Home
// Screen, or Android's check on an installed app reads the icon in the accent.

const indexHtml = readFileSync(
  fileURLToPath(new NodeURL('../../index.html', import.meta.url)),
  'utf8',
);

/** Where the page points installing: its manifest and its iPhone icon */
const linked = () => ({
  manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
  appleTouchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
});

describe("index.html's first script", () => {
  const firstScreenScript = /<script>([\s\S]*?)<\/script>/.exec(indexHtml)![1];

  /** The page's head as index.html writes it, after its first script ran with `saved` */
  function open(saved: unknown) {
    document.head.innerHTML = /<head>([\s\S]*)<\/head>/.exec(indexHtml)![1];
    runInNewContext(firstScreenScript, {
      localStorage: { getItem: () => (saved == null ? null : JSON.stringify(saved)) },
      matchMedia: () => ({ matches: false }),
      document,
    });
    return linked();
  }

  test('names the default (cobalt) files before anything is saved', () => {
    expect(open(null)).toEqual(installFiles('cobalt'));
    expect(installFiles('cobalt')).toEqual({
      manifest: '/manifest.webmanifest',
      appleTouchIcon: '/apple-touch-icon.png',
    });
  });

  test.each(ACCENTS)('names the files of a saved %s, as the app does', (accent) => {
    expect(open({ theme: 'light', accent })).toEqual(installFiles(accent));
  });

  test('keeps the default for an accent the app never offered', () => {
    expect(open({ theme: 'light', accent: 'teal' })).toEqual(installFiles('cobalt'));
  });
});

describe('the app', () => {
  setupAppTests();

  // The page the app runs in, with the links index.html gives it
  beforeEach(() => {
    document.head.innerHTML = [
      ...indexHtml.matchAll(/<link\s+rel="(?:manifest|apple-touch-icon)"[\s\S]*?\/>/g),
    ]
      .map((m) => m[0])
      .join('');
    expect(linked()).toEqual(installFiles('cobalt'));
  });

  test("points installing at the device's kept accent at once, then the profile's", async () => {
    const server = fakeServer();
    server.me.settings.accent = 'rust';
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme: 'light', accent: 'plum' }));
    renderApp(server, '/', { size: 'phone' });
    expect(linked()).toEqual(installFiles('plum'));
    await waitFor(() => expect(linked()).toEqual(installFiles('rust')));
  });

  test.each<[Accent, Accent]>([
    ['cobalt', 'green'],
    ['green', 'graphite'],
    ['plum', 'cobalt'],
  ])('switches from %s to %s when it is picked in Look and start', async (from, to) => {
    const server = fakeServer();
    server.me.settings.accent = from;
    renderApp(server, '/?settings=look', { size: 'phone' });
    const look = within(await screen.findByRole('region', { name: 'Look and start' }));
    await waitFor(() => expect(linked()).toEqual(installFiles(from)));
    await userEvent.setup().click(look.getByRole('radio', { name: ACCENT_NAMES[to] }));
    await waitFor(() => expect(linked()).toEqual(installFiles(to)));
    expect(linked().manifest).not.toBe(installFiles(from).manifest);
  });
});
