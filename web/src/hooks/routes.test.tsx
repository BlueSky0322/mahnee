// @vitest-environment jsdom
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { FakeServer } from '../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../testing/app';

// Each page's address (?activity, ?plan, ?accounts, ?settings=...), and the older
// addresses that still open the page they became

setupAppTests();

const WALLET = 'a'.repeat(16);

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
  return server;
}

/** The app's clock reads Friday 6 November 2026, mid-morning, and still ticks */
function onTheSixth() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 6, 10, 0, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const pageTitle = (name: string) => screen.findByRole('heading', { name, level: 1 });

describe('addresses', () => {
  test('?activity opens Activity, with the search it holds today', async () => {
    renderApp(withWallet(), '/?activity');
    expect(await pageTitle('Activity')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search' })).toBeTruthy();
  });

  test('?search, the old address, opens Activity in its place', async () => {
    renderApp(withWallet(), '/?search');
    expect(await pageTitle('Activity')).toBeTruthy();
    expect(window.location.search).toBe('?activity');
  });

  test('?search keeps the rest of its address when it becomes ?activity', async () => {
    const before = window.history.length;
    renderApp(withWallet(), '/?search&q=kopi');
    expect(await pageTitle('Activity')).toBeTruthy();
    expect(window.location.search).toBe('?activity&q=kopi');
    // Replaced, so Back doesn't land on the old address and come straight back
    expect(window.history.length).toBe(before);
  });

  test('?activity&account= opens Activity, not the account', async () => {
    renderApp(withWallet(), `/?activity&account=${WALLET}`);
    expect(await pageTitle('Activity')).toBeTruthy();
    expect(window.location.search).toBe(`?activity&account=${WALLET}`);
  });

  test.each(['phone', 'desktop'] as const)(
    '?categories, the old address, opens Categories inside Settings (%s)',
    async (size) => {
      const before = window.history.length;
      renderApp(withWallet(), '/?categories', { size });
      expect(await pageTitle('Categories')).toBeTruthy();
      expect(window.location.search).toBe('?settings=categories');
      expect(window.history.length).toBe(before);
      const user = userEvent.setup();
      if (size === 'phone') {
        await user.click(screen.getByRole('button', { name: 'Settings' }));
        expect(await pageTitle('Settings')).toBeTruthy();
        expect(window.location.search).toBe('?settings');
      } else {
        // A pane of Settings, its section marked beside it
        const nav = within(screen.getByRole('navigation', { name: 'Settings' }));
        expect(nav.getByRole('link', { name: 'Categories' }).getAttribute('aria-current')).toBe(
          'page',
        );
      }
    },
  );

  test('?accounts opens Accounts, with each account and its balance', async () => {
    renderApp(withWallet(), '/?accounts');
    expect(await pageTitle('Accounts')).toBeTruthy();
    expect(await screen.findByRole('link', { name: /^Wallet, Cash, 100\.00$/ })).toBeTruthy();
  });

  /** Plan's month, as its header names it ("November 2026 · day 6 of 30" for this one) */
  const planMonth = (name: string) =>
    screen.findByText(new RegExp(`^${name}( · day \\d+ of \\d+)?$`));

  test('?plan opens Plan on this month', async () => {
    onTheSixth();
    renderApp(withWallet(), '/?plan');
    expect(await pageTitle('Plan')).toBeTruthy();
    expect(await screen.findByText('November 2026 · day 6 of 30')).toBeTruthy();
  });

  test('?plan&month= opens Plan on that month, and its arrows stay on Plan', async () => {
    onTheSixth();
    renderApp(withWallet(), '/?plan&month=2026-09');
    expect(await pageTitle('Plan')).toBeTruthy();
    expect(await planMonth('September 2026')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    expect(await planMonth('October 2026')).toBeTruthy();
    expect(window.location.search).toBe('?plan&month=2026-10');
    expect(await pageTitle('Plan')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    // This month's address names none
    expect(await planMonth('November 2026')).toBeTruthy();
    expect(window.location.search).toBe('?plan');
  });

  test('?plan&category= with text that names no category opens Plan itself', async () => {
    onTheSixth();
    renderApp(withWallet(), '/?plan&category=not-a-category', { size: 'phone' });
    expect(await pageTitle('Plan')).toBeTruthy();
    // A phone names the month short
    expect(await screen.findByText('Nov 2026')).toBeTruthy();
    expect(screen.queryByText('Category not found')).toBeNull();
  });

  test("Home keeps its month: an earlier one at ?month=, its arrows on Home's address", async () => {
    onTheSixth();
    renderApp(withWallet(), '/?month=2026-10');
    const month = (name: string) => screen.findByRole('heading', { level: 1, name });
    const arrow = (name: 'Previous month' | 'Next month') => screen.getByRole('button', { name });
    expect(await month('October 2026')).toBeTruthy();
    const user = userEvent.setup();
    await user.click(arrow('Previous month'));
    expect(await month('September 2026')).toBeTruthy();
    expect(window.location.search).toBe('?month=2026-09');
    await user.click(arrow('Next month'));
    expect(await month('October 2026')).toBeTruthy();
    await user.click(arrow('Next month'));
    expect(await month('November 2026')).toBeTruthy();
    expect(window.location.search).toBe('');
  });

  // Each section has its own page (its controls come with pieces 12, 13 and 16)
  test.each([
    ['money', 'Money'],
    ['adding', 'Adding entries'],
    ['look', 'Look and start'],
    ['budgets', 'Budgets and reminders'],
    ['account', 'My account'],
  ])('?settings=%s opens %s', async (section, title) => {
    renderApp(withWallet(), `/?settings=${section}`);
    expect(await pageTitle(title)).toBeTruthy();
  });

  test('an unknown section of Settings opens Settings itself', async () => {
    renderApp(withWallet(), '/?settings=nothing', { size: 'phone' });
    expect(await pageTitle('Settings')).toBeTruthy();
  });

  // A phone goes back up with its back link; a computer's import is a dialog over Import and
  // export (R-Desk-Import), closed with its X
  test.each([
    ['phone', 'Import and export'],
    ['desktop', 'Cancel import, nothing is saved'],
  ] as const)(
    "?import goes back up to Import and export, where it's opened from (%s)",
    async (size, back) => {
      renderApp(withWallet(), '/?import', { size });
      expect(await pageTitle('Import')).toBeTruthy();
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: back }));
      expect(await pageTitle('Import and export')).toBeTruthy();
      expect(window.location.search).toBe('?settings=data');
    },
  );
});
