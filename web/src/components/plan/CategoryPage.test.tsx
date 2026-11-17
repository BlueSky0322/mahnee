// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Category, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  addEntry,
  fakeServer,
  holdNext,
  reloadApp,
  renderApp,
  setupAppTests,
} from '../../testing/app';

// A category over 12 months (R-Category; on a computer the right pane of R-Desk-Plan; digest
// 3.7): what was spent in it this month against the usual (the average of the 11 months
// before), its last 12 months as bars with the month shown picked out, what's inside it, its
// budget, and its entries a tap away in Activity. On phones and tablets it is a page of its
// own under Plan, with no tab bar.

// Where the person is: Malaysia, eight hours ahead of UTC. The clock reads 00:30 on Tuesday
// 10 November there, still the 9th in UTC.
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const CASH = 'c'.repeat(16);
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, HEALTH] = [id('Food'), id('Transport'), id('Health')];
const DINING = 'd1'.padEnd(16, '0');
const COFFEE = 'c1'.padEnd(16, '0');

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
function entry(server: FakeServer, date: string, amountCents: number, categoryId: string) {
  seeded++;
  const t: Transaction = {
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
  };
  server.transactions.push(t);
}

/**
 * Food this November: Dining out RM 60.00 in 2 entries, Coffee RM 15.00 in 1, RM 9.00 on
 * Food itself; RM 250.00 in October, RM 100.00 in September and RM 99.00 in November 2025,
 * nothing else. A budget of
 * RM 300.00 from October with Carry over (October left RM 50.00). Transport: RM 30.00 this
 * month against RM 20.00, and RM 40.00 in October. Health: RM 6.00, no budget.
 */
function aYearOfFood() {
  const server = fakeServer();
  server.accounts.push({
    id: CASH,
    name: 'Cash',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 200_000,
    position: 0,
    archived: false,
  });
  server.categories = [
    ...DEFAULT_CATEGORIES.map((c) => ({ ...c })),
    sub(DINING, 'Dining out', FOOD),
    sub(COFFEE, 'Coffee', FOOD),
  ];
  entry(server, '2026-11-02', 4_000, DINING);
  entry(server, '2026-11-07', 2_000, DINING);
  entry(server, '2026-11-08', 1_500, COFFEE);
  entry(server, '2026-11-09', 900, FOOD);
  entry(server, '2026-10-12', 25_000, FOOD);
  entry(server, '2026-09-15', 10_000, FOOD);
  // The month before November's first bar: in October's 12 months, not November's
  entry(server, '2025-11-20', 9_900, FOOD);
  entry(server, '2026-11-03', 3_000, TRANSPORT);
  entry(server, '2026-10-03', 4_000, TRANSPORT);
  entry(server, '2026-11-04', 600, HEALTH);
  server.budgets.push(
    { categoryId: FOOD, fromMonth: '2026-10', amountCents: 30_000, carryOver: true },
    { categoryId: TRANSPORT, fromMonth: '2026-11', amountCents: 2_000, carryOver: false },
  );
  return server;
}

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

/** Each of the 12 months as read out ("Nov 2026, RM 84.00"), and the one picked out */
function readYear(region: HTMLElement) {
  const months = within(region)
    .getAllByRole('listitem')
    .map((li) => /[A-Z][a-z]{2} \d{4}, RM [\d,.]+/.exec(li.textContent ?? '')?.[0] ?? '');
  const shown = within(region)
    .getAllByRole('listitem')
    .filter((li) => li.getAttribute('aria-current') === 'true')
    .map((li) => /[A-Z][a-z]{2} \d{4}, RM [\d,.]+/.exec(li.textContent ?? '')?.[0] ?? '');
  return { months, shown };
}

const NOVEMBER_YEAR = [
  'Dec 2025, RM 0.00',
  'Jan 2026, RM 0.00',
  'Feb 2026, RM 0.00',
  'Mar 2026, RM 0.00',
  'Apr 2026, RM 0.00',
  'May 2026, RM 0.00',
  'Jun 2026, RM 0.00',
  'Jul 2026, RM 0.00',
  'Aug 2026, RM 0.00',
  'Sep 2026, RM 100.00',
  'Oct 2026, RM 250.00',
  'Nov 2026, RM 84.00',
];

