// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Account, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, goToPlace, reloadApp, renderApp, setupAppTests } from '../../testing/app';
import { change } from '../../ledger/ledger';
import { LAST_PAGE_KEY } from '../../offline/cache';

// Activity (?activity, R-Activity, R-Desk-Activity): the one list of every entry, this
// month's unless the filters say otherwise, with a search and four chips (account,
// category, the days, the kind). Phones and tablets group it by day, each day with its
// total; a computer shows a register table with the entry picked open beside it. Figures
// count everything found, loaded or not. Amounts say which way: a minus for spending, a
// plus for income, no sign for a transfer. Other pages link to it by its address (Home's
// calendar with &day=, Tidy up with &category=&from=&select); an address with parts that
// no longer make sense opens on what's left of it. With nothing yet, or nothing found, it
// says so (R-Empty-Activity, R-Empty-Search). Every figure and name here is this file's own.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
type Size = (typeof SIZES)[number] | 'tablet';
const [CASH, BANK, VISA] = ['a', 'b', 'c'].map((c) => c.repeat(16));
const COFFEE = 'e'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

beforeEach(() => {
  // Tuesday 10 November 2026, mid-morning, in the device's own time
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 10, 0, 0));
  return () => vi.useRealTimers();
});

function seedAccount(server: FakeServer, account: Partial<Account> & Pick<Account, 'id' | 'name'>) {
  server.accounts.push({
    kind: 'cash',
    currency: 'MYR',
    openingCents: 0,
    position: server.accounts.length,
    archived: false,
    ...account,
  });
}

let seeded = 0;
function seed(server: FakeServer, t: Partial<Transaction>) {
  seeded++;
  server.transactions.push({
    // Padded with 0, so every one is its own (padded with d, 13 and 221 would both be d x 16)
    id: seeded.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: CASH,
    toAccountId: null,
    amountCents: 100,
    categoryId: id('Food'),
    payee: null,
    note: null,
    date: '2026-11-10',
    createdAt: seeded,
    ...t,
  });
}

/**
 * Cash, a Bank and a Visa card; Coffee under Food. This month (seven):
 *   Nov 10 Cash 7.25 Food "Kedai Ali"; Nov 10 Bank 4.60 Coffee "Kopitiam";
 *   Nov 9 Bank 11.30 Coffee "Kopitiam", note "teh tarik"; Nov 6 Visa 63.40 Food
 *   "Restoran Hana"; Nov 5 Bank 3,250.00 Salary "Acme"; Nov 4 Bank to Cash 75.00, note
 *   "top-up"; Nov 3 Cash 5.50 Transport "Petronas".
 * Earlier: Oct 20 Cash 13.20 Transport "Bolt"; Oct 14 Visa 212.00 Other "Furniture shop",
 *   note "desk"; Oct 2 Cash 8.80 Transport "Parking"; Sep 15 Cash 6.70 Transport "Bolt".
 */
function withMonth() {
  const server = fakeServer();
  seedAccount(server, { id: CASH, name: 'Cash' });
  seedAccount(server, { id: BANK, name: 'Bank', kind: 'bank', openingCents: 1_000_000 });
  seedAccount(server, { id: VISA, name: 'Visa', kind: 'card' });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.categories.push({
    id: COFFEE,
    name: 'Coffee',
    kind: 'expense',
    parentId: id('Food'),
    position: 0,
    archived: false,
  });
  const transport = id('Transport');
  // Oldest first, so createdAt orders each day as it was entered
  seed(server, { date: '2026-09-15', amountCents: 670, categoryId: transport, payee: 'Bolt' });
  seed(server, { date: '2026-10-02', amountCents: 880, categoryId: transport, payee: 'Parking' });
  seed(server, {
    date: '2026-10-14',
    accountId: VISA,
    amountCents: 21_200,
    categoryId: id('Other'),
    payee: 'Furniture shop',
    note: 'desk',
  });
  seed(server, { date: '2026-10-20', amountCents: 1_320, categoryId: transport, payee: 'Bolt' });
  seed(server, { date: '2026-11-03', amountCents: 550, categoryId: transport, payee: 'Petronas' });
  seed(server, {
    date: '2026-11-04',
    kind: 'transfer',
    accountId: BANK,
    toAccountId: CASH,
    amountCents: 7_500,
    categoryId: null,
    note: 'top-up',
  });
  seed(server, {
    date: '2026-11-05',
    kind: 'income',
    accountId: BANK,
    amountCents: 325_000,
    categoryId: id('Salary'),
    payee: 'Acme',
  });
  seed(server, { date: '2026-11-06', accountId: VISA, amountCents: 6_340, payee: 'Restoran Hana' });
  seed(server, {
    date: '2026-11-09',
    accountId: BANK,
    amountCents: 1_130,
    categoryId: COFFEE,
    payee: 'Kopitiam',
    note: 'teh tarik',
  });
  seed(server, {
    date: '2026-11-10',
    accountId: BANK,
    amountCents: 460,
    categoryId: COFFEE,
    payee: 'Kopitiam',
  });
  seed(server, { date: '2026-11-10', amountCents: 725, payee: 'Kedai Ali' });
  return server;
}

