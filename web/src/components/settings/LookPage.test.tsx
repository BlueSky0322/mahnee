// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Accent, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { APPEARANCE_KEY } from '../../profile/ProfileContext';
import type { FakeServer } from '../../testing/app';
import { fakeServer, reloadApp, renderApp, setupAppTests } from '../../testing/app';
import {
  TOKENS,
  addStyles,
  moduleCss,
  readBeside,
  resolve,
  textColour,
  tokensCss,
} from '../../testing/css';
import activityCss from '../activity/Activity.module.css';
import accountsCss from '../accounts/AccountsPage.module.css';

// Look and start (R-Set-Look, R-Desk-Set-Look; digest 3.14; owner decisions D13-D15): the
// theme, the accent, the colour of spending, how much Home shows and which page the app
// opens on, each saved to the account at once. The theme's one-tap switch leaves Home's
// header for this page. Names and figures are made up.

setupAppTests();

// A day in January: the entry below is from this month, so Activity lists it
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 0, 10, 10, 0, 0));
});
afterEach(() => vi.useRealTimers());

beforeEach(() =>
  addStyles([
    tokensCss(),
    moduleCss(readBeside('../activity/Activity.module.css', import.meta.url), activityCss),
    moduleCss(readBeside('../accounts/AccountsPage.module.css', import.meta.url), accountsCss),
  ]),
);

const SIZES = ['phone', 'desktop'] as const;
const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;
const SALARY = DEFAULT_CATEGORIES.find((c) => c.name === 'Salary')!.id;