const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('a category over 12 months', () => {
  test.each(['phone', 'tablet'] as const)(
    'shows the month against the usual, its 12 months, what is inside, its budget and its entries (%s)',
    async (size) => {
      tenthJustAfterMidnight();
      renderApp(aYearOfFood(), `/?plan&category=${FOOD}`, { size });
      expect(await screen.findByRole('heading', { level: 1, name: 'Food' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
      expect(screen.getByRole('link', { name: 'Edit category' }).getAttribute('href')).toBe(
        '?settings=categories',
      );
      // A page of its own: no tab bar
      expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();

      expect(await screen.findByText('RM 84.00')).toBeTruthy();
      // RM 350.00 over the 11 months before is RM 31.82 a month
      expect(
        await screen.findByText('Spent in November · RM 52.18 over your usual RM 31.82'),
      ).toBeTruthy();
      const year = await screen.findByRole('region', {
        name: 'Food, last 12 months, November lowest since August',
      });
      expect(readYear(year)).toEqual({ months: NOVEMBER_YEAR, shown: ['Nov 2026, RM 84.00'] });
      expect(within(year).getByText('avg 31.82')).toBeTruthy();

      const inside = screen.getByRole('region', { name: 'Inside Food' });
      expect(items(inside)).toEqual([
        'Dining out 2 entries 60.00',
        'Coffee 1 entry 15.00',
        'Just Food 1 entry 9.00',
      ]);

      // RM 300.00 and the RM 50.00 carried from October, less RM 84.00
      expect(screen.getByText('RM 266.00 left of 350.00')).toBeTruthy();
      expect(screen.getByRole('meter', { name: 'Food: 24% spent' })).toBeTruthy();

      expect(screen.getByRole('link', { name: 'See all 4 in Activity' }).getAttribute('href')).toBe(
        `?activity&category=${FOOD}`,
      );
    },
  );

  test('says how far over a budget is, and leaves out what it has none of', async () => {
    tenthJustAfterMidnight();
    renderApp(aYearOfFood(), `/?plan&category=${TRANSPORT}`, { size: 'phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Transport' })).toBeTruthy();
    expect(await screen.findByText('RM 10.00 over 20.00')).toBeTruthy();
    expect(screen.getByRole('meter', { name: 'Transport: 150% spent' })).toBeTruthy();
    // RM 40.00 in October over 11 months is RM 3.64; RM 30.00 is RM 26.36 more
    expect(
      await screen.findByText('Spent in November · RM 26.36 over your usual RM 3.64'),
    ).toBeTruthy();
    // No subcategories: nothing inside to list
    expect(screen.queryByRole('region', { name: 'Inside Transport' })).toBeNull();
    expect(screen.getByRole('link', { name: 'See it in Activity' })).toBeTruthy();
  });

  test('with no budget, says nothing of one', async () => {
    tenthJustAfterMidnight();
    renderApp(aYearOfFood(), `/?plan&category=${HEALTH}`, { size: 'phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeTruthy();
    expect(await screen.findByText('RM 6.00')).toBeTruthy();
    await pause(50);
    expect(screen.queryByText('Budget')).toBeNull();
    expect(screen.queryByRole('meter')).toBeNull();
  });

  test('goes back up to Plan, at the month it was opened from', async () => {
    tenthJustAfterMidnight();
    renderApp(aYearOfFood(), '/?plan&month=2026-10', { size: 'phone' });
    const user = userEvent.setup();
    const went = await screen.findByRole('region', { name: /^Where it went/ });
    await user.click(await within(went).findByRole('link', { name: /^Food/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Food' })).toBeTruthy();
    expect(window.location.search).toBe(`?plan&month=2026-10&category=${FOOD}`);
    // October against the 11 months before it: RM 99.00 a year before and RM 100.00 in
    // September, RM 18.09 a month
    expect(
      await screen.findByText('Spent in October · RM 231.91 over your usual RM 18.09'),
    ).toBeTruthy();
    const year = await screen.findByRole('region', { name: /^Food, last 12 months/ });
    expect(readYear(year).shown).toEqual(['Oct 2026, RM 250.00']);
    // October's budget: RM 300.00, RM 250.00 spent
    expect(screen.getByText('RM 50.00 left of 300.00')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'See it in Activity' }).getAttribute('href')).toBe(
      `?activity&category=${FOOD}&from=2026-10-01&to=2026-10-31`,
    );

    await user.click(screen.getByRole('button', { name: 'Plan' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Plan' })).toBeTruthy();
    expect(window.location.search).toBe('?plan&month=2026-10');
  });

  test('a month with nothing in it, against the months before it', async () => {
    tenthJustAfterMidnight();
    renderApp(aYearOfFood(), `/?plan&month=2026-08&category=${FOOD}`, { size: 'phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Food' })).toBeTruthy();
    expect(await screen.findByText('RM 0.00')).toBeTruthy();
    // Sep 2025 to Jul 2026: only the RM 99.00 of November 2025, RM 9.00 a month
    expect(
      await screen.findByText('Spent in August · RM 9.00 under your usual RM 9.00'),
    ).toBeTruthy();
    // Level with July, so no comparison in its name
    const year = await screen.findByRole('region', { name: 'Food, last 12 months' });
    expect(readYear(year).shown).toEqual(['Aug 2026, RM 0.00']);
    expect(screen.queryByRole('region', { name: 'Inside Food' })).toBeNull();
    expect(screen.queryByRole('link', { name: /in Activity$/ })).toBeNull();
    // Food's budget starts in October
    expect(screen.queryByRole('meter')).toBeNull();
  });

  test('a category with no history at all is the same as its usual', async () => {
    tenthJustAfterMidnight();
    renderApp(aYearOfFood(), `/?plan&month=2026-10&category=${HEALTH}`, { size: 'phone' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Health' })).toBeTruthy();
    expect(
      await screen.findByText('Spent in October · the same as your usual RM 0.00'),
    ).toBeTruthy();
    const year = await screen.findByRole('region', { name: 'Health, last 12 months' });
    expect(readYear(year).months.every((m) => m.endsWith(', RM 0.00'))).toBe(true);
    expect(readYear(year).months).toHaveLength(12);
  });

  test('on a computer, spending added offline counts at once in its month and the one before, through a reload, and once saved', async () => {
    tenthJustAfterMidnight();
    const server = aYearOfFood();
    renderApp(server, `/?plan&category=${FOOD}`, { size: 'desktop' });
    const user = userEvent.setup();
    let food = await screen.findByRole('complementary', { name: 'Food' });
    await within(food).findByText('RM 52.18 over your usual RM 31.82');

    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));
    const spend = async (amount: string, date: string | null) => {
      await addEntry(amount, async (form) => {
        await user.click(form.getByRole('radio', { name: 'Food' }));
        if (date == null) return;
        await user.click(form.getByRole('button', { name: 'Today' }));
        await user.clear(form.getByLabelText('Date'));
        await user.type(form.getByLabelText('Date'), date);
      });
    };
    await spend('8', null);
    await spend('7', '2026-10-20');

    // November RM 92.00; October RM 257.00, so the usual is RM 357.00 over 11, RM 32.45
    const counted = [...NOVEMBER_YEAR.slice(0, 10), 'Oct 2026, RM 257.00', 'Nov 2026, RM 92.00'];
    const showsBoth = async () => {
      food = await screen.findByRole('complementary', { name: 'Food' });
      await waitFor(() =>
        expect(
          readYear(within(food).getByRole('region', { name: /^Food, last 12 months/ })).months,
        ).toEqual(counted),
      );
      expect(within(food).getByText('RM 92.00')).toBeTruthy();
      expect(within(food).getByText('RM 59.55 over your usual RM 32.45')).toBeTruthy();
      expect(within(food).getByRole('link', { name: 'See 5 entries' })).toBeTruthy();
    };
    await showsBoth();

    // Opened again offline: the month and its 12 months kept on the device, still to send
    await reloadApp(server, `/?plan&category=${FOOD}`, { size: 'desktop' });
    await showsBoth();
    expect(server.transactions).toHaveLength(10);

    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(server.transactions).toHaveLength(12), { timeout: 8000 });
    await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
    // Counted once, now that the server sums them too
    await pause(50);
    await showsBoth();
  }, 20_000);

  test('says so when the category is not one of the person’s', async () => {
    tenthJustAfterMidnight();
    renderApp(aYearOfFood(), `/?plan&category=${'9'.repeat(16)}`, { size: 'phone' });
    expect(await screen.findByText('Category not found')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plan' })).toBeTruthy();
  });

  test('shows the month when the 12 months cannot be read, making nothing up, and tries again', async () => {
    tenthJustAfterMidnight();
    const server = aYearOfFood();
    server.pathsDown.add('/api/summary/trend');
    renderApp(server, `/?plan&category=${FOOD}`, { size: 'phone' });
    expect(await screen.findByText('RM 84.00')).toBeTruthy();
    expect(await screen.findByText("Couldn't load the last 12 months.")).toBeTruthy();
    const year = screen.getByRole('region', { name: /^Food, last 12 months/ });
    expect(within(year).queryAllByRole('listitem')).toEqual([]);
    expect(screen.queryByText(/usual/)).toBeNull();
    expect(screen.queryByText(/^avg/)).toBeNull();
    // The rest of the page is as it was
    expect(screen.getByText('RM 266.00 left of 350.00')).toBeTruthy();

    server.pathsDown.delete('/api/summary/trend');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByText('Spent in November · RM 52.18 over your usual RM 31.82'),
    ).toBeTruthy();
  });

  test('on a computer, ends the 12 months at the month shown, whichever answer comes last', async () => {
    tenthJustAfterMidnight();
    const server = aYearOfFood();
    // November's 12 months answer only after October's
    const november = holdNext(server, 'GET', '/api/summary/trend');
    renderApp(server, `/?plan&category=${FOOD}`, { size: 'desktop' });
    const user = userEvent.setup();
    expect(await screen.findByRole('complementary', { name: 'Food' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    // The category stays open on the earlier month
    await waitFor(() =>
      expect(window.location.search).toBe(`?plan&month=2026-10&category=${FOOD}`),
    );
    let food = await screen.findByRole('complementary', { name: 'Food' });
    await waitFor(() =>
      expect(
        readYear(within(food).getByRole('region', { name: /^Food, last 12 months/ })).shown,
      ).toEqual(['Oct 2026, RM 250.00']),
    );
    november.release();
    // November's answer arriving late changes nothing shown for October
    await waitFor(() => expect(server.held).toHaveLength(0));
    await pause(50);
    food = await screen.findByRole('complementary', { name: 'Food' });
    const october = readYear(within(food).getByRole('region', { name: /^Food, last 12 months/ }));
    expect(october.months[0]).toBe('Nov 2025, RM 99.00');
    expect(october.shown).toEqual(['Oct 2026, RM 250.00']);
    expect(within(food).getByText('RM 231.91 over your usual RM 18.09')).toBeTruthy();
    // An earlier month's budget is read, not changed
    expect(within(food).queryByLabelText('Monthly budget')).toBeNull();
    expect(within(food).getByText('RM 50.00 left of 300.00')).toBeTruthy();

    // And November's own, once back there
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    food = await screen.findByRole('complementary', { name: 'Food' });
    await waitFor(() =>
      expect(readYear(within(food).getByRole('region', { name: /^Food, last 12 months/ }))).toEqual(
        { months: NOVEMBER_YEAR, shown: ['Nov 2026, RM 84.00'] },
      ),
    );
  });
});
