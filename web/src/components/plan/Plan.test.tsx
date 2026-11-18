// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from 'idb-keyval';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Category, Recurring, Transaction } from '@shared/api';
import type { BudgetRow } from '@shared/budgets';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addEntry,
  fakeServer,
  goToPlace,
  holdNext,
  reloadApp,
  renderApp,
  setupAppTests,
} from '../../testing/app';
import { outboxKey } from '../../offline/outbox';
import { queryClient } from '../../query-client';

// Plan (R-Plan, R-Desk-Plan; R-Empty-Plan, R-Desk-Empty-Plan; digest 3.6, 4.3, 4.4): the
// month's budgets with a today marker and carry-over, where the spending went with a share
// bar and a subtitle for each category, and what came in. On a computer, a table of every
// spending category with its budget, and the chosen category open on the right, its budget
// changed there. Scheduled is Plan's other half (rebuilt later; for now the month-end
// total and every repeating item).

// Where the person is: Malaysia, eight hours ahead of UTC. The clock reads 00:30 on Tuesday
// 10 November there, still the 9th in UTC, so a day or month taken from UTC is wrong.
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const RYAN = 'ryan@example.com';
const SIZES = ['desktop', 'phone'] as const;
const CASH = 'c'.repeat(16);
const BANK = 'b'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, GROCERIES, BILLS, SHOPPING, HEALTH, FUN, SALARY] = [
  'Food',
  'Transport',
  'Groceries',
  'Bills',
  'Shopping',
  'Health',
  'Fun',
  'Salary',
].map(id);
const DINING = 'd1'.padEnd(16, '0');
const COFFEE = 'c1'.padEnd(16, '0');
const PETROL = 'e1'.padEnd(16, '0');

/** The app's clock reads 00:30 on 10 November 2026 where the person is, and still ticks */
function tenthJustAfterMidnight() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 0, 30, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const sub = (catId: string, name: string, parentId: string): Category => ({
  id: catId,
  name,
  kind: 'expense',
  parentId,
  position: 0,
  archived: false,
});

let seeded = 0;
function entry(
  server: FakeServer,
  date: string,
  amountCents: number,
  categoryId: string | null,
  more: Partial<Transaction> = {},
) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: CASH,
    toAccountId: null,
    amountCents,
    categoryId,
    payee: null,
    note: null,
    date,
    createdAt: seeded,
    ...more,
  });
}

const salaryDue = (): Recurring => ({
  id: 'f'.repeat(16),
  kind: 'income',
  accountId: BANK,
  toAccountId: null,
  amountCents: 680_000,
  categoryId: SALARY,
  payee: 'Salary',
  schedule: 'monthly',
  day: 25,
  startDate: '2026-10-25',
  nextDue: '2026-11-25',
  archived: false,
});

/** Cash with RM 2,000 and Maybank with RM 5,000, the defaults, nothing logged */
function twoAccounts() {
  const server = fakeServer();
  server.accounts.push(
    {
      id: CASH,
      name: 'Cash',
      kind: 'cash',
      currency: 'MYR',
      openingCents: 200_000,
      position: 0,
      archived: false,
    },
    {
      id: BANK,
      name: 'Maybank',
      kind: 'bank',
      currency: 'MYR',
      openingCents: 500_000,
      position: 1,
      archived: false,
    },
  );
  server.categories = [
    ...DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    sub(DINING, 'Dining out', FOOD),
    sub(COFFEE, 'Coffee', FOOD),
    sub(PETROL, 'Petrol', TRANSPORT),
  ];
  return server;
}

/**
 * November under way: RM 1,650.50 spent and RM 3,000.00 in, Salary next due on the 25th.
 * Rent RM 1,200.00 (Bills, one entry); Groceries RM 180.00 (3); Shopping RM 150.00 (2); Food
 * RM 84.00 (Dining out RM 60.00 in 2, Coffee RM 15.00 at Kopi, RM 9.00 on Food itself);
 * Transport RM 30.00 (Petrol at Shell); Health RM 6.00 (1, no payee); Fun RM 0.50 at
 * Arcade. Food also had RM 250.00 in October and RM 100.00 in September. Budgets: Food RM
 * 300.00 from October with Carry over (October left RM 50.00, carried in), Transport RM 20.00
 * and Shopping RM 160.00 from November. RM 500.00 moved from Cash to Maybank on the 3rd.
 */
