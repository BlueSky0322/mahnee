// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Recurring, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES, OTHER_EXPENSE_ID } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addForm,
  addSaveButton,
  fakeServer,
  holdNext,
  reloadApp,
  renderApp,
  setupAppTests,
  typeAmount,
} from '../../testing/app';

// Home at a glance (R-Home, R-Desk-Home; first day R-Empty-Home, R-Desk-Empty-Home; first
// run R-FirstRun, R-Desk-FirstRun). Where the month will land, with the sum under it;
// spent so far and what came in; what needs you (Tidy up, Coming up); a day-by-day
// calendar against the middle day; and budgets with a today marker. With no account yet,
// the first run asks where the money is kept.

// Where the person is: Malaysia, eight hours ahead of UTC. The clock reads 00:30 on Tuesday
// 10 November there, still the 9th in UTC, so a day taken from UTC shows on the wrong day.
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const BANK = 'b'.repeat(16);
const CASH = 'c'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, SALARY, BILLS] = [id('Food'), id('Transport'), id('Salary'), id('Bills')];

/** The app's clock reads 00:30 on 10 November 2026 where the person is, and still ticks */
function tenthJustAfterMidnight() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 0, 30, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

const account = (id: string, name: string, kind: 'bank' | 'cash', openingCents: number) => ({
  id,
  name,
  kind,
  currency: 'MYR',
  openingCents,
  position: 0,
  archived: false,
});