const THIS_MONTH = [
  'Kedai Ali',
  'Kopitiam',
  'Kopitiam',
  'Restoran Hana',
  'Acme',
  'top-up',
  'Petronas',
];
const EARLIER = ['Bolt', 'Furniture shop', 'Parking', 'Bolt'];
const FOUND = '7 found · RM 92.05 spent · RM 3,250.00 received';

const results = () => screen.getByRole('region', { name: 'Results' });
/** A phone's or tablet's rows, each by its name: title, subtitle and amount */
const listRows = () =>
  within(results())
    .queryAllByRole('button')
    .map((b) => b.getAttribute('aria-label') ?? '')
    .filter((name) => name.includes(', '));
/** A computer's register, each row's cells after the tick box */
const registerRows = () =>
  within(screen.getByRole('table', { name: 'Transactions' }))
    .getAllByRole('row')
    .slice(1)
    .map((row) =>
      within(row)
        .getAllByRole('cell')
        .slice(1)
        .map((cell) => cell.textContent?.trim()),
    );
/** What's found, newest first, each by its title (its payee, else its note) */
function titles(size: Size) {
  if (screen.queryByText('No transactions match') != null) return [];
  return size !== 'desktop'
    ? listRows().map((name) => name.split(', ')[0])
    : registerRows().map((cells) => cells[1].split(' · ')[0]);
}
/** A filter's chip by what it says, else another button (Select) */
const chip = (name: string) => {
  const filters = screen.queryByRole('group', { name: 'Filters' });
  return (
    (filters && within(filters).queryByRole('button', { name })) ??
    screen.getByRole('button', { name })
  );
};

/**
 * The elements whose whole text is `text` (however it's split into parts), the innermost
 * one of each: a line is read as a person reads it, not by how it's marked up
 */
const lines = (text: string) =>
  screen.queryAllByText(
    (_, el) =>
      el != null &&
      el.textContent === text &&
      ![...el.children].some((child) => child.textContent === text),
  );
const hasLine = (text: string) => expect(lines(text).length).toBeGreaterThan(0);

/** The connection drops: the browser says so, and nothing reaches the server */
function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => void window.dispatchEvent(new Event('offline')));
  onTestFinished(() => onLine.mockRestore());
  return () => {
    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
  };
}

/** Opens Activity at `path` and waits for what it finds */
async function open(server: FakeServer, size: Size, path = '/?activity') {
  renderApp(server, path, { size });
  // Activity, or how many are ticked while a phone is selecting
  expect(
    await screen.findByRole('heading', { name: /^(Activity|\d+ selected)$/, level: 1 }),
  ).toBeTruthy();
  await screen.findByRole('region', { name: 'Results' });
  return userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
}

