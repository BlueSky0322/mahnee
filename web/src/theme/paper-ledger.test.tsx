// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, test } from 'vitest';
import { ACCENTS } from '@shared/api';
import { APPEARANCE_KEY } from '../profile/ProfileContext';
import { fakeServer, renderApp, setupAppTests } from '../testing/app';
import {
  TOKENS,
  addStyles,
  background,
  fontFamilies,
  mantineCss,
  resolve,
  textColour,
  tokensCss,
} from '../testing/css';

// The "Paper ledger" look (the design's R-System board): a warm paper ground, ink text,
// one cobalt accent for what you can tap, and Geist throughout. The page's own
// stylesheets (Mantine's, then the app's tokens, in the order Root.tsx imports them) are
// put in by hand, and colours are read through the cascade (testing/css.ts says how far
// that can be trusted; the piece's sweep checks the same in a browser).

setupAppTests();

const sheets = [mantineCss(), tokensCss()];

beforeEach(() => {
  const removeStyles = addStyles(sheets);
  const bar = document.createElement('meta');
  bar.name = 'theme-color';
  bar.content = '#000000';
  document.head.appendChild(bar);
  return () => {
    removeStyles();
    bar.remove();
  };
});

/** The app open on Home in `theme`, with `accent` saved to the account and on the device */
async function openIn(theme: 'light' | 'dark', accent: (typeof ACCENTS)[number] = 'cobalt') {
  const server = fakeServer();
  server.me.settings.theme = theme;
  server.me.settings.accent = accent;
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme, accent }));
  renderApp(server, '/?accounts');
  await waitFor(() =>
    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe(theme),
  );
  return screen.findByRole('button', { name: 'Add account' });
}

/** The Add account sheet, opened from Home */
async function openAddAccount(theme: 'light' | 'dark') {
  await userEvent.click(await openIn(theme));
  return within(await screen.findByRole('dialog'));
}

describe.each(['light', 'dark'] as const)('the %s theme', (theme) => {
  test("every colour is the design's", async () => {
    await openIn(theme);
    const root = getComputedStyle(document.documentElement);
    const shown = Object.fromEntries(
      Object.keys(TOKENS[theme]).map((name) => [
        name,
        root.getPropertyValue(name).trim().toLowerCase(),
      ]),
    );
    expect(shown).toEqual(TOKENS[theme]);
  });

  test('the page is the paper ground, with ink text', async () => {
    await openIn(theme);
    expect(background(document.body)).toBe(TOKENS[theme]['--ground']);
    expect(textColour(document.body)).toBe(TOKENS[theme]['--ink']);
  });

  test('the page is set in Geist, not Inter', async () => {
    await openIn(theme);
    const families = fontFamilies(document.body);
    expect(families[0]).toBe('Geist');
    expect(families).not.toContain('Inter');
  });

  test("Mantine's buttons and fields are set in Geist too", async () => {
    const root = document.documentElement;
    const button = await openIn(theme);
    const mantineFont = resolve('var(--mantine-font-family)', root).split(',')[0].trim();
    expect(mantineFont.replace(/['"]/g, '')).toBe('Geist');
    expect(fontFamilies(button)[0]).toBe('Geist');
    expect(fontFamilies(button)).not.toContain('Inter');

    await userEvent.click(button);
    const sheet = within(await screen.findByRole('dialog'));
    const field = sheet.getByRole('textbox', { name: /name/i });
    expect(fontFamilies(field)[0]).toBe('Geist');
    expect(fontFamilies(field)).not.toContain('Inter');
  });

  test("the phone's status bar takes the ground", async () => {
    await openIn(theme);
    await waitFor(() =>
      expect(document.querySelector('meta[name="theme-color"]')?.getAttribute('content')).toBe(
        TOKENS[theme]['--ground'],
      ),
    );
  });

  // Each saved accent fills primary buttons in its own colour (Look and start, R-Set-Look):
  // the light shades are the design's swatches, the dark ones (but Cobalt's) this change's
  // own. Owner decision D14 built the accent setting; until then every accent was cobalt.
  const ACCENT_FILLS = {
    cobalt: { light: '#2d4bd8', dark: '#93a5ff' },
    green: { light: '#1b7a52', dark: '#6cc59a' },
    plum: { light: '#8a3c8f', dark: '#d494d8' },
    rust: { light: '#b04a1c', dark: '#f0956a' },
    graphite: { light: '#3f4248', dark: '#c4c6cd' },
  } as const;
  test.each(ACCENTS)('a primary button is filled with the accent saved, %s', async (accent) => {
    const button = await openIn(theme, accent);
    await waitFor(() => expect(background(button)).toBe(ACCENT_FILLS[accent][theme]));
    expect(textColour(button)).toBe(TOKENS[theme]['--accent-ink']);
  });

  test("a sheet's primary button is filled the same way", async () => {
    const sheet = await openAddAccount(theme);
    const save = sheet.getByRole('button', { name: 'Add account' });
    expect(background(save)).toBe(TOKENS[theme]['--accent']);
    expect(textColour(save)).toBe(TOKENS[theme]['--accent-ink']);
  });
});