/** How far apart two colours are to read, by WCAG's contrast ratio (1 to 21) */
function contrast(a: string, b: string) {
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => {
      const c = parseInt(hex.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Each accent as Look and start draws it (R-Set-Look's swatches) and as the app is then
 * drawn: the light theme's colour is the design's own; only Cobalt has a dark shade on the
 * boards, so the others' are this change's (digest section 1: "The other four need dark
 * shades worked out")
 */
const ACCENT_COLOURS: Record<Accent, { name: string; light: string; dark: string }> = {
  cobalt: { name: 'Cobalt', light: '#2d4bd8', dark: '#93a5ff' },
  green: { name: 'Green', light: '#1b7a52', dark: '#6cc59a' },
  plum: { name: 'Plum', light: '#8a3c8f', dark: '#d494d8' },
  rust: { name: 'Rust', light: '#b04a1c', dark: '#f0956a' },
  graphite: { name: 'Graphite', light: '#3f4248', dark: '#c4c6cd' },
};

function withWallet(): FakeServer {
  const server = fakeServer();
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 10_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const spent: Transaction = {
    id: 'd'.repeat(16),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 725,
    categoryId: FOOD,
    payee: 'Kiosk',
    note: null,
    date: '2026-01-09',
    createdAt: 1,
  };
  server.accounts.push({
    id: BANK,
    name: 'Bank',
    kind: 'bank',
    currency: 'MYR',
    openingCents: 100_000,
    position: 1,
    archived: false,
  });
  // RM 50.00 of pay into Wallet, and RM 30.00 moved from Bank to Wallet, the same day
  server.transactions.push(
    spent,
    {
      ...spent,
      id: 'e'.repeat(16),
      kind: 'income',
      amountCents: 5_000,
      categoryId: SALARY,
      payee: 'Acme',
      createdAt: 2,
    },
    {
      ...spent,
      id: 'f'.repeat(16),
      kind: 'transfer',
      accountId: BANK,
      toAccountId: WALLET,
      amountCents: 3_000,
      categoryId: null,
      payee: 'Top-up',
      createdAt: 3,
    },
  );
  return server;
}

async function openLook(server: FakeServer, size: (typeof SIZES)[number]) {
  renderApp(server, '/?settings=look', { size });
  await screen.findByRole('heading', { name: 'Look and start', level: 1 });
  return within(await screen.findByRole('region', { name: 'Look and start' }));
}

const checked = (group: HTMLElement) =>
  within(group)
    .getAllByRole('radio')
    .filter((r) => r.getAttribute('aria-checked') === 'true' || (r as HTMLInputElement).checked)
    .map((r) => r.getAttribute('aria-label') ?? r.textContent);

const rootAccent = () => resolve('var(--accent)', document.documentElement).toLowerCase();

describe.each(SIZES)('Look and start (%s)', (size) => {
  test('shows each setting as drawn, before anything is chosen', async () => {
    const page = await openLook(withWallet(), size);
    const named = (phone: string, desktop: string) =>
      page.getByRole('radiogroup', { name: size === 'desktop' ? desktop : phone });
    const theme = page.getByRole('radiogroup', { name: 'Theme' });
    const auto = size === 'desktop' ? 'Match device' : 'Match phone';
    expect(
      within(theme)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Light', 'Dark', auto]);
    expect(checked(theme)).toEqual([auto]);
    expect(page.getByText('Saved to your account')).toBeTruthy();

    const accent = page.getByRole('radiogroup', { name: 'Accent' });
    expect(
      within(accent)
        .getAllByRole('radio')
        .map((r) => r.getAttribute('aria-label')),
    ).toEqual(['Cobalt', 'Green', 'Plum', 'Rust', 'Graphite']);
    expect(checked(accent)).toEqual(['Cobalt']);
    expect(page.getByText('Buttons and links')).toBeTruthy();

    const colour = named('Expenses and income', 'Expense colour');
    expect(
      within(colour)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Expenses in ink', 'Expenses in red']);
    expect(checked(colour)).toEqual(['Expenses in ink']);
    expect(page.getByText('Income is always green with a plus')).toBeTruthy();

    const shows = named('Home shows', 'Home density');
    expect(
      within(shows)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Essentials', 'Everything']);
    expect(checked(shows)).toEqual(['Everything']);
    expect(page.getByText('Month end only, or everything')).toBeTruthy();

    const start = named('Open the app on', 'Start screen');
    expect(
      within(start)
        .getAllByRole('radio')
        .map((r) => r.textContent),
    ).toEqual(['Home', 'Activity', 'Plan']);
    expect(checked(start)).toEqual(['Home']);
    expect(page.getByText('Where you land each time')).toBeTruthy();
  });

  test('Theme: Dark is saved and shown at once, and Light after it', async () => {
    const server = withWallet();
    const page = await openLook(server, size);
    const user = userEvent.setup();
    await user.click(page.getByRole('radio', { name: 'Dark' }));
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark'),
    );
    await waitFor(() => expect(server.me.settings.theme).toBe('dark'));
    await user.click(page.getByRole('radio', { name: 'Light' }));
    await waitFor(() =>
      expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('light'),
    );
    await waitFor(() => expect(server.me.settings.theme).toBe('light'));
    await user.click(
      page.getByRole('radio', { name: size === 'desktop' ? 'Match device' : 'Match phone' }),
    );
    await waitFor(() => expect(server.me.settings.theme).toBe('auto'));
  });

  test('a theme that could not be saved goes back, and says so', async () => {
    const server = withWallet();
    server.me.settings.theme = 'dark';
    const page = await openLook(server, size);
    server.failNext.profile = 500;
    await userEvent.setup().click(page.getByRole('radio', { name: 'Light' }));
    expect(await screen.findByText('Something went wrong. Try again in a moment.')).toBeTruthy();
    await waitFor(() =>
      expect(checked(page.getByRole('radiogroup', { name: 'Theme' }))).toEqual(['Dark']),
    );
    expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe('dark');
    expect(server.me.settings.theme).toBe('dark');
  });

  test.each(['green', 'plum', 'rust', 'graphite', 'cobalt'] as const)(
    'Accent: %s is saved, kept on the device and drawn at once',
    async (accent) => {
      const server = withWallet();
      // Start from another, so picking this one changes something
      server.me.settings.accent = accent === 'cobalt' ? 'rust' : 'cobalt';
      server.me.settings.theme = 'light';
      const page = await openLook(server, size);
      const { name, light } = ACCENT_COLOURS[accent];
      await userEvent.setup().click(page.getByRole('radio', { name }));
      expect(checked(page.getByRole('radiogroup', { name: 'Accent' }))).toEqual([name]);
      await waitFor(() => expect(rootAccent()).toBe(light));
      await waitFor(() => expect(server.me.settings.accent).toBe(accent));
      expect(JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '{}')).toMatchObject({ accent });
    },
  );

  test('Expenses in red colours spending red where entries are listed; income stays green', async () => {
    const server = withWallet();
    server.me.settings.theme = 'light';
    const page = await openLook(server, size);
    await userEvent.setup().click(page.getByRole('radio', { name: 'Expenses in red' }));
    await waitFor(() => expect(server.me.settings.expenseColour).toBe('red'));
    await reloadApp(server, '/?activity', { size });
    const results = within(await screen.findByRole('region', { name: 'Results' }));
    await waitFor(async () =>
      expect(textColour(await results.findByText('−7.25'))).toBe(TOKENS.light['--neg']),
    );
    // Income is always green with a plus; a transfer stays grey with no sign
    expect(textColour(results.getByText('+50.00'))).toBe(TOKENS.light['--pos']);
    expect(textColour(results.getByText('30.00'))).toBe(TOKENS.light['--ink-3']);
    if (size === 'desktop') {
      // The open entry's own figure beside the register, too
      await userEvent.setup().click(screen.getByRole('button', { name: 'Kiosk' }));
      const pane = within(await screen.findByRole('complementary', { name: /^Kiosk, / }));
      expect(textColour(pane.getByText('−RM 7.25'))).toBe(TOKENS.light['--neg']);
    }
  });

  test('Home shows and Open the app on are saved', async () => {
    const server = withWallet();
    const page = await openLook(server, size);
    const user = userEvent.setup();
    await user.click(page.getByRole('radio', { name: 'Essentials' }));
    await user.click(page.getByRole('radio', { name: 'Plan' }));
    await waitFor(() => expect(server.me.settings.homeDensity).toBe('essentials'));
    await waitFor(() => expect(server.me.settings.startScreen).toBe('plan'));
    const shows = page.getByRole('radiogroup', {
      name: size === 'desktop' ? 'Home density' : 'Home shows',
    });
    expect(checked(shows)).toEqual(['Essentials']);
  });

  test("Home's header has no theme switch: the theme lives here", async () => {
    renderApp(withWallet(), '/', { size });
    if (size === 'phone') await screen.findByRole('region', { name: 'Expected at month end' });
    else await screen.findByRole('region', { name: /at a glance$/ });
    expect(screen.queryByRole('button', { name: /^Switch to (light|dark) mode$/ })).toBeNull();
  });
});

describe.each(['light', 'dark'] as const)('accents drawn on the %s theme', (theme) => {
  test.each(Object.keys(ACCENT_COLOURS) as Accent[])(
    'a saved %s draws the accent and its tint',
    async (accent) => {
      const server = withWallet();
      server.me.settings.theme = theme;
      server.me.settings.accent = accent;
      localStorage.setItem(APPEARANCE_KEY, JSON.stringify({ theme, accent }));
      renderApp(server, '/?plan');
      await waitFor(() =>
        expect(document.documentElement.getAttribute('data-mantine-color-scheme')).toBe(theme),
      );
      await waitFor(() => expect(rootAccent()).toBe(ACCENT_COLOURS[accent][theme]));
      // The tint (a picked chip, the New tag) is the accent's own, never cobalt's on another,
      // and the accent's words on it read clearly (4.5:1)
      const tint = resolve('var(--accent-tint)', document.documentElement).toLowerCase();
      expect(tint).toMatch(/^#[0-9a-f]{6}$/);
      if (accent === 'cobalt') expect(tint).toBe(TOKENS[theme]['--accent-tint']);
      else expect(tint).not.toBe(TOKENS[theme]['--accent-tint']);
      expect(contrast(ACCENT_COLOURS[accent][theme], tint)).toBeGreaterThanOrEqual(4.5);
      // Words on a filled button read clearly too
      const ink = resolve('var(--accent-ink)', document.documentElement).toLowerCase();
      expect(contrast(ACCENT_COLOURS[accent][theme], ink)).toBeGreaterThanOrEqual(4.5);
    },
  );
});

describe('expense colour on an account page', () => {
  test.each(
    SIZES.flatMap((size) => (['ink', 'red'] as const).map((colour) => [size, colour] as const)),
  )('%s, expenses in %s', async (size, colour) => {
    const server = withWallet();
    server.me.settings.theme = 'light';
    server.me.settings.expenseColour = colour;
    renderApp(server, `/?account=${WALLET}`, { size });
    // A phone's row is one button; a computer's register row holds the payee's button
    const rowOf = async (payee: string) =>
      size === 'phone'
        ? screen.findByRole('button', { name: new RegExp(`^${payee}, `) })
        : (await screen.findByRole('button', { name: payee })).closest('tr')!;
    const amount = within(await rowOf('Kiosk')).getByText(/7\.25/);
    expect(textColour(amount)).toBe(TOKENS.light[colour === 'red' ? '--neg' : '--ink']);
    // Pay into it stays green whichever is chosen
    expect(textColour(within(await rowOf('Acme')).getByText(/50\.00/))).toBe(TOKENS.light['--pos']);
  });
});