let seeded = 0;
function entry(
  server: FakeServer,
  date: string,
  amountCents: number,
  categoryId: string,
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
 * Maybank Savings with RM 5,000 and RM 3,000 of pay in on the 5th; Cash with RM 200 and
 * RM 43 spent from it (RM 4 of it in October). TNB (RM 189.00, the 20th) and Salary
 * (RM 6,800.00, the 25th) still to come this month, Rent next on 1 December and Insurance
 * on 5 December. Budgets on
 * Food (RM 60) and Transport (RM 30).
 */
function aMonthUnderWay() {
  const server = fakeServer();
  server.accounts.push(account(BANK, 'Maybank Savings', 'bank', 500_000), {
    ...account(CASH, 'Cash', 'cash', 20_000),
    position: 1,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  // Spent on the 1st to the 10th: 10.00, 0, 3.00, 0, 5.00, 0, 0, 0, 12.00, 9.00, so the
  // middle day is the mean of 0 and 3.00 (the 5th and 6th of ten), 1.50
  entry(server, '2026-11-01', 1_000, FOOD);
  entry(server, '2026-11-03', 300, TRANSPORT);
  entry(server, '2026-11-05', 500, FOOD);
  entry(server, '2026-11-09', 1_200, OTHER_EXPENSE_ID);
  entry(server, '2026-11-10', 900, FOOD);
  entry(server, '2026-10-20', 400, OTHER_EXPENSE_ID);
  entry(server, '2026-11-05', 300_000, SALARY, {
    kind: 'income',
    accountId: BANK,
    payee: 'Salary',
  });
  server.recurring.push(
    repeating('TNB electricity', { amountCents: 18_900, day: 20, nextDue: '2026-11-20' }),
    repeating('Salary', {
      kind: 'income',
      categoryId: SALARY,
      amountCents: 680_000,
      day: 25,
      nextDue: '2026-11-25',
    }),
    repeating('Rent', { amountCents: 120_000, day: 1, nextDue: '2026-12-01' }),
    // A fourth, after this month: Coming up shows only the first three
    repeating('Insurance', { amountCents: 25_000, day: 5, nextDue: '2026-12-05' }),
  );
  server.budgets.push(
    { categoryId: FOOD, fromMonth: '2026-11', amountCents: 6_000, carryOver: false },
    { categoryId: TRANSPORT, fromMonth: '2026-11', amountCents: 3_000, carryOver: false },
  );
  return server;
}

/** Maybank Savings with RM 5,000.00, and nothing else yet */
function firstDay() {
  const server = fakeServer();
  server.accounts.push(account(BANK, 'Maybank Savings', 'bank', 500_000));
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

/** Tidy up's banner, once it shows */
const tidyUp = () =>
  screen.queryAllByRole('status').find((s) => /still in Other/.test(s.textContent ?? '')) ?? null;

/** The month-end figure's place: its own section on a phone, the first of three on a computer */
async function monthEnd(size: (typeof SIZES)[number], name = 'Expected at month end') {
  if (size === 'phone') return screen.findByRole('region', { name });
  const glance = await screen.findByRole('region', { name: /at a glance$/ });
  return within(glance).getByRole('link', { name: new RegExp(`^${name}`) });
}

const rows = (region: HTMLElement) =>
  within(within(region).getByRole('list')).getAllByRole('listitem').map(text);

describe('Home at a glance', () => {
  test.each(SIZES)('says where the month will land, and the sum under it (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(aMonthUnderWay(), '/', { size });
    const hero = await monthEnd(size);
    // RM 8,157.00 today, less RM 189.00 of bills, plus RM 6,800.00 of pay
    await waitFor(() => expect(text(hero)).toContain('RM 14,768.00'));
    expect(text(hero)).toContain('RM 8,157.00 today − RM 189.00 bills + RM 6,800.00 pay');
    if (size === 'desktop') expect(hero.getAttribute('href')).toBe('?plan=scheduled');
  });

  test.each(SIZES)('names the month, with arrows back but not past this one (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(aMonthUnderWay(), '/', { size });
    const title = size === 'phone' ? 'November' : 'November 2026';
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Next month' }).hasAttribute('disabled')).toBe(true);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() => expect(window.location.search).toBe('?month=2026-10'));
  });

  test.each(SIZES)(
    'shows spent so far with the day of the month, and what came in (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aMonthUnderWay(), '/', { size });
      const spent = await screen.findByRole('link', { name: /^Expenses so far/ });
      await waitFor(() =>
        expect(text(spent)).toBe('Expenses so far RM 39.00 Day 10 of 30 · Food running fast'),
      );
      // Each opens its last 12 months (the owner kept them, 2026-11-17)
      expect(spent.getAttribute('href')).toBe('?plan&category=expenses');
      const income = screen.getByRole('link', { name: /^Income/ });
      expect(text(income)).toBe('Income RM 3,000.00 Salary due Nov 25');
      expect(income.getAttribute('href')).toBe('?plan&category=income');
    },
  );

  test.each(SIZES)(
    "asks to sort what's still in Other, opening Activity to do it (%s)",
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aMonthUnderWay(), '/', { size });
      await waitFor(() => expect(tidyUp()).not.toBeNull());
      const tidy = tidyUp()!;
      // The 9 November entry and the one from 20 October
      expect(text(tidy)).toBe('2 entries since Oct 1, still in Other Sort them');
      expect(within(tidy).getByRole('link', { name: 'Sort them' }).getAttribute('href')).toBe(
        `?activity&category=${OTHER_EXPENSE_ID}&from=2026-10-01&select`,
      );
    },
  );

  test.each(SIZES)(
    'lays out each day against the middle day, opening each in Activity (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aMonthUnderWay(), '/', { size });
      const days = await screen.findByRole('region', { name: 'Day by day' });
      await waitFor(() => expect(text(days)).toContain('middle day RM 1.50'));
      const grid = within(days).getByRole('grid', {
        name: 'November 2026, each day against the middle day so far',
      });
      // Weeks start on Monday, the setting's default; 1 November is a Sunday
      expect(within(grid).getAllByRole('columnheader').map(text)).toEqual([
        'M',
        'T',
        'W',
        'T',
        'F',
        'S',
        'S',
      ]);
      const firstWeek = within(grid).getAllByRole('row')[1];
      const cells = within(firstWeek).getAllByRole('gridcell');
      expect(cells).toHaveLength(7);
      expect(cells.slice(0, 6).every((c) => c.textContent === '')).toBe(true);
      expect(within(cells[6]).getByRole('link').getAttribute('aria-label')).toBe(
        'November 1, spent RM 10.00, more than the middle day',
      );

      const day = (name: string) => within(grid).getByRole('link', { name });
      expect(within(grid).getAllByRole('link')).toHaveLength(30);
      const today = day('November 10, spent RM 9.00, more than the middle day');
      expect(today.getAttribute('href')).toBe('?activity&day=2026-11-10');
      expect(today.getAttribute('aria-current')).toBe('date');
      expect(day('November 2, spent RM 0.00, less than the middle day')).toBeTruthy();
      expect(day('November 3, spent RM 3.00, more than the middle day')).toBeTruthy();
      expect(day('November 9, spent RM 12.00, more than the middle day')).toBeTruthy();
      expect(day('November 11').getAttribute('aria-current')).toBeNull();
      expect(day('November 20, TNB electricity due')).toBeTruthy();
      expect(day('November 25, Salary due')).toBeTruthy();
      expect(within(grid).getAllByRole('link', { current: 'date' })).toHaveLength(1);

      const legend = ['more', 'less', 'bill or pay due'];
      for (const words of legend) expect(within(days).getByText(words)).toBeTruthy();
      expect(within(days).queryByText('Tap a day to see it') != null).toBe(size === 'phone');

      await userEvent.setup().click(today);
      await screen.findByRole('heading', { level: 1, name: 'Activity' });
      expect(window.location.search).toBe('?activity&day=2026-11-10');
    },
  );

  test.each(SIZES)(
    'shows each budget against the month, with Plan a tap away (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aMonthUnderWay(), '/', { size });
      const budgets = await screen.findByRole('region', { name: 'Budgets' });
      expect(within(budgets).getByRole('link', { name: 'All of Plan' }).getAttribute('href')).toBe(
        '?plan',
      );
      // Food: RM 24.00 of RM 60.00 on day 10 of 30 is ahead of the month
      await waitFor(() =>
        expect(rows(budgets)).toEqual(
          size === 'phone'
            ? [
                'Food RM 36.00 left RM 24.00 of RM 60.00 · faster than the month',
                'Transport RM 27.00 left RM 3.00 of RM 30.00 · on track',
              ]
            : [
                'Food 36.00 left of RM 60.00 · faster than the month',
                'Transport 27.00 left of RM 30.00 · on track',
              ],
        ),
      );
      expect(
        within(budgets).getByRole('meter', {
          name: 'Food: 40% of budget spent, 33% of the month gone',
        }),
      ).toBeTruthy();
    },
  );

  test.each(SIZES)('lists what is coming up, and where it goes (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(aMonthUnderWay(), '/', { size });
    const coming = await screen.findByRole('region', { name: 'Coming up' });
    expect(within(coming).getByRole('link', { name: 'All scheduled' })).toBeTruthy();
    expect(rows(coming)).toEqual([
      'TNB electricity · RM 189.00 Nov 20 · Maybank Savings',
      'Salary · +RM 6,800.00 Nov 25 · Maybank Savings',
      'Rent · RM 1,200.00 Dec 1 · Maybank Savings',
    ]);
  });

  test.each(SIZES)('leaves the lists to Activity and Accounts (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(aMonthUnderWay(), '/', { size });
    await screen.findByRole('region', { name: 'Day by day' });
    expect(screen.queryByRole('heading', { name: 'Accounts' })).toBeNull();
    // Every step done: a person under way isn't shown Getting started
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });

  test('on a computer, searches everything from the top bar, and / puts the cursor there', async () => {
    tenthJustAfterMidnight();
    renderApp(aMonthUnderWay(), '/', { size: 'desktop' });
    const user = userEvent.setup();
    const search = await screen.findByRole('searchbox', { name: 'Search everything' });
    await user.keyboard('/');
    expect(document.activeElement).toBe(search);
    await user.type(search, 'kopi{Enter}');
    await screen.findByRole('heading', { level: 1, name: 'Activity' });
    expect(window.location.search).toBe('?activity&q=kopi');
  });

  test.each(SIZES)('starts the weeks on Sunday when the setting says so (%s)', async (size) => {
    tenthJustAfterMidnight();
    const server = aMonthUnderWay();
    server.me.settings.weekStart = 'sunday';
    renderApp(server, '/', { size });
    const grid = await screen.findByRole('grid', {
      name: 'November 2026, each day against the middle day so far',
    });
    expect(within(grid).getAllByRole('columnheader').map(text)).toEqual([
      'S',
      'M',
      'T',
      'W',
      'T',
      'F',
      'S',
    ]);
    const firstWeek = within(within(grid).getAllByRole('row')[1]).getAllByRole('gridcell');
    expect(within(firstWeek[0]).getByRole('link').getAttribute('aria-label')).toBe(
      'November 1, spent RM 10.00, more than the middle day',
    );
  });

  test.each(SIZES)(
    'lists a transfer coming up unsigned, from one account to the other (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      const server = firstDay();
      server.accounts.push({ ...account(CASH, 'Cash', 'cash', 20_000), position: 1 });
      server.recurring.push(
        repeating('Top-up', {
          kind: 'transfer',
          toAccountId: CASH,
          categoryId: null,
          amountCents: 30_000,
          day: 28,
          nextDue: '2026-11-28',
        }),
      );
      renderApp(server, '/', { size });
      const coming = await screen.findByRole('region', { name: 'Coming up' });
      expect(rows(coming)).toEqual(['Top-up · RM 300.00 Nov 28 · Maybank Savings to Cash']);
      // Moving money between the person's own accounts is neither a bill nor pay
      const hero = await monthEnd(size);
      await waitFor(() => expect(text(hero)).toContain('RM 5,200.00 today'));
      expect(text(hero)).not.toContain('bills');
      expect(text(hero)).not.toContain('pay');
    },
  );

  test.each(SIZES)(
    "an earlier month shows what was left, and its days without what's due (%s)",
    async (size) => {
      tenthJustAfterMidnight();
      const server = aMonthUnderWay();
      entry(server, '2026-10-05', 10_000, SALARY, { kind: 'income', accountId: BANK });
      renderApp(server, '/?month=2026-10', { size });
      const left = await monthEnd(size, 'Left in October');
      // RM 100.00 came in, RM 4.00 went out
      await waitFor(() => expect(text(left)).toContain('RM 96.00'));
      expect(text(left)).not.toContain('−');
      expect(screen.queryByText('Expected at month end')).toBeNull();
      expect(tidyUp()).toBeNull();
      const grid = await screen.findByRole('grid', {
        name: 'October 2026, each day against the middle day so far',
      });
      expect(within(grid).getAllByRole('link')).toHaveLength(31);
      expect(
        within(grid).getByRole('link', {
          name: 'October 20, spent RM 4.00, more than the middle day',
        }),
      ).toBeTruthy();
      expect(within(grid).queryAllByRole('link', { name: /due$/ })).toEqual([]);
      expect(within(grid).queryAllByRole('link', { current: 'date' })).toEqual([]);
      await userEvent.setup().click(screen.getByRole('button', { name: 'Next month' }));
      await waitFor(() => expect(window.location.search).toBe(''));
    },
  );
});