/** Picks `option` from a chip's list */
async function pick(user: ReturnType<typeof userEvent.setup>, chipName: string, option: string) {
  await user.click(chip(chipName));
  const list = within(await screen.findByRole('dialog'));
  await user.click(list.getByRole('radio', { name: option }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

describe('the page', () => {
  test('on a phone: this month by day, each day with its total, signed by which way it went', async () => {
    await open(withMonth(), 'phone');
    expect(screen.getByRole('searchbox', { name: 'Search' }).getAttribute('placeholder')).toBe(
      'Payee, note, category or amount',
    );
    expect(chip('Select')).toBeTruthy();
    for (const name of ['All accounts', 'All categories', 'This month', 'All kinds']) {
      expect(chip(name).getAttribute('aria-pressed')).toBe('false');
    }
    await waitFor(() => hasLine(FOUND));
    expect(
      within(results())
        .getAllByRole('heading', { level: 2 })
        .map((h) => h.textContent),
    ).toEqual([
      'Today−11.85',
      'Yesterday−11.30',
      'Fri, Nov 6−63.40',
      'Thu, Nov 5+3,250.00',
      'Wed, Nov 4',
      'Tue, Nov 3−5.50',
    ]);
    expect(listRows()).toEqual([
      'Kedai Ali, Food · Cash, −7.25',
      'Kopitiam, Food › Coffee · Bank, −4.60',
      'Kopitiam, Food › Coffee · Bank, −11.30',
      'Restoran Hana, Food · Visa, −63.40',
      'Acme, Salary · Bank, +3,250.00',
      'top-up, Bank to Cash, 75.00',
      'Petronas, Transport · Cash, −5.50',
    ]);
    // Each day's rows are its own list, each row with its category's letter
    const today = within(screen.getByRole('list', { name: 'Today' }));
    expect(today.getAllByRole('listitem')).toHaveLength(2);
    expect(within(today.getByRole('button', { name: /^Kedai Ali, / })).getByText('F')).toBeTruthy();
    // "0 found" is a computer's alone
    expect(lines('0 found')).toHaveLength(0);
  });

  test('on a computer: a register, with the first entry open beside it, and its keys', async () => {
    await open(withMonth(), 'desktop');
    await waitFor(() => hasLine(FOUND));
    const table = screen.getByRole('table', { name: 'Transactions' });
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent?.trim()),
    ).toEqual(['', 'Date', 'Payee and note', 'Category', 'Account', 'Amount']);
    expect(within(table).getByRole('checkbox', { name: 'Select all' })).toBeTruthy();
    expect(registerRows()).toEqual([
      ['Nov 10', 'Kedai Ali', 'Food', 'Cash', '−7.25'],
      ['Nov 10', 'Kopitiam', 'Food › Coffee', 'Bank', '−4.60'],
      ['Nov 9', 'Kopitiam · teh tarik', 'Food › Coffee', 'Bank', '−11.30'],
      ['Nov 6', 'Restoran Hana', 'Food', 'Visa', '−63.40'],
      ['Nov 5', 'Acme', 'Salary', 'Bank', '+3,250.00'],
      ['Nov 4', 'top-up', 'Transfer', 'Bank to Cash', '75.00'],
      ['Nov 3', 'Petronas', 'Transport', 'Cash', '−5.50'],
    ]);
    const pane = within(screen.getByRole('complementary', { name: 'Kedai Ali, Nov 10' }));
    expect(pane.getByRole('heading', { name: 'Kedai Ali' })).toBeTruthy();
    expect(pane.getByText('Tue, Nov 10')).toBeTruthy();
    expect(pane.getByText('−RM 7.25')).toBeTruthy();
    const way = within(pane.getByRole('radiogroup', { name: 'Which way' }));
    expect(way.getByRole('radio', { name: 'Expense' })).toHaveProperty('checked', true);
    expect(way.getAllByRole('radio')).toHaveLength(3);
    expect(pane.getByRole('button', { name: 'Delete' })).toBeTruthy();
    expect(pane.getByRole('button', { name: 'Save' })).toBeTruthy();
    // The keys, as R-Desk-Activity says them
    hasLine('JK move X tick C category');
  });

  test('on a tablet: the list by day, Select, and a sheet to change one', async () => {
    const user = await open(withMonth(), 'tablet');
    await waitFor(() => expect(titles('tablet')).toEqual(THIS_MONTH));
    expect(screen.queryByRole('table')).toBeNull();
    expect(chip('Select')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /^Restoran Hana, / }));
    expect(await screen.findByRole('dialog', { name: 'Restoran Hana' })).toBeTruthy();
  });

  test.each(SIZES)(
    'a day and the totals count what is not loaded yet, before and after Load more (%s)',
    async (size) => {
      const server = withMonth();
      for (let i = 0; i < 250; i++)
        seed(server, { date: '2026-11-01', amountCents: 100, payee: `Kiosk ${i}` });
      const user = await open(server, size);
      const all = '257 found · RM 342.05 spent · RM 3,250.00 received';
      await waitFor(() => hasLine(all));
      if (size === 'phone') {
        expect(screen.getByRole('heading', { name: /^Sun, Nov 1/ }).textContent).toBe(
          'Sun, Nov 1−250.00',
        );
      }
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull());
      hasLine(all);
      if (size === 'phone') {
        expect(screen.getByRole('heading', { name: /^Sun, Nov 1/ }).textContent).toBe(
          'Sun, Nov 1−250.00',
        );
      }
      expect(titles(size)).toHaveLength(257);
    },
    30_000,
  );

  test('an add older than what is loaded is counted once, even when its answer is lost', async () => {
    const server = withMonth();
    for (let i = 0; i < 250; i++)
      seed(server, { date: '2026-11-02', amountCents: 100, payee: `Kiosk ${i}` });
    await open(server, 'desktop');
    await waitFor(() => hasLine('257 found · RM 342.05 spent · RM 3,250.00 received'));
    // Saved, but the answer never comes back: sent again later
    server.loseNext.changes = true;
    act(() =>
      change({
        op: 'addTransaction',
        transaction: {
          id: 'f'.repeat(16),
          kind: 'expense',
          accountId: CASH,
          toAccountId: null,
          amountCents: 1_000,
          categoryId: id('Food'),
          payee: 'Backdated',
          note: null,
          date: '2026-11-01',
        },
      }),
    );
    await waitFor(() =>
      expect(server.transactions.some((t) => t.payee === 'Backdated')).toBe(true),
    );
    await waitFor(() => hasLine('258 found · RM 352.05 spent · RM 3,250.00 received'), {
      timeout: 8000,
    });
    await act(() => new Promise((r) => setTimeout(r, 300)));
    hasLine('258 found · RM 352.05 spent · RM 3,250.00 received');
    expect(lines('259 found · RM 362.05 spent · RM 3,250.00 received')).toHaveLength(0);
  }, 30_000);

  test.each(SIZES)(
    'a list over all months says the year of a day in another year (%s)',
    async (size) => {
      const server = withMonth();
      seed(server, { date: '2025-12-30', amountCents: 990, payee: 'Last year' });
      await open(server, size, '/?activity&dates=all');
      await waitFor(() => expect(titles(size)).toContain('Last year'));
      if (size === 'phone') {
        expect(screen.getByRole('heading', { name: /^Tue, Dec 30, 2025/ })).toBeTruthy();
      } else {
        expect(registerRows().at(-1)?.[0]).toBe('Dec 30, 2025');
      }
    },
  );

  test.each(SIZES)(
    "when the search can't be read, says so, and Try again reads it (%s)",
    async (size) => {
      const server = withMonth();
      server.pathsDown.add('/api/search');
      const user = await open(server, size);
      expect(
        await screen.findByText("Couldn't search. Check the connection and try again."),
      ).toBeTruthy();
      server.pathsDown.delete('/api/search');
      await user.click(screen.getByRole('button', { name: 'Try again' }));
      await waitFor(() => expect(titles(size)).toEqual(THIS_MONTH));
    },
  );

  test('is a tap from Home, and Home a tap from it', async () => {
    renderApp(withMonth(), '/', { size: 'phone' });
    await goToPlace('Activity');
    expect(await screen.findByRole('heading', { name: 'Activity', level: 1 })).toBeTruthy();
    expect(window.location.search).toBe('?activity');
    await goToPlace('Home');
    expect(window.location.search).toBe('');
  });
});

