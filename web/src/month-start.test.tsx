// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get, keys, set } from 'idb-keyval';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { BudgetRow } from '@shared/budgets';
import type { MonthSummary, Recurring, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES, OTHER_EXPENSE_ID } from '@shared/categories';
import type { FakeServer } from './testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from './testing/app';

// Every monthly figure follows the month start day (owner decision D7): Home's month, its
// days, Tidy up, the month end and budgets; Plan and its budgets with what carried over;
// Activity's and an account's "This month" and "Last month"; a new budget's first month;
// and Change category's budget line. Here the month starts on the 25th and it is
// 26 November 2026, so this month is "December" (November 25 to December 24, day 2 of 30)
// and last month "November" (October 25 to November 24). The months kept on the device
// are dropped when the start day changes, so none is shown for the wrong days.

const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

test('the zone is in effect: Kuala Lumpur, eight hours ahead of UTC', () => {
  expect(new Date(2026, 10, 26).getTimezoneOffset()).toBe(-480);
});

const SIZES = ['phone', 'desktop'] as const;
const WALLET = 'a'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, BILLS] = [id('Food'), id('Transport'), id('Bills')];

/**
 * 00:30 on Thursday 26 November 2026 where the person is (still the 25th in UTC), or on
 * `day`; the clock still ticks, and the answer moves it on
 */
function onThe26th(day = 26) {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, day, 0, 30, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return (ms: number) => vi.setSystemTime(Date.now() + ms);
}

const HOUR_MS = 60 * 60 * 1000;
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

/** The connection drops: the browser says so, and nothing reaches the server */
function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  act(() => void window.dispatchEvent(new Event('offline')));
  onTestFinished(() => onLine.mockRestore());
}

/** Moves the app to `path`, as a link inside it does */
function go(path: string) {
  window.history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

/** Each 12 months' bar read out ("Nov 2026, RM 16.00"), newest last */
const bars = (region: HTMLElement) =>
  within(region)
    .getAllByRole('listitem')
    .map((li) => /[A-Z][a-z]{2} \d{4}, RM [\d,.]+/.exec(li.textContent ?? '')?.[0] ?? '');

let seeded = 0;
function entry(server: FakeServer, date: string, amountCents: number, categoryId: string) {
  seeded++;
  const t: Transaction = {
    id: seeded.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents,
    categoryId,
    payee: null,
    note: `entry ${seeded}`,
    date,
    createdAt: seeded,
  };
  server.transactions.push(t);
}

const bill = (rid: string, payee: string, day: number, nextDue: string, cents: number) =>
  ({
    id: rid,
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: cents,
    categoryId: BILLS,
    payee,
    schedule: 'monthly',
    day,
    startDate: '2026-01-01',
    nextDue,
    archived: false,
  }) satisfies Recurring;

/**
 * The Wallet with RM 100.00, its month starting on the 25th. Food: 4.00 on Nov 24 (last
 * month) and 8.00 on Nov 25; Transport 2.00 today. Other: 16.00 on Oct 24 and 32.00 on
 * Oct 25. Food has a RM 50.00 budget from November with Carry over, so November left
 * RM 46.00. TNB (RM 189.00) is due Dec 20, before this month ends; Rent (RM 1,000.00) on
 * Dec 26, after it.
 */
function fromThe25th(monthStartDay = 25): FakeServer {
  seeded = 0;
  const server = fakeServer();
  server.me.settings = { ...server.me.settings, monthStartDay };
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
  entry(server, '2026-10-24', 1_600, OTHER_EXPENSE_ID);
  entry(server, '2026-10-25', 3_200, OTHER_EXPENSE_ID);
  entry(server, '2026-11-24', 400, FOOD);
  entry(server, '2026-11-25', 800, FOOD);
  entry(server, '2026-11-26', 200, TRANSPORT);
  const food: BudgetRow = {
    categoryId: FOOD,
    fromMonth: '2026-11',
    amountCents: 5_000,
    carryOver: true,
  };
  server.budgets.push(food);
  server.recurring.push(
    bill('e'.repeat(16), 'TNB', 20, '2026-12-20', 18_900),
    bill('d'.repeat(16), 'Rent', 26, '2026-12-26', 100_000),
  );
  return server;
}

/** What an element reads as: its text pieces in order, one space between each */
function text(el: Element) {
  const parts: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent ?? '');
    else node.childNodes.forEach(walk);
  };
  walk(el);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/** The months' totals and 12 months kept on the device, by key, with whose each is */