describe('the first day', () => {
  test.each(SIZES)(
    'starts from the one account, with nothing spent or scheduled (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(firstDay(), '/', { size });
      const hero = await monthEnd(size);
      await waitFor(() => expect(text(hero)).toContain('RM 5,000.00'));
      expect(text(hero)).toContain('Maybank Savings today');
      const spent = screen.getByRole('link', { name: /^Expenses so far/ });
      expect(text(spent)).toBe('Expenses so far RM 0.00 None yet');
      const income = screen.getByRole('link', { name: /^Income/ });
      expect(text(income)).toBe('Income RM 0.00 No pay scheduled');
      expect(tidyUp()).toBeNull();
      expect(screen.queryByRole('region', { name: 'Coming up' })).toBeNull();

      const budgets = screen.getByRole('region', { name: 'Budgets' });
      expect(within(budgets).getByText('No budgets yet.')).toBeTruthy();
      expect(within(budgets).getByRole('link', { name: 'Set a budget' }).getAttribute('href')).toBe(
        '?settings=categories',
      );
      const days = screen.getByRole('region', { name: 'Day by day' });
      expect(within(days).getByText('Fills in as you log.')).toBeTruthy();
      expect(within(days).queryByRole('grid')).toBeNull();
    },
  );

  test.each(SIZES)('lists the five steps to get going, one done (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(firstDay(), '/', { size });
    const started = await screen.findByRole('region', { name: 'Getting started' });
    await waitFor(() => expect(text(started)).toContain('1 of 5 done ·'));
    expect(rows(started)).toEqual([
      'Add where your money is Maybank Savings, RM 5,000.00',
      'Log your first expense Amount, category, Save Add',
      "Bring in past months From a bank's CSV Import",
      'Add rent, bills and pay Counted in the month end Schedule',
      'Set a budget A monthly amount per category Set one',
    ]);
    // Each step still to do is a tap from where it's done: the whole row, named by what it says
    const go = (title: string) =>
      within(started).getByRole('link', { name: new RegExp(`^${title}`) });
    expect(go('Bring in past months').getAttribute('href')).toBe('?settings=data');
    expect(go('Add rent, bills and pay').getAttribute('href')).toBe('?plan=scheduled');
    expect(go('Set a budget').getAttribute('href')).toBe('?settings=categories');
    // Add opens a new entry; logging one ticks off its step
    const user = userEvent.setup();
    await user.click(within(started).getByRole('button', { name: /^Log your first expense/ }));
    const form = await addForm();
    await typeAmount(form, '12');
    await user.click(addSaveButton(form));
    await waitFor(() =>
      expect(screen.queryByRole('form', { name: 'Add a transaction' })).toBeNull(),
    );
    await waitFor(() => expect(text(started)).toContain('2 of 5 done ·'));
    expect(within(started).queryByRole('button', { name: /^Log your first expense/ })).toBeNull();
  });

  test.each([
    [
      'an entry last month',
      (server: FakeServer) => {
        server.accounts.push({ ...account(CASH, 'Cash', 'cash', 20_000), position: 1 });
        // Spending last month only: the past is filled in, this month's first expense isn't
        entry(server, '2026-10-14', 500, FOOD);
      },
      "Bring in past months From a bank's CSV",
      'Bring in past months',
    ],
    [
      'a repeating item',
      (server: FakeServer) => {
        server.recurring.push(repeating('Rent', { amountCents: 120_000, nextDue: '2026-12-01' }));
      },
      'Add rent, bills and pay Counted in the month end',
      'Add rent, bills and pay',
    ],
    [
      'a budget this month',
      (server: FakeServer) => {
        // A budget is set on a saved category: the first change saves the defaults
        server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
        server.budgets.push({
          categoryId: FOOD,
          fromMonth: '2026-11',
          amountCents: 6_000,
          carryOver: false,
        });
      },
      'Set a budget A monthly amount per category',
      'Set a budget',
    ],
  ] as const)('ticks off its step with %s', async (_what, add, step, go) => {
    tenthJustAfterMidnight();
    const server = firstDay();
    add(server);
    renderApp(server, '/', { size: 'phone' });
    const started = await screen.findByRole('region', { name: 'Getting started' });
    await waitFor(() => expect(text(started)).toContain('2 of 5 done ·'));
    expect(rows(started)).toContain(step);
    expect(within(started).queryByRole('link', { name: new RegExp(`^${go}`) })).toBeNull();
    expect(within(started).queryByRole('button', { name: new RegExp(`^${go}`) })).toBeNull();
  });

  test.each(SIZES)('Hide puts Getting started away on this device for good (%s)', async (size) => {
    tenthJustAfterMidnight();
    const server = firstDay();
    renderApp(server, '/', { size });
    const started = await screen.findByRole('region', { name: 'Getting started' });
    await userEvent.setup().click(within(started).getByRole('button', { name: 'Hide' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull(),
    );
    await reloadApp(server, '/', { size });
    await screen.findByRole('region', { name: 'Day by day' });
    expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
  });
});