describe('the filters', () => {
  test.each(SIZES)('an account, transfers into it too, in the address (%s)', async (size) => {
    const user = await open(withMonth(), size);
    await waitFor(() => expect(titles(size)).toEqual(THIS_MONTH));
    // A phone's sheet keeps an entry of its own for Back while it's open: counted once opened
    await user.click(chip('All accounts'));
    await screen.findByRole('dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const length = window.history.length;
    await pick(user, 'All accounts', 'Cash');
    await waitFor(() => expect(titles(size)).toEqual(['Kedai Ali', 'top-up', 'Petronas']));
    expect(chip('Cash').getAttribute('aria-pressed')).toBe('true');
    expect(window.location.search).toBe(`?activity&account=${CASH}`);
    expect(window.history.length).toBe(length);
  });

  test.each(SIZES)(
    'a category, with the ones under it, or one under it alone (%s)',
    async (size) => {
      const user = await open(withMonth(), size);
      await waitFor(() => expect(titles(size)).toEqual(THIS_MONTH));
      await pick(user, 'All categories', 'Food');
      await waitFor(() =>
        expect(titles(size)).toEqual(['Kedai Ali', 'Kopitiam', 'Kopitiam', 'Restoran Hana']),
      );
      await pick(user, 'Food', 'Food › Coffee');
      await waitFor(() => expect(titles(size)).toEqual(['Kopitiam', 'Kopitiam']));
      expect(chip('Food › Coffee').getAttribute('aria-pressed')).toBe('true');
      expect(window.location.search).toBe(`?activity&category=${COFFEE}`);
    },
  );

  test.each(SIZES)('the kind: income, transfers, or expenses and income (%s)', async (size) => {
    const user = await open(withMonth(), size);
    await waitFor(() => expect(titles(size)).toEqual(THIS_MONTH));
    await pick(user, 'All kinds', 'Income');
    await waitFor(() => expect(titles(size)).toEqual(['Acme']));
    hasLine('1 found · RM 3,250.00 received');
    await pick(user, 'Income', 'Transfers');
    await waitFor(() => expect(titles(size)).toEqual(['top-up']));
    await pick(user, 'Transfers', 'Expenses and income');
    await waitFor(() => expect(titles(size)).toEqual(THIS_MONTH.filter((t) => t !== 'top-up')));
    expect(new URLSearchParams(window.location.search).get('kind')).toBe('expense,income');
    await pick(user, 'Expenses and income', 'Expenses');
    await waitFor(() =>
      expect(titles(size)).toEqual(THIS_MONTH.filter((t) => t !== 'top-up' && t !== 'Acme')),
    );
    hasLine('5 found · RM 92.05 spent');
  });

  test.each(SIZES)('the days: last month, all months, or dates picked (%s)', async (size) => {
    const user = await open(withMonth(), size);
    await waitFor(() => expect(titles(size)).toEqual(THIS_MONTH));
    await pick(user, 'This month', 'Last month');
    await waitFor(() => expect(titles(size)).toEqual(['Bolt', 'Furniture shop', 'Parking']));
    expect(window.location.search).toBe('?activity&from=2026-10-01&to=2026-10-31');
    await pick(user, 'Last month', 'All months');
    await waitFor(() => expect(titles(size)).toEqual([...THIS_MONTH, ...EARLIER]));
    expect(window.location.search).toBe('?activity&dates=all');

    await user.click(chip('All months'));
    const list = within(await screen.findByRole('dialog'));
    await user.click(list.getByRole('radio', { name: 'Pick dates' }));
    fireEvent.change(list.getByLabelText('From'), { target: { value: '2026-10-14' } });
    fireEvent.change(list.getByLabelText('To'), { target: { value: '2026-11-03' } });
    await user.click(list.getByRole('button', { name: 'Show these dates' }));
    await waitFor(() => expect(titles(size)).toEqual(['Petronas', 'Bolt', 'Furniture shop']));
    expect(chip('Oct 14 to Nov 3').getAttribute('aria-pressed')).toBe('true');

    await pick(user, 'Oct 14 to Nov 3', 'This month');
    await waitFor(() => expect(titles(size)).toEqual(THIS_MONTH));
    expect(window.location.search).toBe('?activity');
  });

  test.each(SIZES)(
    'words: the payee, the note, a category, an amount; a note found shows in place of the category (%s)',
    async (size) => {
      const user = await open(withMonth(), size);
      const box = screen.getByRole('searchbox', { name: 'Search' });
      await user.type(box, 'kopitiam');
      await waitFor(() => expect(titles(size)).toEqual(['Kopitiam', 'Kopitiam']));
      await user.clear(box);
      await user.type(box, 'transport');
      await waitFor(() => expect(titles(size)).toEqual(['Petronas']));
      await user.clear(box);
      await user.type(box, '7.25');
      await waitFor(() => expect(titles(size)).toEqual(['Kedai Ali']));
      await user.clear(box);
      await user.type(box, 'teh');
      await waitFor(() => expect(titles(size)).toEqual(['Kopitiam']));
      if (size === 'phone') {
        expect(listRows()).toEqual(['Kopitiam, teh tarik · Bank, −11.30']);
      }
      expect(window.location.search).toBe('?activity&q=teh');
    },
  );
});

describe('addresses other pages link to', () => {
  test.each(SIZES)('&day= is that day alone (%s)', async (size) => {
    await open(withMonth(), size, '/?activity&day=2026-11-10');
    await waitFor(() => expect(titles(size)).toEqual(['Kedai Ali', 'Kopitiam']));
    expect(chip('Tue, Nov 10').getAttribute('aria-pressed')).toBe('true');
    hasLine('2 found · RM 11.85 spent');
  });

  test("Tidy up's: Other since a day, selecting, on a phone with no tab bar until Done", async () => {
    const user = await open(
      withMonth(),
      'phone',
      `/?activity&category=${id('Other')}&from=2026-10-01&select`,
    );
    expect(screen.getByRole('heading', { name: '0 selected' })).toBeTruthy();
    await waitFor(() => expect(chip('Other').getAttribute('aria-pressed')).toBe('true'));
    expect(chip('Since Oct 1').getAttribute('aria-pressed')).toBe('true');
    await waitFor(() => hasLine('1 found in Other'));
    expect(screen.getByRole('button', { name: 'Select all 1' })).toBeTruthy();
    expect(
      screen.getByRole('checkbox', { name: 'Furniture shop, Other · Visa · Oct 14, −212.00' }),
    ).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Done' }));
    expect(await screen.findByRole('heading', { name: 'Activity', level: 1 })).toBeTruthy();
    expect(window.location.search).toBe(`?activity&category=${id('Other')}&from=2026-10-01`);
    expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
  });

  test("Tidy up's on a computer: the register, ready to tick", async () => {
    await open(withMonth(), 'desktop', `/?activity&category=${id('Other')}&from=2026-10-01&select`);
    await waitFor(() =>
      expect(registerRows()).toEqual([
        ['Oct 14', 'Furniture shop · desk', 'Other', 'Visa', '−212.00'],
      ]),
    );
    expect(screen.getByRole('button', { name: 'Select all 1' })).toBeTruthy();
    hasLine('1 found · RM 212.00 spent');
  });

  test('a reload keeps the filters from its address, but not selecting', async () => {
    const server = withMonth();
    await open(server, 'desktop', '/?activity&kind=income&dates=all');
    await waitFor(() => expect(titles('desktop')).toEqual(['Acme']));
    await reloadApp(server, `/?activity&kind=income&dates=all`);
    await waitFor(() => expect(titles('desktop')).toEqual(['Acme']));
    expect(chip('Income').getAttribute('aria-pressed')).toBe('true');
    expect(chip('All months').getAttribute('aria-pressed')).toBe('true');
  });

  test('on a phone, &select opens selecting, but the page to reopen afresh is Activity', async () => {
    const server = withMonth();
    await open(server, 'phone', '/?activity&select');
    expect(screen.getByRole('heading', { name: '0 selected' })).toBeTruthy();
    // Kept once the person is known; selecting is never kept
    await waitFor(() => expect(localStorage.getItem(LAST_PAGE_KEY)).toMatch(/^\?activity=?$/));
    // A reload keeps its own address, so it is still selecting
    await reloadApp(server, '/?activity&select', { size: 'phone' });
    expect(await screen.findByRole('heading', { name: '0 selected' })).toBeTruthy();
  });

  test.each([
    ['an account that is not there', `account=${'9'.repeat(16)}`, '?activity'],
    ['a category that is not there', `category=${'9'.repeat(16)}`, '?activity'],
    ['a day that is not a day', 'day=2026-02-30', '?activity'],
    ['a from that is not a day', 'from=yesterday', '?activity'],
    ['a kind it does not know', 'kind=bogus', '?activity'],
    [
      'a day with from and to: the day wins',
      'from=2026-10-01&to=2026-10-31&day=2026-11-10',
      '?activity&day=2026-11-10',
    ],
    [
      'all months with a from: the from wins',
      'dates=all&from=2026-11-06',
      '?activity&from=2026-11-06',
    ],
  ])('an address with %s opens on what is left of it', async (_what, query, left) => {
    await open(withMonth(), 'desktop', `/?activity&${query}`);
    await waitFor(() => expect(window.location.search).toBe(left));
    await waitFor(() => expect(titles('desktop').length).toBeGreaterThan(0));
    expect(screen.queryByText(/not found/i)).toBeNull();
  });

  test('an archived category still filters, by its name', async () => {
    const server = withMonth();
    server.categories.find((c) => c.id === id('Other'))!.archived = true;
    await open(server, 'desktop', `/?activity&category=${id('Other')}&dates=all`);
    await waitFor(() => expect(titles('desktop')).toEqual(['Furniture shop']));
    expect(chip('Other').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('nothing to show', () => {
  test.each(SIZES)(
    'with nothing yet, says so, with a way to log one or import (%s)',
    async (size) => {
      const server = fakeServer();
      seedAccount(server, { id: CASH, name: 'Cash' });
      const user = await open(server, size);
      expect(await screen.findByRole('heading', { name: 'No transactions yet' })).toBeTruthy();
      expect(
        screen.getByText(
          size === 'phone'
            ? 'Entries show here, newest first.'
            : 'Entries show here, newest first. Press N to add one.',
        ),
      ).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Log your first one' }));
      expect(within(await screen.findByRole('dialog')).getByLabelText('Amount')).toBeTruthy();
      await user.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      await user.click(screen.getByRole('button', { name: "Import a bank's CSV" }));
      await waitFor(() => expect(window.location.search).toBe('?import'));
    },
  );

  test('with nothing yet and a filter, says nothing matches until the filters are cleared', async () => {
    const server = fakeServer();
    seedAccount(server, { id: CASH, name: 'Cash' });
    const user = await open(server, 'desktop', '/?activity&kind=income');
    expect(await screen.findByRole('heading', { name: 'No transactions match' })).toBeTruthy();
    hasLine('Nothing this month.');
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByRole('heading', { name: 'No transactions yet' })).toBeTruthy();
  });

  test('on the first of a month, with entries only in earlier months, nothing matches yet', async () => {
    vi.setSystemTime(new Date(2026, 11, 1, 9, 0, 0));
    const user = await open(withMonth(), 'phone');
    expect(await screen.findByRole('heading', { name: 'No transactions match' })).toBeTruthy();
    await waitFor(() => hasLine('Nothing this month. 11 in other months.'));
    await user.click(screen.getByRole('button', { name: 'Search all months' }));
    await waitFor(() => expect(titles('phone')).toEqual([...THIS_MONTH, ...EARLIER]));
  });

  test.each(SIZES)(
    'with nothing found, says what was looked for and how many are in other months (%s)',
    async (size) => {
      const user = await open(withMonth(), size, `/?activity&q=bolt&category=${id('Transport')}`);
      expect(await screen.findByRole('heading', { name: 'No transactions match' })).toBeTruthy();
      expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveProperty('value', 'bolt');
      await waitFor(() => hasLine('No "bolt" in Transport this month. 2 in other months.'));
      if (size === 'desktop') hasLine('0 found');
      else {
        expect(lines('0 found')).toHaveLength(0);
        expect(chip('Select')).toBeTruthy();
      }
      // No entry is open beside nothing
      expect(within(screen.getByRole('main')).queryByRole('complementary')).toBeNull();

      // The words and the days stay; the chips go back to all
      await user.click(screen.getByRole('button', { name: 'Clear filters' }));
      await waitFor(() => hasLine('No "bolt" this month. 2 in other months.'));
      expect(chip('All categories').getAttribute('aria-pressed')).toBe('false');
      expect(chip('This month').getAttribute('aria-pressed')).toBe('false');

      await user.click(screen.getByRole('button', { name: 'Search all months' }));
      await waitFor(() => expect(titles(size)).toEqual(['Bolt', 'Bolt']));
      expect(chip('All months').getAttribute('aria-pressed')).toBe('true');
      expect(window.location.search).toBe('?activity&q=bolt&dates=all');
    },
  );

  test.each(SIZES)(
    'offline with nothing loaded, asks for a connection, then shows (%s)',
    async (size) => {
      const server = withMonth();
      // Opened on Home, then the connection drops before Activity has found anything
      renderApp(server, '/', { size });
      await screen.findByRole('navigation', { name: 'Main' });
      const back = goOffline(server);
      await goToPlace('Activity');
      expect(await screen.findByRole('heading', { name: 'Connect to search' })).toBeTruthy();
      expect(screen.getByText("Search results aren't kept on this device.")).toBeTruthy();
      back();
      await waitFor(() => expect(titles(size)).toEqual(THIS_MONTH), { timeout: 8000 });
    },
    15_000,
  );
});

describe('changing one', () => {
  test('on a phone, a tap opens it in a sheet to change; Save keeps it', async () => {
    const server = withMonth();
    const user = await open(server, 'phone');
    await user.click(await screen.findByRole('button', { name: /^Restoran Hana, / }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Restoran Hana' }));
    expect(sheet.getByText('Fri, Nov 6')).toBeTruthy();
    expect(sheet.getByText('−RM 63.40')).toBeTruthy();
    expect(
      within(sheet.getByRole('radiogroup', { name: 'Which way' })).getByRole('radio', {
        name: 'Expense',
      }),
    ).toHaveProperty('checked', true);
    await user.type(sheet.getByLabelText('Note'), 'with Mei');
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(server.transactions.find((t) => t.payee === 'Restoran Hana')?.note).toBe('with Mei'),
    );
  });

  test('on a phone, Delete takes it out at once, and Undo puts it back', async () => {
    const server = withMonth();
    const user = await open(server, 'phone');
    await user.click(await screen.findByRole('button', { name: /^Restoran Hana, / }));
    const sheet = within(await screen.findByRole('dialog', { name: 'Restoran Hana' }));
    await user.click(sheet.getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(titles('phone')).not.toContain('Restoran Hana'));
    hasLine('6 found · RM 28.65 spent · RM 3,250.00 received');
    expect(await screen.findByText('Deleted RM 63.40, Food')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions.some((t) => t.payee === 'Restoran Hana')).toBe(false),
    );
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(() => expect(titles('phone')).toEqual(THIS_MONTH));
    await waitFor(() =>
      expect(server.transactions.some((t) => t.payee === 'Restoran Hana')).toBe(true),
    );
  });

  test('on a computer, a row opens beside the register; Enter saves it there', async () => {
    const server = withMonth();
    const user = await open(server, 'desktop');
    await waitFor(() => expect(titles('desktop')).toEqual(THIS_MONTH));
    await user.click(screen.getByRole('cell', { name: 'Restoran Hana' }));
    const pane = within(await screen.findByRole('complementary', { name: 'Restoran Hana, Nov 6' }));
    await user.selectOptions(pane.getByLabelText('Category'), 'Transport');
    const amount = pane.getByLabelText('Amount');
    await user.clear(amount);
    await user.type(amount, '70{Enter}');
    await waitFor(() =>
      expect(registerRows()[3]).toEqual(['Nov 6', 'Restoran Hana', 'Transport', 'Visa', '−70.00']),
    );
    await waitFor(() =>
      expect(server.transactions.find((t) => t.payee === 'Restoran Hana')).toMatchObject({
        categoryId: id('Transport'),
        amountCents: 7_000,
      }),
    );
    // Still open, as saved
    expect(screen.getByRole('complementary', { name: 'Restoran Hana, Nov 6' })).toBeTruthy();
  });

  test('on a computer, Delete in the pane opens the next one, or the one before at the end', async () => {
    const server = withMonth();
    const user = await open(server, 'desktop');
    await waitFor(() => expect(titles('desktop')).toEqual(THIS_MONTH));
    await user.click(screen.getByRole('cell', { name: 'Restoran Hana' }));
    const pane = within(await screen.findByRole('complementary', { name: 'Restoran Hana, Nov 6' }));
    await user.click(pane.getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('complementary', { name: 'Acme, Nov 5' })).toBeTruthy();
    expect(titles('desktop')).not.toContain('Restoran Hana');
    await user.click(screen.getByRole('cell', { name: 'Petronas' }));
    await user.click(
      within(await screen.findByRole('complementary', { name: 'Petronas, Nov 3' })).getByRole(
        'button',
        {
          name: 'Delete',
        },
      ),
    );
    expect(await screen.findByRole('complementary', { name: 'top-up, Nov 4' })).toBeTruthy();
  });
});