function aPlannedMonth() {
  const server = twoAccounts();
  entry(server, '2026-11-01', 120_000, BILLS, { accountId: BANK, payee: 'Rent' });
  entry(server, '2026-11-02', 10_000, GROCERIES);
  entry(server, '2026-11-03', 5_000, GROCERIES);
  entry(server, '2026-11-04', 3_000, GROCERIES);
  entry(server, '2026-11-05', 12_000, SHOPPING);
  entry(server, '2026-11-06', 3_000, SHOPPING);
  entry(server, '2026-11-02', 4_000, DINING);
  entry(server, '2026-11-07', 2_000, DINING);
  entry(server, '2026-11-08', 1_500, COFFEE, { payee: 'Kopi' });
  entry(server, '2026-11-09', 900, FOOD);
  entry(server, '2026-11-03', 3_000, PETROL, { payee: 'Shell' });
  entry(server, '2026-11-04', 600, HEALTH);
  entry(server, '2026-11-10', 50, FUN, { payee: 'Arcade' });
  entry(server, '2026-11-05', 300_000, SALARY, { kind: 'income', accountId: BANK });
  entry(server, '2026-10-12', 25_000, FOOD);
  entry(server, '2026-09-15', 10_000, FOOD);
  // Money moved between accounts: never spending, so no total, share or row counts it
  entry(server, '2026-11-03', 50_000, null, {
    kind: 'transfer',
    accountId: CASH,
    toAccountId: BANK,
  });
  server.recurring.push(salaryDue());
  server.budgets.push(
    { categoryId: FOOD, fromMonth: '2026-10', amountCents: 30_000, carryOver: true },
    { categoryId: TRANSPORT, fromMonth: '2026-11', amountCents: 2_000, carryOver: false },
    { categoryId: SHOPPING, fromMonth: '2026-11', amountCents: 16_000, carryOver: false },
  );
  return server;
}

/** What an element says, each piece of text on its own separated by a space */
function text(el: HTMLElement) {
  const parts: string[] = [];
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node != null; node = walker.nextNode()) {
    const words = node.textContent?.replace(/\s+/g, ' ').trim();
    if (words) parts.push(words);
  }
  return parts.join(' ');
}

const items = (list: HTMLElement) => within(list).getAllByRole('listitem').map(text);

const budgetsOf = (server: FakeServer): BudgetRow[] => server.budgets;

/** Plan's budgets on a phone, once shown */
const budgetsRegion = () => screen.findByRole('region', { name: /^Budgets/ });

/** "Where it went", once shown */
const whereItWent = () => screen.findByRole('region', { name: /^Where it went/ });

/**
 * The month's spending as Plan says it: "Where it went" and its total on a phone, "RM x
 * spent" over the table on a computer; null while it isn't shown
 */
function spentShown(size: string) {
  if (size === 'desktop') {
    const section = screen.queryByRole('region', { name: 'Expenses by category' });
    return section == null
      ? null
      : within(section).queryByText(/^RM [\d,.]+ spent$/)?.textContent ?? null;
  }
  const went = screen.queryByRole('region', { name: /^Where it went/ });
  return went == null ? null : /^Where it went (RM [\d,.]+)/.exec(text(went))?.[1] ?? null;
}

/** On a computer, the table of every spending category */
const expensesTable = () => screen.findByRole('table', { name: 'Expenses by category' });

/** The table's rows, each as its cells read, the header row left out */
const tableRows = (table: HTMLElement) =>
  within(table)
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .map(text)
        .filter((cell) => cell !== '')
        .join(' | '),
    );

/** On a computer, the category open on the right */
const pane = (name: string) => screen.findByRole('complementary', { name });

/** Offline, as the browser says; answers how to be back */
function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  onTestFinished(() => onLine.mockRestore());
  act(() => void window.dispatchEvent(new Event('offline')));
  return () => {
    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
  };
}