async function copies() {
  const found: Record<string, string | undefined> = {};
  for (const key of await keys()) {
    if (typeof key !== 'string' || !/^(summary|trend)-v\d+:/.test(key)) continue;
    found[key] = (await get<{ email: string }>(key))?.email;
  }
  return found;
}

/** The ones kept for `email` */
const copiesOf = async (email: string) =>
  Object.entries(await copies())
    .filter(([, whose]) => whose === email)
    .map(([key]) => key)
    .sort();

/**
 * Home and its 12 months of spending seen once, from the 1st (November): both kept on the
 * device, as summary-v3:2026-11 and trend-v3:2026-11, the signed-in person's; and another
 * account's copy, kept on the same device before
 */
async function seenFromThe1st(server: FakeServer) {
  renderApp(server, '/', { size: 'phone' });
  expect(await screen.findByRole('heading', { level: 1, name: 'November' })).toBeTruthy();
  go('/?plan&category=expenses');
  expect(await screen.findByText(/^Spent in November · /)).toBeTruthy();
  await waitFor(async () =>
    expect(await copiesOf(server.me.email)).toEqual(['summary-v3:2026-11', 'trend-v3:2026-11']),
  );
  const november = await get<{ value: MonthSummary }>('summary-v3:2026-11');
  expect(november?.value).toMatchObject({ firstDay: '2026-11-01', lastDay: '2026-11-30' });
  // Kept now the person is signed in (signing in drops what isn't theirs)
  await set('summary-v3:2026-10', { email: 'ann@example.com', value: { month: '2026-10' } });
}

/** Opens Settings › Money's "Month starts on" */
async function openMonth() {
  go('/?settings=money');
  const user = userEvent.setup();
  const card = within(await screen.findByRole('region', { name: 'Money' }));
  await user.click(await card.findByRole('button', { name: /^Month starts on/ }));
  const sheet = within(await screen.findByRole('dialog', { name: 'Month starts on' }));
  return { user, sheet };
}

/** The search requests the app sent, as their query strings */
const searchesAsked = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(([path]) => (typeof path === 'string' ? path : ''))
    .filter((p) => p.startsWith('/api/search'))
    .map((p) => new URLSearchParams(p.slice(p.indexOf('?') + 1)));

const asksFor = (from: string, to: string) =>
  searchesAsked().some((q) => q.get('from') === from && q.get('to') === to);

