// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test } from 'vitest';
import { ACCENTS } from '@shared/api';
import { ACCENT_NAMES } from '@shared/accents';
import { APPEARANCE_KEY } from '../profile/ProfileContext';
import { fakeServer, renderApp, setupAppTests } from '../testing/app';
import { launchDocument, openLaunchPage } from '../testing/launch-page';
import { installFiles } from './install-icons';

// Installing the app takes the accent chosen in Look and start: the page names that
// accent's manifest and iPhone icon, from the first moment (index.html's first script, from
// what the device kept) and as the accent changes, so an install prompt, Add to Home
// Screen, or Android's check on an installed app reads the icon in the accent.

/** Where the page points installing: its manifest and its iPhone icon */
const linked = () => ({
  manifest: document.querySelector('link[rel="manifest"]')?.getAttribute('href'),
  appleTouchIcon: document.querySelector('link[rel="apple-touch-icon"]')?.getAttribute('href'),
});

describe("index.html's first script", () => {
  function open(saved: unknown) {
    if (saved == null) localStorage.removeItem(APPEARANCE_KEY);
    else localStorage.setItem(APPEARANCE_KEY, JSON.stringify(saved));
    openLaunchPage('light');
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
    expect(open({ theme: 'light', accent: ['plum'] })).toEqual(installFiles('cobalt'));
  });
});

describe('the app', () => {
  setupAppTests();

  // The page the app runs in, with the links index.html gives it
  beforeEach(() => {
    document.head.innerHTML = launchDocument().head.innerHTML;
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

  test('switches install files when changing accents and when restoring the default', async () => {
    const user = userEvent.setup();
    renderApp(fakeServer(), '/?settings=look', { size: 'phone' });
    const look = within(await screen.findByRole('region', { name: 'Look and start' }));
    for (const accent of ['green', 'graphite', 'cobalt'] as const) {
      await user.click(look.getByRole('radio', { name: ACCENT_NAMES[accent] }));
      await waitFor(() => expect(linked()).toEqual(installFiles(accent)));
    }
  });
});
