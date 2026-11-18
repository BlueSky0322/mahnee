// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { HomeDensity, Recurring } from '@shared/api';
import { DEFAULT_CATEGORIES, OTHER_EXPENSE_ID } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';
import type { ComingUpRow } from './ComingUp';
import { essentialRows } from './home-text';

// "Home shows" (R-Set-Look; owner decision D13): Essentials is "the month-end figure, Tidy
// up, amounts to check and the next scheduled item. The two cards, calendar and budgets
// hide." Everything is the full Home as drawn. Amounts to check are flagged by Scheduled
// (built later); here their place is checked against fixed rows. Figures are made up.

// Where the person is, set before any date is made
vi.hoisted(() => {
  process.env.TZ = 'Asia/Kuala_Lumpur';
});

setupAppTests();

const SIZES = ['phone', 'desktop'] as const;
const BANK = 'b'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, BILLS] = [id('Food'), id('Bills')];

/** 10 November 2026, mid-morning where the person is */
function onTheTenth() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 10, 0, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

let made = 0;
const repeating = (payee: string, more: Partial<Recurring>): Recurring => ({
  id: (++made).toString(16).padStart(16, 'e'),
  kind: 'expense',
  accountId: BANK,
  toAccountId: null,
  amountCents: 1_000,
  categoryId: BILLS,
  payee,
  schedule: 'monthly',
  day: 1,
  startDate: '2026-10-01',
  nextDue: '2026-11-01',
  archived: false,
  ...more,
});

/**
 * Maybank with RM 1,000, RM 20 spent on Food and RM 5 left in Other this month, TNB due on
 * the 20th and Water on the 22nd, and a budget on Food
 */