describe('what Home keeps and offers whatever loads first', () => {
  const hiddenFor = (email: string) => `getting-started-hidden:${email}`;

  // The figures wait for who's signed in (the device's copies are kept per account), so
  // Home can't show before the profile; this holds that a slow profile still finds Hide
  test.each(SIZES)(
    "keeps Getting started hidden when who's signed in is slow to answer (%s)",
    async (size) => {
      tenthJustAfterMidnight();
      const server = firstDay();
      // Hidden on this device before, by this account
      localStorage.setItem(hiddenFor(server.me.email), '1');
      const me = holdNext(server, 'GET', '/api/me');
      renderApp(server, '/', { size });
      try {
        await new Promise((r) => setTimeout(r, 300));
        expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
      } finally {
        me.release();
      }
      await screen.findByText('Fills in as you log.');
      await new Promise((r) => setTimeout(r, 100));
      expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull();
      // Nothing is kept on the device without an account to keep it for
      expect(localStorage.getItem(hiddenFor(''))).toBeNull();
    },
  );

  test("another account on this device doesn't inherit Hide", async () => {
    tenthJustAfterMidnight();
    const server = firstDay();
    localStorage.setItem(hiddenFor(server.me.email), '1');
    server.me = { ...server.me, email: 'ann@example.com', displayName: 'Ann' };
    renderApp(server, '/', { size: 'phone' });
    const started = await screen.findByRole('region', { name: 'Getting started' });
    await userEvent.setup().click(within(started).getByRole('button', { name: 'Hide' }));
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Getting started' })).toBeNull(),
    );
    expect(localStorage.getItem(hiddenFor('ann@example.com'))).toBe('1');
    expect(localStorage.getItem(hiddenFor(''))).toBeNull();
  });

  test('keeps the way to Settings when the accounts fail to load (phone)', async () => {
    tenthJustAfterMidnight();
    const server = firstDay();
    server.pathsDown.add('/api/accounts');
    renderApp(server, '/', { size: 'phone' });
    expect(await screen.findByText("Couldn't load your accounts.")).toBeTruthy();
    expect(await screen.findByRole('link', { name: 'You and settings' })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^Switch to (light|dark) mode$/ })).toBeTruthy();
  });

  test.each(SIZES)("asks about what's due now, this month only (%s)", async (size) => {
    tenthJustAfterMidnight();
    const server = firstDay();
    server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    server.recurring.push(
      repeating('Rent', { amountCents: 5_000, day: 10, nextDue: '2026-11-10' }),
    );
    renderApp(server, '/', { size });
    const due = await screen.findByText('Due: Rent RM 50.00 from Maybank Savings');
    const row = within(screen.getByRole('group', { name: due.textContent ?? '' }));
    await userEvent.setup().click(row.getByRole('button', { name: 'Log it' }));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    expect(server.transactions[0]).toMatchObject({
      payee: 'Rent',
      amountCents: 5_000,
      date: '2026-11-10',
    });
    await waitFor(() => expect(screen.queryByText(/^Due: Rent/)).toBeNull());

    server.recurring[0].nextDue = '2026-11-10';
    await reloadApp(server, '/?month=2026-10', { size });
    await screen.findByText(/^Left in October/);
    await new Promise((r) => setTimeout(r, 100));
    expect(screen.queryByText(/^Due: /)).toBeNull();
  });
});