const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('Plan: budgets and where it went', () => {
  test.each(SIZES)(
    'names the page and its month, with Budgets and Scheduled, and arrows back but not past this one (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aPlannedMonth(), '/?plan', { size });
      expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeTruthy();
      expect(
        await screen.findByText(size === 'phone' ? 'Nov 2026' : 'November 2026 · day 10 of 30'),
      ).toBeTruthy();
      const halves = screen.getByRole('navigation', { name: 'Plan' });
      const budgets = within(halves).getByRole('link', { name: 'Budgets' });
      expect(budgets.getAttribute('aria-current')).toBe('page');
      expect(budgets.getAttribute('href')).toBe('?plan');
      const scheduled = within(halves).getByRole('link', { name: 'Scheduled' });
      expect(scheduled.getAttribute('aria-current')).toBeNull();
      expect(scheduled.getAttribute('href')).toBe('?plan=scheduled');

      expect(screen.getByRole('button', { name: 'Next month' }).hasAttribute('disabled')).toBe(
        true,
      );
      await userEvent.setup().click(screen.getByRole('button', { name: 'Previous month' }));
      await waitFor(() => expect(window.location.search).toBe('?plan&month=2026-10'));
      expect(await screen.findByText(size === 'phone' ? 'Oct 2026' : 'October 2026')).toBeTruthy();
    },
  );

  test.each(['phone', 'tablet'] as const)(
    "lists each budget with what's left, a bar against the month, and carry-over (%s)",
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aPlannedMonth(), '/?plan', { size });
      const budgets = await budgetsRegion();
      expect(within(budgets).getByText('Day 10 of 30')).toBeTruthy();
      expect(within(budgets).getByRole('link', { name: 'Budget' }).getAttribute('href')).toBe(
        '?settings=categories',
      );
      // In the categories' order. Food: RM 300.00 and RM 50.00 carried, RM 84.00 spent.
      // Transport: RM 30.00 of RM 20.00. Shopping: RM 150.00 of RM 160.00 by day 10 of 30.
      await waitFor(() =>
        expect(items(within(budgets).getByRole('list'))).toEqual([
          'Food RM 266.00 left RM 84.00 of RM 350.00 incl. RM 50.00 carried over',
          'Transport RM 10.00 over RM 30.00 of RM 20.00 · over',
          'Shopping RM 10.00 left RM 150.00 of RM 160.00 · faster than the month',
        ]),
      );
      for (const name of ['Food: 24% spent', 'Transport: 150% spent', 'Shopping: 94% spent']) {
        expect(within(budgets).getByRole('meter', { name })).toBeTruthy();
      }
    },
  );

  test.each(['phone', 'tablet'] as const)(
    'shows where the spending went, largest first, each row opening its category (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aPlannedMonth(), '/?plan', { size });
      const went = await whereItWent();
      await waitFor(() => expect(within(went).getByText('RM 1,650.50')).toBeTruthy());
      expect(
        within(went).getByRole('img', {
          name: 'Share of expenses: Bills 73%, Groceries 11%, Shopping 9%, Food 5%, Transport 2%, Health under 1%, Fun under 1%',
        }),
      ).toBeTruthy();
      const rows = within(went).getAllByRole('link');
      expect(rows.map(text)).toEqual([
        'Bills 73% · Rent 1,200.00',
        'Groceries 11% · 3 entries 180.00',
        'Shopping 9% · 2 entries 150.00',
        'Food 5% · Dining out 60.00, Coffee 15.00, Food 9.00 84.00',
        'Transport 2% · Petrol 30.00 30.00',
        'Health under 1% · 1 entry 6.00',
        'Fun under 1% · Arcade 0.50',
      ]);
      expect(rows[3].getAttribute('href')).toBe(`?plan&category=${FOOD}`);

      // A category opens as its own page: the browser's Back returns, and so does "Plan"
      const user = userEvent.setup();
      await user.click(rows[3]);
      expect(await screen.findByRole('heading', { level: 1, name: 'Food' })).toBeTruthy();
      expect(window.location.search).toBe(`?plan&category=${FOOD}`);
      act(() => window.history.back());
      expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeTruthy();
      expect(window.location.search).toBe('?plan');
      await user.click(within(await whereItWent()).getByRole('link', { name: /^Food/ }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Food' })).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Plan' }));
      expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeTruthy();
      expect(window.location.search).toBe('?plan');
    },
  );

  test.each(SIZES)('shows what came in, and when the next pay is due (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(aPlannedMonth(), '/?plan', { size });
    const income = await screen.findByRole('region', { name: 'Income' });
    await waitFor(() => expect(text(income)).toContain('RM 3,000.00'));
    expect(within(income).getByText('Salary due Nov 25')).toBeTruthy();
  });

  test('on a computer, a table of every spending category with its budget and what is left', async () => {
    tenthJustAfterMidnight();
    renderApp(aPlannedMonth(), '/?plan', { size: 'desktop' });
    const section = await screen.findByRole('region', { name: 'Expenses by category' });
    await waitFor(() => expect(within(section).getByText('RM 1,650.50 spent')).toBeTruthy());
    expect(
      within(section).getByRole('link', { name: 'Edit categories' }).getAttribute('href'),
    ).toBe('?settings=categories');
    const table = await expensesTable();
    expect(within(table).getAllByRole('columnheader').map(text)).toEqual([
      'Category',
      'Spent',
      'Budget, with today marked',
      'Left',
    ]);
    // Largest first, then the categories with nothing this month, in their order
    expect(tableRows(table)).toEqual([
      'Bills Rent | 1,200.00 | Set a budget',
      'Groceries 3 entries | 180.00 | Set a budget',
      'Shopping 2 entries | 150.00 | 10.00',
      'Food Dining out, Coffee · carries over | 84.00 | 266.00',
      'Transport Petrol | 30.00 | 10.00 over',
      'Health 1 entry | 6.00 | Set a budget',
      'Fun Arcade | 0.50 | Set a budget',
      'Other Nothing this month | 0.00 | Set a budget',
    ]);
    for (const name of ['Food: 24% spent', 'Transport: 150% spent', 'Shopping: 94% spent']) {
      expect(within(table).getByRole('meter', { name })).toBeTruthy();
    }
    expect(screen.queryByRole('region', { name: /^Where it went/ })).toBeNull();
  });

  test('on a computer, the largest category opens beside the table, and a row opens its own', async () => {
    tenthJustAfterMidnight();
    renderApp(aPlannedMonth(), '/?plan', { size: 'desktop' });
    expect(await pane('Bills')).toBeTruthy();
    const table = await expensesTable();
    const before = window.history.length;
    await userEvent.setup().click(within(table).getByRole('button', { name: 'Food' }));
    const food = await pane('Food');
    // Beside the table, in the page's place in history
    expect(window.location.search).toBe(`?plan&category=${FOOD}`);
    expect(window.history.length).toBe(before);
    expect(screen.queryByRole('complementary', { name: 'Bills' })).toBeNull();

    expect(within(food).getByRole('link', { name: 'See 4 entries' }).getAttribute('href')).toBe(
      `?activity&category=${FOOD}`,
    );
    expect(within(food).getByText('RM 84.00')).toBeTruthy();
    // Sep RM 100.00 and Oct RM 250.00 over the 11 months before: RM 31.82 a month
    await waitFor(() =>
      expect(within(food).getByText('RM 52.18 over your usual RM 31.82')).toBeTruthy(),
    );
    const year = within(food).getByRole('region', {
      name: 'Food, last 12 months, November lowest since August',
    });
    expect(within(year).getAllByRole('listitem')).toHaveLength(12);
    // The usual is named on the line under the figure, so the bars' line goes unlabelled
    expect(within(year).queryByText(/^avg/)).toBeNull();
    expect(items(within(food).getByRole('list', { name: 'Inside Food' }))).toEqual([
      'Dining out 60.00',
      'Coffee 15.00',
      'Just Food 9.00',
    ]);
    expect(within(food).getByLabelText<HTMLInputElement>('Monthly budget').value).toBe('300.00');
    const carry = within(food).getByRole('switch', { name: 'Carry over' });
    expect((carry as HTMLInputElement).checked).toBe(true);
    expect(within(food).getByText('Leftover rolls into next month')).toBeTruthy();
  });

  // A new budget carries over, as "Carry over, for new budgets" is by default (owner
  // decision D14; settings/BudgetsPage.test.tsx has it off)
  test('on a computer, sets a budget from a row, in the pane, from this month', async () => {
    tenthJustAfterMidnight();
    const server = aPlannedMonth();
    renderApp(server, '/?plan', { size: 'desktop' });
    const user = userEvent.setup();
    const table = await expensesTable();
    const groceries = within(table)
      .getAllByRole('row')
      .find((row) => text(row).startsWith('Groceries'))!;
    await user.click(within(groceries).getByRole('button', { name: 'Set a budget' }));
    const pane_ = await pane('Groceries');
    const field = within(pane_).getByLabelText<HTMLInputElement>('Monthly budget');
    await waitFor(() => expect(document.activeElement).toBe(field));
    expect(field.value).toBe('');
    await user.type(field, '200{Enter}');

    // At once on screen: RM 180.00 of RM 200.00 by day 10 of 30 is ahead of the month
    await waitFor(() =>
      expect(tableRows(table)).toContain('Groceries 3 entries · carries over | 180.00 | 20.00'),
    );
    expect(within(table).getByRole('meter', { name: 'Groceries: 90% spent' })).toBeTruthy();
    await waitFor(() =>
      expect(budgetsOf(server)).toContainEqual({
        categoryId: GROCERIES,
        fromMonth: '2026-11',
        amountCents: 20_000,
        carryOver: true,
      }),
    );
  });

  test('on a computer, changes the amount keeping Carry over, turns Carry over off alone, and takes a budget away', async () => {
    tenthJustAfterMidnight();
    const server = aPlannedMonth();
    renderApp(server, `/?plan&category=${FOOD}`, { size: 'desktop' });
    const user = userEvent.setup();
    const food = await pane('Food');
    const table = await expensesTable();
    const field = within(food).getByLabelText<HTMLInputElement>('Monthly budget');
    await waitFor(() => expect(field.value).toBe('300.00'));

    // RM 400.00 and the RM 50.00 carried, less RM 84.00
    await user.clear(field);
    await user.type(field, '400');
    await user.tab();
    await waitFor(() =>
      expect(tableRows(table)).toContain('Food Dining out, Coffee · carries over | 84.00 | 366.00'),
    );
    await waitFor(() =>
      expect(budgetsOf(server).filter((b) => b.categoryId === FOOD)).toEqual([
        { categoryId: FOOD, fromMonth: '2026-10', amountCents: 30_000, carryOver: true },
        { categoryId: FOOD, fromMonth: '2026-11', amountCents: 40_000, carryOver: true },
      ]),
    );

    // Carry over off: the amount stays, nothing carried
    await user.click(within(food).getByRole('switch', { name: 'Carry over' }));
    await waitFor(() =>
      expect(tableRows(table)).toContain('Food Dining out, Coffee | 84.00 | 316.00'),
    );
    await waitFor(() =>
      expect(
        budgetsOf(server)
          .filter((b) => b.categoryId === FOOD)
          .at(-1),
      ).toEqual({
        categoryId: FOOD,
        fromMonth: '2026-11',
        amountCents: 40_000,
        carryOver: false,
      }),
    );

    // Emptied: no budget from this month on
    await user.clear(field);
    await user.type(field, '{Enter}');
    await waitFor(() =>
      expect(tableRows(table)).toContain('Food Dining out, Coffee | 84.00 | Set a budget'),
    );
    await waitFor(() =>
      expect(
        budgetsOf(server)
          .filter((b) => b.categoryId === FOOD)
          .at(-1),
      ).toEqual({
        categoryId: FOOD,
        fromMonth: '2026-11',
        amountCents: null,
        carryOver: false,
      }),
    );
  });

  test('on a computer, says what is wrong with an amount it cannot take, and sends nothing', async () => {
    tenthJustAfterMidnight();
    const server = aPlannedMonth();
    renderApp(server, `/?plan&category=${FOOD}`, { size: 'desktop' });
    const user = userEvent.setup();
    const food = await pane('Food');
    const field = within(food).getByLabelText<HTMLInputElement>('Monthly budget');
    await waitFor(() => expect(field.value).toBe('300.00'));
    for (const [typed, why] of [
      ['abc', 'Enter an amount, like 300'],
      ['0', 'Enter an amount above 0'],
    ]) {
      await user.clear(field);
      await user.type(field, `${typed}{Enter}`);
      expect(await within(food).findByText(why)).toBeTruthy();
    }
    await pause(100);
    expect(budgetsOf(server)).toEqual(aPlannedMonth().budgets);
  });

  test('on a computer, takes the largest budget there is but not a cent more', async () => {
    tenthJustAfterMidnight();
    const server = aPlannedMonth();
    renderApp(server, `/?plan&category=${GROCERIES}`, { size: 'desktop' });
    const user = userEvent.setup();
    const groceries = await pane('Groceries');
    const field = within(groceries).getByLabelText<HTMLInputElement>('Monthly budget');
    await user.type(field, '10000000.01{Enter}');
    expect(await within(groceries).findByText('Up to 10,000,000')).toBeTruthy();
    await pause(100);
    expect(budgetsOf(server).some((b) => b.categoryId === GROCERIES)).toBe(false);

    await user.clear(field);
    await user.type(field, '10000000{Enter}');
    await waitFor(() =>
      expect(budgetsOf(server)).toContainEqual({
        categoryId: GROCERIES,
        fromMonth: '2026-11',
        amountCents: 1_000_000_000,
        carryOver: true,
      }),
    );
    expect(within(groceries).queryByText('Up to 10,000,000')).toBeNull();
  });

  test('on a computer, leaving the amount as it was sends nothing, and Carry over waits for a budget', async () => {
    tenthJustAfterMidnight();
    const server = aPlannedMonth();
    renderApp(server, `/?plan&category=${FOOD}`, { size: 'desktop' });
    const user = userEvent.setup();
    const food = await pane('Food');
    const field = within(food).getByLabelText<HTMLInputElement>('Monthly budget');
    await waitFor(() => expect(field.value).toBe('300.00'));
    const saved = server.receipts.size;
    await user.click(field);
    await user.tab();
    await user.click(field);
    await user.type(field, '{Enter}');
    await pause(150);
    expect(server.receipts.size).toBe(saved);
    expect(budgetsOf(server)).toEqual(aPlannedMonth().budgets);

    // Fun has no budget: its Carry over can't be turned on until it has one
    await user.click(within(await expensesTable()).getByRole('button', { name: 'Fun' }));
    const fun = await pane('Fun');
    const carry = within(fun).getByRole('switch', { name: 'Carry over' });
    expect((carry as HTMLInputElement).disabled).toBe(true);
    expect((carry as HTMLInputElement).checked).toBe(false);
  });

  test('on a computer, a budget set offline shows at once, through a reload, and is saved once back', async () => {
    tenthJustAfterMidnight();
    const server = aPlannedMonth();
    renderApp(server, `/?plan&category=${GROCERIES}`, { size: 'desktop' });
    const user = userEvent.setup();
    const groceries = await pane('Groceries');
    await expensesTable();
    const back = goOffline(server);
    await user.type(within(groceries).getByLabelText('Monthly budget'), '200{Enter}');
    await waitFor(async () =>
      expect(tableRows(await expensesTable())).toContain(
        'Groceries 3 entries · carries over | 180.00 | 20.00',
      ),
    );

    // Opened again offline: kept on the device, still to send
    await reloadApp(server, `/?plan&category=${GROCERIES}`, { size: 'desktop' });
    await waitFor(async () =>
      expect(tableRows(await expensesTable())).toContain(
        'Groceries 3 entries · carries over | 180.00 | 20.00',
      ),
    );
    expect(budgetsOf(server).some((b) => b.categoryId === GROCERIES)).toBe(false);

    back();
    await waitFor(
      () =>
        expect(budgetsOf(server).filter((b) => b.categoryId === GROCERIES)).toEqual([
          { categoryId: GROCERIES, fromMonth: '2026-11', amountCents: 20_000, carryOver: true },
        ]),
      { timeout: 8000 },
    );
    await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
    expect(tableRows(await expensesTable())).toContain(
      'Groceries 3 entries · carries over | 180.00 | 20.00',
    );
  }, 15_000);

  test("on a computer, puts a budget the server refuses back, with the server's explanation", async () => {
    tenthJustAfterMidnight();
    const server = aPlannedMonth();
    server.failNext.changes = { status: 409, error: 'Fun is archived' };
    const held = holdNext(server, 'POST', '/api/changes');
    renderApp(server, `/?plan&category=${FUN}`, { size: 'desktop' });
    const user = userEvent.setup();
    const fun = await pane('Fun');
    const table = await expensesTable();
    await user.type(within(fun).getByLabelText('Monthly budget'), '100{Enter}');
    // Shown straight away, before the server answers
    await waitFor(() =>
      expect(tableRows(table)).toContain('Fun Arcade · carries over | 0.50 | 99.50'),
    );

    held.release();
    expect(await screen.findByText('Fun is archived')).toBeTruthy();
    await waitFor(() => expect(tableRows(table)).toContain('Fun Arcade | 0.50 | Set a budget'));
    expect(budgetsOf(server).some((b) => b.categoryId === FUN)).toBe(false);
  });

  test.each(SIZES)(
    'shows an earlier month as it ended, with no today marker (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aPlannedMonth(), '/?plan&month=2026-10', { size });
      expect(await screen.findByText(size === 'phone' ? 'Oct 2026' : 'October 2026')).toBeTruthy();
      expect(screen.queryByText(/day \d+ of \d+/i)).toBeNull();
      expect(screen.getByRole('button', { name: 'Next month' }).hasAttribute('disabled')).toBe(
        false,
      );
      if (size === 'phone') {
        const budgets = await budgetsRegion();
        // Food's first month: nothing carried in yet, Carry over on
        await waitFor(() =>
          expect(items(within(budgets).getByRole('list'))).toEqual([
            'Food RM 50.00 left RM 250.00 of RM 300.00 Carry over on',
          ]),
        );
        expect(within(budgets).getByRole('meter', { name: 'Food: 83% spent' })).toBeTruthy();
        const went = await whereItWent();
        expect(within(went).getAllByRole('link').map(text)).toEqual(['Food 100% · 1 entry 250.00']);
        expect(within(went).getAllByRole('link')[0].getAttribute('href')).toBe(
          `?plan&month=2026-10&category=${FOOD}`,
        );
      } else {
        const table = await expensesTable();
        await waitFor(() =>
          expect(tableRows(table)[0]).toBe('Food 1 entry · carries over | 250.00 | 50.00'),
        );
        expect(tableRows(table)).toContain('Bills Nothing in October | 0.00');
      }
      const income = await screen.findByRole('region', { name: 'Income' });
      await waitFor(() => expect(text(income)).toBe('Income RM 0.00'));

      await userEvent.setup().click(screen.getByRole('button', { name: 'Next month' }));
      await waitFor(() => expect(window.location.search).toBe('?plan'));
    },
  );

  test.each(SIZES)(
    'steps back two months, and Back returns to the one before (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aPlannedMonth(), '/?plan', { size });
      const user = userEvent.setup();
      await screen.findByRole('heading', { level: 1, name: 'Plan' });
      await user.click(screen.getByRole('button', { name: 'Previous month' }));
      await waitFor(() => expect(window.location.search).toBe('?plan&month=2026-10'));
      await user.click(screen.getByRole('button', { name: 'Previous month' }));
      await waitFor(() => expect(window.location.search).toBe('?plan&month=2026-09'));
      expect(
        await screen.findByText(size === 'phone' ? 'Sep 2026' : 'September 2026'),
      ).toBeTruthy();
      act(() => window.history.back());
      await waitFor(() => expect(window.location.search).toBe('?plan&month=2026-10'));
      expect(await screen.findByText(size === 'phone' ? 'Oct 2026' : 'October 2026')).toBeTruthy();
    },
  );

  test.each(SIZES)('says so plainly for an earlier month with nothing in it (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(aPlannedMonth(), '/?plan&month=2026-08', { size });
    const went = await whereItWent();
    await waitFor(() => expect(text(went)).toBe('Where it went RM 0.00 Nothing spent in August.'));
    const income = await screen.findByRole('region', { name: 'Income' });
    expect(text(income)).toBe('Income RM 0.00');
    // No budget yet in August, and none can be set for a month gone by
    expect(screen.queryByRole('region', { name: /^Budgets/ })).toBeNull();
    expect(screen.queryByText('No budgets yet')).toBeNull();
    expect(screen.queryByRole('table')).toBeNull();
    // No category open beside it (the sidebar is a landmark of its own)
    expect(within(screen.getByRole('main')).queryByRole('complementary')).toBeNull();
  });

  test.each(SIZES)('says when there are no budgets and nothing spent yet (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(twoAccounts(), '/?plan', { size });
    const budgets = await screen.findByRole('region', { name: 'Budgets' });
    expect(within(budgets).getByRole('heading', { name: 'No budgets yet' })).toBeTruthy();
    expect(
      within(budgets).getByText("A monthly amount per category, with a bar for what's left."),
    ).toBeTruthy();
    expect(within(budgets).getByRole('link', { name: 'Set a budget' }).getAttribute('href')).toBe(
      '?settings=categories',
    );
    const went = await whereItWent();
    expect(text(went)).toBe('Where it went RM 0.00 Nothing spent in November yet.');
    const income = await screen.findByRole('region', { name: 'Income' });
    expect(text(income)).toBe('Income RM 0.00 Nothing in yet. Schedule your pay');
    expect(
      within(income).getByRole('link', { name: 'Schedule your pay' }).getAttribute('href'),
    ).toBe('?plan=scheduled');
    expect(screen.queryByRole('table')).toBeNull();
    // No category open beside it (the sidebar is a landmark of its own)
    expect(within(screen.getByRole('main')).queryByRole('complementary')).toBeNull();
  });

  test.each(SIZES)(
    'with spending but no budgets, offers one on every category (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const server = aPlannedMonth();
      server.budgets = [];
      renderApp(server, '/?plan', { size });
      if (size === 'phone') {
        const budgets = await screen.findByRole('region', { name: 'Budgets' });
        expect(within(budgets).getByRole('heading', { name: 'No budgets yet' })).toBeTruthy();
        const went = await whereItWent();
        await waitFor(() => expect(within(went).getAllByRole('link')).toHaveLength(7));
      } else {
        const table = await expensesTable();
        await waitFor(() => expect(tableRows(table)).toHaveLength(8));
        expect(within(table).getAllByRole('button', { name: 'Set a budget' })).toHaveLength(8);
        expect(screen.queryByRole('heading', { name: 'No budgets yet' })).toBeNull();
      }
      expect(screen.queryAllByRole('meter')).toEqual([]);
    },
  );

  test('shows placeholders until the month arrives, never the empty month first', async () => {
    tenthJustAfterMidnight();
    const server = twoAccounts();
    const held = holdNext(server, 'GET', '/api/summary');
    renderApp(server, '/?plan', { size: 'phone' });
    expect(await screen.findByText('Loading this month')).toBeTruthy();
    // The accounts are in once the places show
    await screen.findByRole('navigation', { name: 'Main' });
    await pause(50);
    expect(screen.queryByText(/Nothing spent/)).toBeNull();
    expect(screen.queryByText('No budgets yet')).toBeNull();
    held.release();
    expect(await screen.findByText('Nothing spent in November yet.')).toBeTruthy();
    expect(screen.queryByText('Loading this month')).toBeNull();
  });

  test.each(SIZES)(
    'says so when the month cannot be loaded, and tries again (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const server = aPlannedMonth();
      server.pathsDown.add('/api/summary');
      renderApp(server, '/?plan', { size });
      expect(await screen.findByText("Couldn't load this month.")).toBeTruthy();
      server.pathsDown.delete('/api/summary');
      await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() =>
        expect(spentShown(size)).toBe(size === 'phone' ? 'RM 1,650.50' : 'RM 1,650.50 spent'),
      );
    },
  );

  test.each(SIZES)(
    'counts each change at once while an earlier one is still being saved (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const server = aPlannedMonth();
      renderApp(server, '/?plan', { size });
      const spent = (cents: string) => (size === 'phone' ? `RM ${cents}` : `RM ${cents} spent`);
      await waitFor(() => expect(spentShown(size)).toBe(spent('1,650.50')));

      // The first is on its way, its answer held up; the others wait behind it
      const saving = holdNext(server, 'POST', '/api/changes');
      try {
        await addEntry('8');
        await waitFor(() => expect(spentShown(size)).toBe(spent('1,658.50')));
        await addEntry('5');
        await waitFor(() => expect(spentShown(size)).toBe(spent('1,663.50')));
      } finally {
        saving.release();
      }
      // Saved, and counted once
      await waitFor(() => expect(server.transactions).toHaveLength(19));
      await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
      await pause(50);
      expect(spentShown(size)).toBe(spent('1,663.50'));
    },
    15_000,
  );

  test('counts spending added offline at once, through a reload, and once saved', async () => {
    tenthJustAfterMidnight();
    const server = aPlannedMonth();
    renderApp(server, '/?plan', { size: 'phone' });
    let went = await whereItWent();
    await waitFor(() => expect(within(went).getByText('RM 1,650.50')).toBeTruthy());

    const back = goOffline(server);
    await addEntry('8', (form) =>
      userEvent.setup().click(form.getByRole('radio', { name: 'Transport' })),
    );
    await waitFor(() => expect(within(went).getByText('RM 1,658.50')).toBeTruthy());
    expect(within(went).getAllByRole('link').map(text)).toContain(
      'Transport 2% · Petrol 30.00, Transport 8.00 38.00',
    );

    // Opened again offline: the month kept on the device, with the change still to send
    await reloadApp(server, '/?plan', { size: 'phone' });
    went = await whereItWent();
    await waitFor(() => expect(within(went).getByText('RM 1,658.50')).toBeTruthy());
    expect(server.transactions).toHaveLength(17);

    back();
    await waitFor(() => expect(server.transactions).toHaveLength(18), { timeout: 8000 });
    await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
    // Counted once, now that the server sums it too
    await pause(50);
    expect(within(went).getByText('RM 1,658.50')).toBeTruthy();
  }, 15_000);

  test.each(SIZES)(
    "what's left is never counted twice when spending saved with its answer lost is fetched before it is sent again (%s)",
    async (size) => {
      tenthJustAfterMidnight();
      const server = aPlannedMonth();
      renderApp(server, '/?plan', { size });
      // Food's left: RM 266.00 (phone "RM 266.00 left", a computer's Left column "266.00")
      const left = (cents: string) => (size === 'phone' ? `RM ${cents} left` : cents);
      const foodLeft = () => {
        // A phone's budgets list, or a computer's table
        const holder =
          size === 'phone'
            ? screen.queryByRole('region', { name: /^Budgets/ })
            : screen.queryByRole('table', { name: 'Expenses by category' });
        for (const el of holder?.querySelectorAll(size === 'phone' ? 'li' : 'tr') ?? []) {
          const said = text(el as HTMLElement);
          if (!said.startsWith('Food ')) continue;
          // A phone's "RM 266.00 left"; a computer's row ends with its Left column
          const found = size === 'phone' ? /RM [\d,.]+ left/.exec(said) : / ([\d,.]+)$/.exec(said);
          if (found != null) return size === 'phone' ? found[0] : found[1];
        }
        return null;
      };
      await waitFor(() => expect(foodLeft()).toBe(left('266.00')));
      const seen = new Set<string>();
      const note = () => {
        const now = foodLeft();
        if (now != null) seen.add(now);
      };
      const observer = new MutationObserver(note);
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
        attributes: true,
      });
      let resend = { release: () => {} };
      try {
        // RM 8 on Food, saved, its answer lost
        server.loseNext.changes = true;
        await addEntry('8', (form) =>
          userEvent.setup().click(form.getByRole('radio', { name: 'Food' })),
        );
        await waitFor(() => expect(server.transactions).toHaveLength(18));
        expect((await get<{ value: unknown[] }>(outboxKey(RYAN)))?.value ?? []).toHaveLength(1);

        resend = holdNext(server, 'POST', '/api/changes');
        await act(() => queryClient.refetchQueries({ type: 'active' }));
        await pause(50);
        expect(foodLeft()).toBe(left('258.00'));

        resend.release();
        await waitFor(
          async () =>
            expect((await get<{ value: unknown[] }>(outboxKey(RYAN)))?.value ?? []).toEqual([]),
          { timeout: 8000 },
        );
        await pause(50);
        note();
        expect(server.transactions).toHaveLength(18);
        expect([...seen].sort()).toEqual([left('258.00'), left('266.00')].sort());
      } finally {
        resend.release();
        observer.disconnect();
      }
    },
    15_000,
  );
});