function aMonth(density: HomeDensity): FakeServer {
  const server = fakeServer();
  server.me.settings.homeDensity = density;
  server.accounts.push({
    id: BANK,
    name: 'Maybank',
    kind: 'bank',
    currency: 'MYR',
    openingCents: 100_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const spent = (n: number, amountCents: number, categoryId: string) =>
    server.transactions.push({
      id: n.toString(16).padStart(16, '0'),
      kind: 'expense',
      accountId: BANK,
      toAccountId: null,
      amountCents,
      categoryId,
      payee: null,
      note: null,
      date: '2026-11-03',
      createdAt: n,
    });
  spent(1, 2_000, FOOD);
  spent(2, 500, OTHER_EXPENSE_ID);
  server.recurring.push(
    repeating('TNB electricity', { amountCents: 18_900, day: 20, nextDue: '2026-11-20' }),
    repeating('Water', { amountCents: 2_100, day: 22, nextDue: '2026-11-22' }),
  );
  server.budgets.push({
    categoryId: FOOD,
    fromMonth: '2026-11',
    amountCents: 6_000,
    carryOver: false,
  });
  return server;
}

/** The month-end figure: its own section on a phone, the first of the glance on a computer */
async function monthEnd(size: (typeof SIZES)[number]) {
  if (size === 'phone') return screen.findByRole('region', { name: 'Expected at month end' });
  const glance = await screen.findByRole('region', { name: /at a glance$/ });
  return within(glance).getByRole('link', { name: /^Expected at month end/ });
}

const tidyUp = () =>
  screen.queryAllByRole('status').find((s) => /still in Other/.test(s.textContent ?? '')) ?? null;

const comingRows = () =>
  within(within(screen.getByRole('region', { name: 'Coming up' })).getByRole('list'))
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe.each(SIZES)('Home shows (%s)', (size) => {
  test('Essentials: the month end, Tidy up and (on a computer) the next scheduled item, nothing else', async () => {
    onTheTenth();
    renderApp(aMonth('essentials'), '/', { size });
    const hero = await monthEnd(size);
    // RM 975.00 today, less RM 189.00 and RM 21.00 of bills
    await waitFor(() => expect(hero.textContent).toContain('RM 765.00'));
    await waitFor(() => expect(tidyUp()).not.toBeNull());
    if (size === 'desktop') {
      await waitFor(() => expect(comingRows()).toHaveLength(1));
      expect(comingRows()[0]).toMatch(/^TNB electricity/);
    } else {
      // A phone's Home has no Coming up (R-Home; owner, 2026-11-18)
      expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();
    }
    // The two cards, the calendar and the budgets are hidden
    expect(screen.queryByRole('link', { name: /^Expenses so far/ })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Income/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Day by day' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Budgets' })).toBeNull();
    expect(screen.queryByRole('grid')).toBeNull();
  });

  test('Everything: the full Home, as drawn', async () => {
    onTheTenth();
    renderApp(aMonth('everything'), '/', { size });
    const hero = await monthEnd(size);
    await waitFor(() => expect(hero.textContent).toContain('RM 765.00'));
    expect(await screen.findByRole('link', { name: /^Expenses so far/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /^Income/ })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Day by day' })).toBeTruthy();
    expect(await screen.findByRole('region', { name: 'Budgets' })).toBeTruthy();
    if (size === 'desktop') await waitFor(() => expect(comingRows()).toHaveLength(2));
    else expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();
    expect(tidyUp()).not.toBeNull();
  });

  test('Essentials keeps what is due now, to log or skip', async () => {
    onTheTenth();
    const server = aMonth('essentials');
    // Rent was due today, and asks first (D19)
    server.recurring.push(
      repeating('Rent', { amountCents: 5_000, day: 10, nextDue: '2026-11-10', askFirst: true }),
    );
    renderApp(server, '/', { size });
    const due = await screen.findByText('Due: Rent RM 50.00 from Maybank');
    const row = within(screen.getByRole('group', { name: due.textContent ?? '' }));
    expect(row.getByRole('button', { name: 'Log it' })).toBeTruthy();
    expect(row.getByRole('button', { name: 'Skip' })).toBeTruthy();
  });

  test('Essentials keeps Getting started on a first day', async () => {
    onTheTenth();
    const server = fakeServer();
    server.me.settings.homeDensity = 'essentials';
    server.accounts.push({
      id: BANK,
      name: 'Maybank',
      kind: 'bank',
      currency: 'MYR',
      openingCents: 500_000,
      position: 0,
      archived: false,
    });
    renderApp(server, '/', { size });
    const started = await screen.findByRole('region', { name: 'Getting started' });
    await waitFor(() => expect(started.textContent).toContain('1 of 5 done'));
    expect(screen.queryByRole('region', { name: 'Day by day' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Budgets' })).toBeNull();
  });

  test('Essentials for an earlier month: what it left, and nothing else', async () => {
    onTheTenth();
    renderApp(aMonth('essentials'), '/?month=2026-10', { size });
    expect(
      await (size === 'phone'
        ? screen.findByRole('region', { name: 'Left in October' })
        : screen.findByRole('link', { name: /^Left in October/ })),
    ).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Day by day' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Budgets' })).toBeNull();
    expect(screen.queryByRole('link', { name: /^Expenses so far/ })).toBeNull();
    // Tidy up and Coming up are this month's, as on the full Home
    expect(tidyUp()).toBeNull();
    expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();
  });
});

describe('what Coming up lists on Essentials', () => {
  const row = (n: number, toCheck = false): ComingUpRow => ({
    id: String(n),
    name: `Item ${n}`,
    kind: 'expense',
    amountCents: 100 * n,
    date: `2026-11-${10 + n}`,
    where: 'Maybank',
    toCheck,
  });

  test('the next scheduled item alone', () => {
    expect(essentialRows([row(1), row(2), row(3)]).map((r) => r.id)).toEqual(['1']);
  });

  test('and every amount to check, in their order', () => {
    expect(essentialRows([row(1), row(2, true), row(3), row(4, true)]).map((r) => r.id)).toEqual([
      '1',
      '2',
      '4',
    ]);
  });

  test('nothing scheduled, nothing listed', () => {
    expect(essentialRows([])).toEqual([]);
  });
});
