// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
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

// A phone's Home at a glance (Home shows: Essentials; owner audit 2026-11-20, "Phone Home
// at a glance"): what was spent so far this month, today against the median daily spend,
// the week's biggest expense and the last 7 days, newest first. Only spending counts:
// income, transfers and bills still to come never do. Every name and figure is made up.

vi.hoisted(() => {
  process.env.TZ = 'Asia/Kuala_Lumpur';
});

setupAppTests();

const [CASH, BANK] = ['c', 'b'].map((c) => c.repeat(16));
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, SALARY] = [id('Food'), id('Transport'), id('Salary')];

/** The clock reads mid-morning on `day` where the person is, and still ticks */
function on(day: string) {
  const [y, m, d] = day.split('-').map(Number);
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(y, m - 1, d, 10, 0, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** Cash and Maybank, Home showing Essentials, the month starting on `start` */
function aServer(start = 1) {
  const server = fakeServer();
  server.me.settings.homeDensity = 'essentials';
  server.me.settings.monthStartDay = start;
  server.accounts.push(
    {
      id: CASH,
      name: 'Cash',
      kind: 'cash',
      currency: 'MYR',
      openingCents: 500_000,
      position: 0,
      archived: false,
    },
    {
      id: BANK,
      name: 'Maybank',
      kind: 'bank',
      currency: 'MYR',
      openingCents: 1_000_000,
      position: 1,
      archived: false,
    },
  );
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  return server;
}

/** An entry, the later added the newer */
function seed(server: FakeServer, date: string, amountCents: number, more: Partial<Transaction>) {
  const n = server.transactions.length + 1;
  server.transactions.push({
    id: n.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: CASH,
    toAccountId: null,
    amountCents,
    categoryId: FOOD,
    payee: null,
    note: null,
    date,
    createdAt: n,
    ...more,
  });
}

/**
 * Friday 20 November. Spent on 11 of the 20 days, RM 668.50 in all: RM 39.00 on two days
 * and nothing on nine, so the median daily spend is RM 39.00; RM 57.00 today. Kedai Besar's
 * RM 185.00 on Wednesday is the week's biggest; Monday's RM 500.00 transfer and
 * Thursday's RM 3,250.00 pay are bigger but not spending, and October's RM 900.00 is
 * another month's.
 */
function aMonthUnderWay() {
  const server = aServer();
  seed(server, '2026-10-30', 90_000, { payee: 'Last month' });
  const spent: [string, number, string | null][] = [
    ['2026-11-01', 4_000, null],
    ['2026-11-03', 4_500, null],
    ['2026-11-05', 5_000, null],
    ['2026-11-07', 3_900, null],
    ['2026-11-09', 6_000, null],
    ['2026-11-11', 3_900, null],
    ['2026-11-13', 7_000, null],
    ['2026-11-15', 4_100, 'Sunday market'],
  ];
  for (const [date, cents, payee] of spent) seed(server, date, cents, { payee });
  seed(server, '2026-11-16', 50_000, {
    kind: 'transfer',
    accountId: BANK,
    toAccountId: CASH,
    categoryId: null,
    note: 'top-up',
  });
  seed(server, '2026-11-17', 4_250, { categoryId: TRANSPORT, payee: 'Grab' });
  seed(server, '2026-11-18', 18_500, { payee: 'Kedai Besar' });
  seed(server, '2026-11-19', 325_000, {
    kind: 'income',
    accountId: BANK,
    categoryId: SALARY,
    payee: 'Acme',
  });
  seed(server, '2026-11-20', 2_200, { categoryId: TRANSPORT });
  seed(server, '2026-11-20', 3_500, { payee: 'Kedai Ali' });
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

const spentSoFar = () => screen.findByRole('link', { name: /^Spent (so far|in)/ });
const todayRow = (name: RegExp = /^Today/) => screen.findByRole('button', { name });
const biggest = () => screen.findByRole('group', { name: /^Biggest spend/ });
const recent = () => screen.findByRole('region', { name: 'Recent activity' });

/** Each day's heading and its rows, as Recent activity lists them */
function recentDays(region: HTMLElement) {
  return within(region)
    .getAllByRole('list')
    .map((list) => ({
      day: list.getAttribute('aria-label'),
      rows: within(list).getAllByRole('listitem').map(text),
    }));
}

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

describe('a phone’s Home at a glance', () => {
  test('the month so far, today against the median, the week’s biggest and the last 7 days', async () => {
    on('2026-11-20');
    renderApp(aMonthUnderWay(), '/', { size: 'phone' });

    const spent = await spentSoFar();
    await waitFor(() => expect(text(spent)).toBe('Spent so far RM 668.50'));
    // Those expenses in Activity: this month's days to today
    expect(spent.getAttribute('href')).toBe('?activity&kind=expense&from=2026-11-01&to=2026-11-20');
    // The month end stays a quiet line away: Cash RM 3,931.50 and Maybank RM 12,750.00,
    // nothing scheduled
    const monthEnd = await screen.findByRole('link', { name: /^Expected at month end/ });
    expect(text(monthEnd)).toBe('Expected at month end RM 16,681.50');
    expect(monthEnd.getAttribute('href')).toBe('?plan=scheduled');

    const today = await todayRow();
    expect(text(today)).toBe('Today RM 57.00 · RM 18.00 above median');
    expect(today.getAttribute('aria-expanded')).toBe('false');
    const user = userEvent.setup();
    await user.click(today);
    expect(today.getAttribute('aria-expanded')).toBe('true');
    expect(
      screen.getByText(
        'Median daily spend RM 39.00 · Nov 1 to Nov 20, days with nothing spent counted',
      ),
    ).toBeTruthy();

    const big = await biggest();
    await waitFor(() =>
      expect(text(big)).toBe('Biggest spend this week RM 185.00 Kedai Besar · Wed, Nov 18'),
    );

    const region = await recent();
    expect(within(region).getByText('Last 7 days')).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe(
      '?activity&kind=all&from=2026-11-14&to=2026-11-20',
    );
    expect(recentDays(region)).toEqual([
      { day: 'Today', rows: ['Kedai Ali Food −RM 35.00', 'Transport Cash −RM 22.00'] },
      { day: 'Yesterday', rows: ['Acme Salary +RM 3,250.00'] },
      { day: 'Wed, Nov 18', rows: ['Kedai Besar Food −RM 185.00'] },
      { day: 'Tue, Nov 17', rows: ['Grab Transport −RM 42.50'] },
      { day: 'Mon, Nov 16', rows: ['top-up Transfer · Maybank to Cash RM 500.00'] },
      { day: 'Sun, Nov 15', rows: ['Sunday market Food −RM 41.00'] },
    ]);

    // The detailed Home's parts stay there
    expect(screen.queryByRole('region', { name: 'Expected at month end' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Day by day' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Budgets' })).toBeNull();

    // The biggest spend opens that very entry
    await user.click(within(big).getByRole('button'));
    const dialog = await screen.findByRole('dialog', { name: 'Edit transaction' });
    expect(within(dialog).getByDisplayValue('Kedai Besar')).toBeTruthy();
  });

  test('a month starting on the 25th counts from October 25, and a zero median', async () => {
    on('2026-11-20');
    const server = aServer(25);
    // Before the month, then two days of it: the median of 27 days is RM 0.00
    seed(server, '2026-10-20', 10_000, { payee: 'Before' });
    seed(server, '2026-10-26', 1_000, { payee: 'Warung' });
    seed(server, '2026-11-20', 500, { payee: 'Kopi' });
    renderApp(server, '/', { size: 'phone' });
    const spent = await spentSoFar();
    await waitFor(() => expect(text(spent)).toBe('Spent so far RM 15.00'));
    expect(spent.getAttribute('href')).toBe('?activity&kind=expense&from=2026-10-25&to=2026-11-20');
    expect(text(await todayRow())).toBe('Today RM 5.00 · RM 5.00 above median');
    await userEvent.setup().click(await todayRow());
    expect(
      screen.getByText(
        'Median daily spend RM 0.00 · Oct 25 to Nov 20, days with nothing spent counted',
      ),
    ).toBeTruthy();
  });

  test('a week that started last month, and a day with nothing spent at the median', async () => {
    // Tuesday 1 December: the week began on Monday, November 30
    on('2026-12-01');
    const server = aServer();
    seed(server, '2026-11-29', 20_000, { payee: 'Last Sunday' });
    seed(server, '2026-11-30', 8_000, { payee: 'Pasar' });
    renderApp(server, '/', { size: 'phone' });
    await waitFor(async () => expect(text(await spentSoFar())).toBe('Spent so far RM 0.00'));
    expect(text(await todayRow())).toBe('Today RM 0.00 · at median');
    const big = await biggest();
    await waitFor(() =>
      expect(text(big)).toBe('Biggest spend this week RM 80.00 Pasar · Mon, Nov 30'),
    );
    // The last 7 days go back into November too
    const region = await recent();
    expect(recentDays(region).map((d) => d.day)).toEqual(['Yesterday', 'Sun, Nov 29']);
  });

  test('a week without spending says so, with its pay and transfers still listed', async () => {
    on('2026-11-20');
    const server = aServer();
    seed(server, '2026-11-02', 2_000, { payee: 'Earlier' });
    seed(server, '2026-11-17', 7_500, {
      kind: 'transfer',
      accountId: BANK,
      toAccountId: CASH,
      categoryId: null,
    });
    seed(server, '2026-11-18', 100_000, {
      kind: 'income',
      accountId: BANK,
      categoryId: SALARY,
      payee: 'Acme',
    });
    renderApp(server, '/', { size: 'phone' });
    const big = await biggest();
    await waitFor(() => expect(text(big)).toBe('Biggest spend this week Nothing spent this week'));
    expect(within(big).queryByRole('button')).toBeNull();
    const region = await recent();
    expect(recentDays(region)).toEqual([
      { day: 'Wed, Nov 18', rows: ['Acme Salary +RM 1,000.00'] },
      { day: 'Tue, Nov 17', rows: ['Transfer Maybank to Cash RM 75.00'] },
    ]);
  });

  test('an earlier month is seen from its last day, with its dates', async () => {
    on('2026-11-20');
    const server = aServer();
    seed(server, '2026-10-26', 3_000, { payee: 'Monday' });
    seed(server, '2026-10-31', 1_200, { payee: 'Halloween' });
    renderApp(server, '/?month=2026-10', { size: 'phone' });
    const spent = await spentSoFar();
    await waitFor(() => expect(text(spent)).toBe('Spent in October RM 42.00'));
    // A month gone has no month end to expect
    expect(screen.queryByRole('link', { name: /^Expected at month end/ })).toBeNull();
    expect(spent.getAttribute('href')).toBe('?activity&kind=expense&from=2026-10-01&to=2026-10-31');
    expect(text(await todayRow(/^Oct 31/))).toBe('Oct 31 RM 12.00 · RM 12.00 above median');
    const big = await biggest();
    await waitFor(() =>
      expect(text(big)).toBe('Biggest spend Oct 26 to Oct 31 RM 30.00 Monday · Mon, Oct 26'),
    );
    const region = await recent();
    expect(within(region).getByText('Oct 25 to Oct 31')).toBeTruthy();
    expect(within(region).getByRole('link', { name: 'See all' }).getAttribute('href')).toBe(
      '?activity&kind=all&from=2026-10-25&to=2026-10-31',
    );
  });

  test('an expense made offline moves every figure together, and stays once sent', async () => {
    on('2026-11-20');
    const server = aMonthUnderWay();
    renderApp(server, '/', { size: 'phone' });
    await waitFor(async () => expect(text(await spentSoFar())).toBe('Spent so far RM 668.50'));
    await waitFor(async () => expect(text(await biggest())).toContain('RM 185.00'));

    const back = goOffline(server);
    await addEntry('300');
    const after = async () => {
      expect(text(await spentSoFar())).toBe('Spent so far RM 968.50');
      expect(text(await todayRow())).toBe('Today RM 357.00 · RM 318.00 above median');
      expect(text(await biggest())).toMatch(
        /^Biggest spend this week RM 300\.00 .* · Fri, Nov 20$/,
      );
      expect(recentDays(await recent())[0].rows[0]).toMatch(/−RM 300\.00$/);
    };
    await waitFor(after);

    back();
    await waitFor(() => expect(server.transactions).toHaveLength(15));
    await waitFor(after);
  });

  test('offline without the week on this device, it never claims a zero or a biggest', async () => {
    on('2026-11-20');
    const server = aMonthUnderWay();
    renderApp(server, '/', { size: 'phone' });
    await waitFor(async () => expect(text(await spentSoFar())).toBe('Spent so far RM 668.50'));
    // Opened again offline, before any history was downloaded
    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    await reloadApp(server, '/', { size: 'phone' });
    const big = await biggest();
    await waitFor(() =>
      expect(text(big)).toBe("Biggest spend this week These days aren't on this device yet"),
    );
    const region = await recent();
    await waitFor(() =>
      expect(within(region).getByText("Entries for these days aren't on this device yet.")),
    );
    expect(screen.queryByText('Nothing spent this week')).toBeNull();
  });

  test('offline in a month whose totals were never kept, the week and the days still show', async () => {
    on('2026-11-20');
    const server = aServer();
    seed(server, '2026-09-28', 2_000, { payee: 'Kedai' });
    seed(server, '2026-09-30', 500, { payee: 'Kopi' });
    // Opened online, and the history downloaded to the device
    await reloadApp(server, '/', { size: 'phone' });
    await screen.findByRole('navigation', { name: 'Main' });
    const { syncHistory } = await import('../../ledger/ledger');
    await act(() => syncHistory());
    // Then opened offline on September, whose totals were never asked for
    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    await reloadApp(server, '/?month=2026-09', { size: 'phone' });
    expect(
      await screen.findByText("Couldn't load this month.", {}, { timeout: 6000 }),
    ).toBeTruthy();
    const big = await biggest();
    await waitFor(
      () => expect(text(big)).toBe('Biggest spend Sep 28 to Sep 30 RM 20.00 Kedai · Mon, Sep 28'),
      { timeout: 6000 },
    );
    expect(recentDays(await recent())).toEqual([
      { day: 'Wed, Sep 30', rows: ['Kopi Food −RM 5.00'] },
      { day: 'Mon, Sep 28', rows: ['Kedai Food −RM 20.00'] },
    ]);
    // The month's own figures aren't made up
    expect(screen.queryByRole('link', { name: /^Spent in/ })).toBeNull();
  }, 30_000);

  test('a transfer is never named before the accounts are known', async () => {
    on('2026-11-20');
    const server = aMonthUnderWay();
    const accounts = holdNext(server, 'GET', '/api/accounts');
    renderApp(server, '/', { size: 'phone' });
    await new Promise((r) => setTimeout(r, 500));
    expect(screen.queryByText(/another account/)).toBeNull();
    accounts.release();
    const region = await recent();
    await waitFor(() =>
      expect(recentDays(region).find((d) => d.day === 'Mon, Nov 16')?.rows).toEqual([
        'top-up Transfer · Maybank to Cash RM 500.00',
      ]),
    );
    expect(screen.queryByText(/another account/)).toBeNull();
  });
});