describe("Plan's other half: Scheduled", () => {
  test.each(SIZES)(
    'opens Scheduled in its place, with what is scheduled, and Budgets back (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aPlannedMonth(), '/?plan', { size });
      const user = userEvent.setup();
      const halves = await screen.findByRole('navigation', { name: 'Plan' });
      const before = window.history.length;
      await user.click(within(halves).getByRole('link', { name: 'Scheduled' }));
      await waitFor(() => expect(window.location.search).toBe('?plan=scheduled'));
      expect(window.history.length).toBe(before);
      expect(
        within(screen.getByRole('navigation', { name: 'Plan' }))
          .getByRole('link', { name: 'Scheduled' })
          .getAttribute('aria-current'),
      ).toBe('page');
      // Scheduled as drawn (R-Bills): Salary's RM 6,800.00 a month on the 25th. The month-end
      // total (RM 7,999.50 now, plus Salary's RM 6,800.00) is Home's hero since D8
      const income = await screen.findByRole('region', { name: 'Income' });
      expect(income.textContent).toContain('RM 6,800.00 a month');
      expect(within(income).getByRole('button', { name: /^Salary/ })).toBeTruthy();
      expect(screen.queryByRole('region', { name: /^Where it went/ })).toBeNull();
      expect(screen.queryByRole('table')).toBeNull();

      await user.click(
        within(screen.getByRole('navigation', { name: 'Plan' })).getByRole('link', {
          name: 'Budgets',
        }),
      );
      await waitFor(() => expect(window.location.search).toBe('?plan'));
      expect(await screen.findByRole('region', { name: 'Income' })).toBeTruthy();
      // The month-end total, kept from before on Home's hero: RM 7,999.50 now, plus Salary
      await goToPlace('Home');
      const hero =
        size === 'phone'
          ? await screen.findByRole('region', { name: 'Expected at month end' })
          : await screen.findByRole('link', { name: /^Expected at month end/ });
      await waitFor(() => expect(hero.textContent).toContain('RM 14,799.50'));
    },
  );

  test.each(SIZES)('says when nothing is scheduled (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(twoAccounts(), '/?plan=scheduled', { size });
    expect(await screen.findByText('Nothing scheduled')).toBeTruthy();
    expect(screen.queryByText(/Expected at month end/)).toBeNull();
  });
});