describe('the first run', () => {
  test.each(SIZES)(
    'asks where the money is kept, before there is an account (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(fakeServer(), '/', { size });
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Where do you keep your money?' }),
      ).toBeTruthy();
      for (const words of [
        'Mahnee',
        "Add each one with today's balance. No bank login.",
        'Comes with 8 expense and 2 income categories. Edit them any time.',
        "Importing a bank's CSV? Add that account first.",
        'Works offline',
      ]) {
        expect(screen.getByText(words)).toBeTruthy();
      }
      expect(
        screen.getAllByRole('button', { name: /^(Bank|E-wallet|Card|Cash)/ }).map(text),
      ).toEqual([
        'Bank Savings or current',
        "E-wallet Touch 'n Go, GrabPay, ShopeePay",
        "Card You enter what's owed",
        'Cash In your wallet',
      ]);
      // No tab bar or sidebar yet, and none of Home
      expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
      expect(screen.queryByText('Expected at month end')).toBeNull();
    },
  );

  test.each(SIZES)('adds the account of the kind picked, then shows Home (%s)', async (size) => {
    tenthJustAfterMidnight();
    renderApp(fakeServer(), '/', { size });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /^Card/ }));
    const dialog = within(await screen.findByRole('dialog', { name: 'Add account' }));
    expect(dialog.getByRole<HTMLInputElement>('radio', { name: 'Card' }).checked).toBe(true);
    await user.type(dialog.getByRole('textbox', { name: 'Name' }), 'Visa');
    await user.type(dialog.getByRole('textbox', { name: 'Amount owed' }), '120');
    await user.click(dialog.getByRole('button', { name: 'Add account' }));
    expect(await screen.findByRole('navigation', { name: 'Main' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Where do you keep your money?' })).toBeNull();
    const hero = await monthEnd(size);
    await waitFor(() => expect(text(hero)).toContain('−RM 120.00'));
  });
});