describe('Home, with the month from the 25th', () => {
  test.each(SIZES)(
    'names the month for most of its days, and counts day 2 of 30 (%s)',
    async (size) => {
      onThe26th();
      renderApp(fromThe25th(), '/', { size });
      const title = size === 'phone' ? 'December' : 'December 2026';
      expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
      const spent = await screen.findByRole('link', { name: /^Expenses so far/ });
      // 8.00 on the 25th and 2.00 today; the 4.00 on the 24th was last month's
      await waitFor(() => expect(text(spent)).toMatch(/^Expenses so far RM 10\.00 Day 2 of 30/));
    },
  );

  test.each(SIZES)('lays out the days from the 25th to the 24th (%s)', async (size) => {
    onThe26th();
    renderApp(fromThe25th(), '/', { size });
    const days = await screen.findByRole('region', { name: 'Day by day' });
    const grid = await within(days).findByRole('grid', {
      name: 'December 2026, each day against the middle day so far',
    });
    await waitFor(() => expect(within(grid).getAllByRole('link')).toHaveLength(30));
    const links = within(grid).getAllByRole('link');
    await waitFor(() =>
      expect(links[0].getAttribute('aria-label')).toBe(
        'November 25, spent RM 8.00, more than the middle day',
      ),
    );
    expect(links[1].getAttribute('aria-current')).toBe('date');
    expect(links[1].getAttribute('aria-label')).toBe(
      'November 26, spent RM 2.00, less than the middle day',
    );
    expect(links.at(-1)!.getAttribute('aria-label')).toMatch(/^December 24/);
    // Weeks from Monday: 25 November is a Wednesday, two days in
    const firstWeek = within(grid).getAllByRole('row')[1];
    const cells = within(firstWeek).getAllByRole('gridcell');
    expect(cells.slice(0, 2).every((c) => c.textContent === '')).toBe(true);
  });

  test.each(SIZES)("counts Tidy up from last month's first day (%s)", async (size) => {
    onThe26th();
    renderApp(fromThe25th(), '/', { size });
    await waitFor(() =>
      expect(
        screen.queryAllByRole('status').find((s) => /still in Other/.test(s.textContent ?? '')),
      ).toBeTruthy(),
    );
    const tidy = screen
      .queryAllByRole('status')
      .find((s) => /still in Other/.test(s.textContent ?? ''))!;
    // The 32.00 on October 25; the 16.00 the day before was the month before last
    expect(text(tidy)).toBe('1 entry since Oct 25, still in Other Sort them');
    expect(within(tidy).getByRole('link', { name: 'Sort them' }).getAttribute('href')).toBe(
      `?activity&category=${OTHER_EXPENSE_ID}&from=2026-10-25&select`,
    );
  });

  test('expects the month to end on the 24th: bills before it count, after it not', async () => {
    onThe26th();
    renderApp(fromThe25th(), '/', { size: 'phone' });
    const hero = await screen.findByRole('region', { name: 'Expected at month end' });
    // RM 100.00 less the 62.00 spent, and TNB's RM 189.00 on December 20; Rent on the 26th
    // is next month's
    await waitFor(() => expect(text(hero)).toContain('RM 38.00 today − RM 189.00 bills'));
  });

  test('shows each budget with what last month left carried over', async () => {
    onThe26th();
    renderApp(fromThe25th(), '/', { size: 'phone' });
    const budgets = await screen.findByRole('region', { name: 'Budgets' });
    // RM 50.00 and the RM 46.00 November left; 8.00 spent so far
    await waitFor(() => expect(text(budgets)).toContain('Food RM 88.00 left RM 8.00 of RM 96.00'));
  });

  test.each(SIZES)('goes back to last month, October 25 to November 24 (%s)', async (size) => {
    onThe26th();
    renderApp(fromThe25th(), '/', { size });
    await screen.findByRole('heading', {
      level: 1,
      name: size === 'phone' ? 'December' : 'December 2026',
    });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() => expect(window.location.search).toBe('?month=2026-11'));
    expect(
      await screen.findByRole('heading', {
        level: 1,
        name: size === 'phone' ? 'November' : 'November 2026',
      }),
    ).toBeTruthy();
    const grid = await screen.findByRole('grid', {
      name: /^November 2026, each day against the middle day/,
    });
    await waitFor(() => expect(within(grid).getAllByRole('link')).toHaveLength(31));
    expect(within(grid).getAllByRole('link')[0].getAttribute('aria-label')).toMatch(
      /^October 25, spent RM 32\.00/,
    );
    // The next month is this one again, at Home's own address
    await userEvent.setup().click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(() => expect(window.location.search).toBe(''));
  });

  test('payday: the month runs from the pay, named for the month it ends in', async () => {
    onThe26th();
    const server = fromThe25th(1);
    const pay: Recurring = {
      ...bill('c'.repeat(16), 'Acme', 20, '2026-12-20', 500_000),
      kind: 'income',
      categoryId: id('Salary'),
    };
    server.recurring = [pay];
    server.me.settings = {
      ...server.me.settings,
      monthStartMode: 'payday',
      monthStartPayId: pay.id,
    };
    renderApp(server, '/', { size: 'phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'December' })).toBeTruthy();
    const spent = await screen.findByRole('link', { name: /^Expenses so far/ });
    // November 20 to December 19: 4.00, 8.00 and 2.00
    await waitFor(() => expect(text(spent)).toMatch(/^Expenses so far RM 14\.00 Day 7 of 30/));
  });
});

describe("the person's own day", () => {
  test('at 00:30 on November 25 there (still the 24th in UTC), it is December, day 1 of 30', async () => {
    onThe26th(25);
    renderApp(fromThe25th(), '/', { size: 'phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'December' })).toBeTruthy();
    const spent = await screen.findByRole('link', { name: /^Expenses so far/ });
    await waitFor(() => expect(text(spent)).toMatch(/ Day 1 of 30/));
  });

  test.each([
    ['/?month=2027-03', ''],
    ['/?month=2026-12', ''],
  ])('an address past this month (%s) shows this month', async (path, after) => {
    onThe26th();
    renderApp(fromThe25th(), path, { size: 'phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'December' })).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(after));
  });

  test('last month at its own address is October 25 to November 24', async () => {
    onThe26th();
    renderApp(fromThe25th(), '/?month=2026-11', { size: 'phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'November' })).toBeTruthy();
    expect(await screen.findByText(/^Left in November/)).toBeTruthy();
    expect(window.location.search).toBe('?month=2026-11');
  });
});

describe('a pay changed in Plan › Scheduled while the month starts on payday', () => {
  test('moves the month with it, and once it stops the month is back on its date', async () => {
    onThe26th();
    const server = fromThe25th(1);
    const pay: Recurring = {
      ...bill('c'.repeat(16), 'Acme', 20, '2026-11-20', 500_000),
      kind: 'income',
      categoryId: id('Salary'),
    };
    server.recurring = [pay];
    server.me.settings = {
      ...server.me.settings,
      monthStartMode: 'payday',
      monthStartPayId: pay.id,
    };
    renderApp(server, '/', { size: 'phone' });
    const spentLine = async () =>
      text(await screen.findByRole('link', { name: /^Expenses so far/ }));
    // November 20 to December 19
    await waitFor(async () =>
      expect(await spentLine()).toMatch(/^Expenses so far RM 14\.00 Day 7 of 30/),
    );

    const user = userEvent.setup();
    go('/?plan=scheduled');
    await user.click(await screen.findByRole('button', { name: /^Expected at month end/ }));
    let list = within(await screen.findByRole('dialog', { name: 'Expected at month end' }));
    await user.click(list.getByRole('button', { name: /^Acme/ }));
    let sheet = within(await screen.findByRole('dialog', { name: 'Repeating' }));
    await user.selectOptions(sheet.getByLabelText('On day'), '25');
    await user.click(sheet.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.recurring[0].day).toBe(25));

    // November 25 to December 24, with no reload
    go('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'December' })).toBeTruthy();
    await waitFor(async () =>
      expect(await spentLine()).toMatch(/^Expenses so far RM 10\.00 Day 2 of 30/),
    );

    go('/?plan=scheduled');
    await user.click(await screen.findByRole('button', { name: /^Expected at month end/ }));
    list = within(await screen.findByRole('dialog', { name: 'Expected at month end' }));
    await user.click(list.getByRole('button', { name: /^Acme/ }));
    sheet = within(await screen.findByRole('dialog', { name: 'Repeating' }));
    await user.click(sheet.getByRole('button', { name: 'Stop repeating' }));
    await waitFor(() => expect(server.me.settings.monthStartMode).toBe('date'));

    // Back on the 1st: November, day 26 of 30
    go('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'November' })).toBeTruthy();
    await waitFor(async () =>
      expect(await spentLine()).toMatch(/^Expenses so far RM 14\.00 Day 26 of 30/),
    );
  });
});

describe('Plan, with the month from the 25th', () => {
  test.each(SIZES)(
    'names the month and its day, and its budgets carry over by month (%s)',
    async (size) => {
      onThe26th();
      renderApp(fromThe25th(), '/?plan', { size });
      expect(
        await screen.findByText(size === 'phone' ? 'Dec 2026' : 'December 2026 · day 2 of 30'),
      ).toBeTruthy();
      if (size === 'phone') {
        const budgets = await screen.findByRole('region', { name: /^Budgets/ });
        await waitFor(() => expect(text(budgets)).toContain('RM 8.00 of RM 96.00'));
      } else {
        // A computer's table: Food's spent and left, RM 96.00 less 8.00
        const table = await screen.findByRole('table', { name: 'Expenses by category' });
        await waitFor(() =>
          expect(
            within(table)
              .getAllByRole('row')
              .map((row) => text(row))
              .find((row) => row.startsWith('Food')),
          ).toMatch(/ 8\.00 88\.00$/),
        );
      }
      await userEvent.setup().click(screen.getByRole('button', { name: 'Previous month' }));
      await waitFor(() => expect(window.location.search).toBe('?plan&month=2026-11'));
      expect(await screen.findByText(size === 'phone' ? 'Nov 2026' : 'November 2026')).toBeTruthy();
    },
  );

  test('a budget set now starts from this month, December', async () => {
    onThe26th();
    const server = fromThe25th();
    renderApp(server, '/?settings=categories', { size: 'desktop' });
    const user = userEvent.setup();
    const spending = within(await screen.findByRole('region', { name: 'Expenses' }));
    await user.click(await spending.findByRole('button', { name: 'Transport' }));
    const form = within(await screen.findByRole('dialog'));
    await user.type(form.getByLabelText('Monthly budget'), '30');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(server.budgets).toContainEqual(
        expect.objectContaining({
          categoryId: TRANSPORT,
          fromMonth: '2026-12',
          amountCents: 3_000,
        }),
      ),
    );
    // This month's budgets list it at once
    expect(await spending.findByText('RM 30 a month')).toBeTruthy();
  });
});

describe('12 months, with the month from the 25th', () => {
  test("Home's Expenses so far opens 12 months by the month's own days, with the usual", async () => {
    onThe26th();
    renderApp(fromThe25th(), '/?plan&category=expenses', { size: 'phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'All expenses' })).toBeTruthy();
    // December 10.00 against (36.00 + 16.00) / 11 = 4.727..., RM 4.73 to the cent
    expect(
      await screen.findByText('Spent in December · RM 5.27 over your usual RM 4.73'),
    ).toBeTruthy();
    const year = screen.getByRole('region', { name: /^All expenses, last 12 months/ });
    expect(bars(year).slice(-3)).toEqual([
      // September 25 to October 24: 16.00 in Other
      'Oct 2026, RM 16.00',
      // October 25 to November 24: 32.00 in Other and 4.00 on Food
      'Nov 2026, RM 36.00',
      'Dec 2026, RM 10.00',
    ]);
  });

  test("a category's page on a computer sets a budget from this month, December", async () => {
    onThe26th();
    const server = fromThe25th();
    renderApp(server, `/?plan&category=${TRANSPORT}`, { size: 'desktop' });
    const user = userEvent.setup();
    const pane = await screen.findByRole('complementary', { name: 'Transport' });
    await user.type(within(pane).getByLabelText('Monthly budget'), '30{Enter}');
    await waitFor(() =>
      expect(server.budgets).toContainEqual(
        expect.objectContaining({
          categoryId: TRANSPORT,
          fromMonth: '2026-12',
          amountCents: 3_000,
        }),
      ),
    );
  });
});

describe("Activity and an account's days, with the month from the 25th", () => {
  test.each(SIZES)(
    'This month is November 25 to December 24, Last month the one before (%s)',
    async (size) => {
      onThe26th();
      renderApp(fromThe25th(), '/?activity', { size });
      await screen.findByRole('heading', { level: 1, name: 'Activity' });
      await waitFor(() => expect(asksFor('2026-11-25', '2026-12-24')).toBe(true));
      const user = userEvent.setup();
      await user.click(screen.getByRole('button', { name: /^This month/ }));
      const list = within(await screen.findByRole('dialog'));
      await user.click(list.getByRole('radio', { name: 'Last month' }));
      await waitFor(() =>
        expect(window.location.search).toBe('?activity&from=2026-10-25&to=2026-11-24'),
      );
      await waitFor(() => expect(asksFor('2026-10-25', '2026-11-24')).toBe(true));
      // Read back as Last month, not as some dates
      expect(screen.getByRole('button', { name: /^Last month/ })).toBeTruthy();
    },
  );

  test("an account's This month is the same days", async () => {
    onThe26th();
    renderApp(fromThe25th(), `/?account=${WALLET}`, { size: 'desktop' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Any date' }));
    const picker = within(await screen.findByRole('dialog'));
    await user.click(picker.getByRole('radio', { name: 'This month' }));
    await waitFor(() => expect(asksFor('2026-11-25', '2026-12-24')).toBe(true));
    expect(await screen.findByRole('button', { name: 'This month' })).toBeTruthy();
  });

  test("Change category's budget line is this month's: November 25 on", async () => {
    onThe26th();
    renderApp(fromThe25th(), '/?activity', { size: 'phone' });
    await screen.findByRole('heading', { level: 1, name: 'Activity' });
    const user = userEvent.setup();
    await screen.findAllByText(/entry 5/);
    await user.click(screen.getByRole('button', { name: 'Select' }));
    await user.click(screen.getByRole('checkbox', { name: /^entry 5, / }));
    await user.click(screen.getByRole('button', { name: 'Change category' }));
    const sheet = within(await screen.findByRole('dialog'));
    await user.click(
      within(sheet.getByRole('radiogroup', { name: 'Move to' })).getByRole('radio', {
        name: 'Food',
      }),
    );
    // RM 96.00 available, 8.00 spent: 2.00 more leaves RM 86.00
    expect(sheet.getByText('Food budget: RM 88.00 → RM 86.00 left')).toBeTruthy();
  });
});

describe('changing the month start day', () => {
  test("drops this account's months kept on the device before anything is fetched again", async () => {
    onThe26th();
    const server = fromThe25th(1);
    await seenFromThe1st(server);

    const { user, sheet } = await openMonth();
    await user.click(sheet.getByRole('radio', { name: '25' }));
    const summary = holdNext(server, 'GET', '/api/summary');
    const trend = holdNext(server, 'GET', '/api/summary/trend');
    try {
      await user.click(sheet.getByRole('button', { name: 'Done' }));
      await waitFor(() => expect(server.me.settings.monthStartDay).toBe(25));
      await waitFor(async () => expect(await copiesOf(server.me.email)).toEqual([]));
      // Another account's stay as they were
      expect((await copies())['summary-v3:2026-10']).toBe('ann@example.com');
    } finally {
      summary.release();
      trend.release();
    }

    go('/');
    expect(await screen.findByRole('heading', { level: 1, name: 'December' })).toBeTruthy();
    const spent = await screen.findByRole('link', { name: /^Expenses so far/ });
    await waitFor(() => expect(text(spent)).toMatch(/^Expenses so far RM 10\.00 Day 2 of 30/));
    await waitFor(async () =>
      expect((await get<{ value: MonthSummary }>('summary-v3:2026-12'))?.value).toMatchObject({
        firstDay: '2026-11-25',
        lastDay: '2026-12-24',
      }),
    );
  });

  test('drops them too when the save fails, and the month is back on the 1st', async () => {
    onThe26th();
    const server = fromThe25th(1);
    await seenFromThe1st(server);
    const { user, sheet } = await openMonth();
    await user.click(sheet.getByRole('radio', { name: '25' }));
    server.failNext.profile = 500;
    await user.click(sheet.getByRole('button', { name: 'Done' }));
    expect(await screen.findByText('Something went wrong. Try again in a moment.')).toBeTruthy();
    await waitFor(async () => expect(await copiesOf(server.me.email)).toEqual([]));
    expect(server.me.settings.monthStartDay).toBe(1);
    const card = within(await screen.findByRole('region', { name: 'Money' }));
    await waitFor(() =>
      expect(card.getByRole('button', { name: /^Month starts on/ }).textContent).toContain(
        'The 1st',
      ),
    );
  });

  test('drops them when the month moves to payday, or to another pay', async () => {
    onThe26th();
    const server = fromThe25th(1);
    const salary = (rid: string, payee: string, day: number): Recurring => ({
      ...bill(rid, payee, day, `2026-12-${String(day).padStart(2, '0')}`, 500_000),
      kind: 'income',
      categoryId: id('Salary'),
    });
    server.recurring = [salary('c'.repeat(16), 'Acme', 20), salary('b'.repeat(16), 'Side job', 5)];
    await seenFromThe1st(server);

    let { user, sheet } = await openMonth();
    await user.click(sheet.getByRole('radio', { name: 'Payday' }));
    await user.click(sheet.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(server.me.settings.monthStartMode).toBe('payday'));
    await waitFor(async () => expect(await copiesOf(server.me.email)).toEqual([]));

    // Seen again from Acme's 20th, then moved to the side job's 5th
    go('/?plan&category=expenses');
    expect(await screen.findByText(/^Spent in December · /)).toBeTruthy();
    await waitFor(async () =>
      expect(await copiesOf(server.me.email)).toEqual(['summary-v3:2026-12', 'trend-v3:2026-12']),
    );
    ({ user, sheet } = await openMonth());
    await user.click(sheet.getByRole('button', { name: /Acme · the 20th/ }));
    await user.click(await screen.findByRole('menuitem', { name: /Side job · the 5th/ }));
    await user.click(sheet.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(server.me.settings.monthStartPayId).toBe('b'.repeat(16)));
    await waitFor(async () => expect(await copiesOf(server.me.email)).toEqual([]));
  });

  test("the freshness label judges this month's copy, December's", async () => {
    const moveOn = onThe26th();
    const server = fromThe25th();
    // December seen with a connection
    renderApp(server, '/', { size: 'desktop' });
    expect(await screen.findByRole('heading', { level: 1, name: 'December 2026' })).toBeTruthy();
    await screen.findByRole('link', { name: /^Expenses so far/ });
    await wait(100);
    // An hour on, November and the balances seen again
    moveOn(HOUR_MS);
    await reloadApp(server, '/?month=2026-11', { size: 'desktop' });
    expect(await screen.findByText(/^Left in November/)).toBeTruthy();
    await wait(100);
    // An hour after that, offline: December was last confirmed two hours ago, November and
    // the balances one hour ago. The sidebar judges this month's, December's.
    moveOn(HOUR_MS);
    goOffline(server);
    await reloadApp(server, '/', { size: 'desktop' });
    expect(await screen.findByRole('heading', { level: 1, name: 'December 2026' })).toBeTruthy();
    // The sidebar comes once the accounts are known, after the heading
    const sidebar = await screen.findByRole('complementary');
    expect(await within(sidebar).findByText('From this device, 2 h old')).toBeTruthy();
  });
});

describe('what stays on the calendar', () => {
  test("export's This year is still January 1 to December 31", async () => {
    onThe26th();
    renderApp(fromThe25th(), '/?settings=data', { size: 'phone' });
    const user = userEvent.setup();
    const exporting = within(await screen.findByRole('region', { name: 'Export' }));
    await user.click(await exporting.findByRole('radio', { name: 'This year' }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.map(([path]) => (typeof path === 'string' ? path : ''))
          .some((p) => p.startsWith('/api/export/summary?from=2026-01-01&to=2026-12-31')),
      ).toBe(true),
    );
  });
});
