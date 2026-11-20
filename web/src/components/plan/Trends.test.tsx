// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, describe, expect, onTestFinished, test, vi } from 'vitest';
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

// All spending and all income over 12 months, and income by category. Home's "Expenses so
// far" and "Income" open the last 12 months of every expense or all income, ending at the
// month Home shows (?plan&category=expenses, ?plan&category=income): a page of its own on
// phones and tablets, with Back to Home; on a computer, the pane beside Plan's table. Plan's
// Income lists what came in by category, largest first, each opening its own 12 months as a
// spending category does. These carry the cases of the old month card's Spent and Received
// (Trends.test and MonthCard.test on Home).

// Where the person is: Malaysia, eight hours ahead of UTC
const TZ_BEFORE = process.env.TZ;
process.env.TZ = 'Asia/Kuala_Lumpur';
afterAll(() => {
  if (TZ_BEFORE == null) delete process.env.TZ;
  else process.env.TZ = TZ_BEFORE;
});

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const COFFEE = 'e'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const SALARY = categoryId('Salary');
const OTHER_INCOME = categoryId('Other income');

/** The app's clock reads Friday 6 November 2026, mid-morning, and still ticks */
function onTheSixth() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 6, 10, 0, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** December 2025 to November 2026, as each bar is read out */
const TO_NOVEMBER = [
  'Dec 2025',
  'Jan 2026',
  'Feb 2026',
  'Mar 2026',
  'Apr 2026',
  'May 2026',
  'Jun 2026',
  'Jul 2026',
  'Aug 2026',
  'Sep 2026',
  'Oct 2026',
  'Nov 2026',
];

/** The 12 months before and including `last`, as each bar is read out */
const twelveTo = (last: 'Sep' | 'Oct') =>
  last === 'Oct'
    ? ['Nov 2025', ...TO_NOVEMBER.slice(0, 11)]
    : ['Oct 2025', 'Nov 2025', ...TO_NOVEMBER.slice(0, 10)];

/** A Wallet and a Bank with nothing in them, and Coffee under Food */
function withAccounts() {
  const server = fakeServer();
  for (const [id, name, position] of [
    [WALLET, 'Wallet', 0],
    [BANK, 'Bank', 1],
  ] as const) {
    server.accounts.push({
      id,
      name,
      kind: id === WALLET ? 'cash' : 'bank',
      currency: 'MYR',
      openingCents: 0,
      position,
      archived: false,
    });
  }
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.categories.push({
    id: COFFEE,
    name: 'Coffee',
    kind: 'expense',
    parentId: categoryId('Food'),
    position: 0,
    archived: false,
  });
  return server;
}

let seeded = 0;
/** A transaction the server has before the app opens: RM 8 on Food from the Wallet */
function seed(server: FakeServer, t: Partial<Transaction>) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, 'd'),
    kind: 'expense',
    accountId: WALLET,
    toAccountId: null,
    amountCents: 800,
    categoryId: categoryId('Food'),
    payee: null,
    note: null,
    date: '2026-11-01',
    createdAt: seeded,
    ...t,
  });
}

/**
 * A year of spending and income up to 6 November 2026:
 * - Food: RM 8 on Food itself and RM 3 on Coffee in November (RM 11), RM 20 in October,
 *   RM 10 on Coffee in August, RM 15.40 in January; RM 99 in November 2025, a month too
 *   early for November's 12
 * - Transport: RM 5 in November
 * - Salary: RM 50 in November, RM 40 in September
 * - RM 400 moved from the Wallet to the Bank in October, which is never spending
 */
function withAYear() {
  const server = withAccounts();
  seed(server, { amountCents: 800, date: '2026-11-01' });
  seed(server, { amountCents: 300, categoryId: COFFEE, date: '2026-11-02' });
  seed(server, { amountCents: 500, categoryId: categoryId('Transport'), date: '2026-11-03' });
  seed(server, { amountCents: 2_000, date: '2026-10-15' });
  seed(server, { amountCents: 1_000, categoryId: COFFEE, date: '2026-08-03' });
  seed(server, { amountCents: 1_540, date: '2026-01-20' });
  seed(server, { amountCents: 9_900, date: '2025-11-30' });
  seed(server, { kind: 'income', amountCents: 5_000, categoryId: SALARY, date: '2026-11-05' });
  seed(server, { kind: 'income', amountCents: 4_000, categoryId: SALARY, date: '2026-09-25' });
  seed(server, {
    kind: 'transfer',
    toAccountId: BANK,
    amountCents: 40_000,
    categoryId: null,
    date: '2026-10-10',
  });
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

/** Each of the 12 months as read out ("Nov 2026, RM 16.00"), and the one picked out */
function readYear(region: HTMLElement) {
  const read = (li: HTMLElement) =>
    /[A-Z][a-z]{2} \d{4}, RM [\d,.]+/.exec(li.textContent ?? '')?.[0] ?? '';
  const all = within(region).getAllByRole('listitem');
  return {
    months: all.map(read),
    shown: all.filter((li) => li.getAttribute('aria-current') === 'true').map(read),
  };
}

/** The 12 bars read out, from `months` and their amounts (RM 0.00 where none is given) */
const expected = (months: string[], amounts: Record<string, string>) =>
  months.map((m) => `${m}, ${amounts[m] ?? 'RM 0.00'}`);

/**
 * What a 12 months opened shows in: the page itself on a phone (its heading the name), the
 * pane named `name` on a computer
 */
async function opened(size: (typeof SIZES)[number], name: string) {
  if (size === 'phone') {
    expect(await screen.findByRole('heading', { level: 1, name })).toBeTruthy();
    return within(document.body);
  }
  return within(await screen.findByRole('complementary', { name }));
}

/** How the month compares with the usual: "Spent in November · " before it on a phone */
const usualLine = (size: (typeof SIZES)[number], prefix: string, line: string) => {
  const whole = size === 'phone' ? `${prefix} · ${line}` : line;
  return (_: string, el: Element | null) => el?.tagName === 'P' && el.textContent === whole;
};

/** The bars' average line is named on a page; a pane names the usual under its figure */
const averageLabel = (size: (typeof SIZES)[number], year: HTMLElement, label: string) =>
  size === 'phone'
    ? expect(within(year).getByText(label)).toBeTruthy()
    : expect(within(year).queryByText(/^avg/)).toBeNull();

/** Home's card, once its figure is in: "Expenses so far" or "Income" */
async function homeCard(name: 'Expenses so far' | 'Income', figure: string) {
  const card = await screen.findByRole('link', { name: new RegExp(`^${name}`) });
  await waitFor(() => expect(text(card)).toContain(figure));
  return card;
}

const pause = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

describe('all spending and all income over 12 months', () => {
  test.each(SIZES)(
    "Home's Expenses so far opens every expense over 12 months, never counting money moved between accounts (%s)",
    async (size) => {
      onTheSixth();
      renderApp(withAYear(), '/', { size });
      const user = userEvent.setup();
      await user.click(await homeCard('Expenses so far', 'RM 16.00'));
      await waitFor(() => expect(window.location.search).toBe('?plan&category=expenses'));

      const view = await opened(size, 'All expenses');
      if (size === 'phone') {
        // A page of its own, with Back to Home and no tab bar
        expect(view.getByRole('button', { name: 'Home' })).toBeTruthy();
        expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
      }
      expect(await view.findByText('RM 16.00')).toBeTruthy();
      // RM 45.40 over the 11 months before is RM 4.1272..., RM 4.13 to the cent
      expect(
        await view.findByText(
          usualLine(size, 'Spent in November', 'RM 11.87 over your usual RM 4.13'),
        ),
      ).toBeTruthy();
      // October is Food's RM 20 alone: the RM 400 moved to the Bank isn't spending
      const year = view.getByRole('region', {
        name: 'All expenses, last 12 months, November lowest since September',
      });
      expect(readYear(year)).toEqual({
        months: expected(TO_NOVEMBER, {
          'Jan 2026': 'RM 15.40',
          'Aug 2026': 'RM 10.00',
          'Oct 2026': 'RM 20.00',
          'Nov 2026': 'RM 16.00',
        }),
        shown: ['Nov 2026, RM 16.00'],
      });
      averageLabel(size, year, 'avg 4.13');
    },
  );

  test.each(SIZES)("Home's Income opens all income over 12 months (%s)", async (size) => {
    onTheSixth();
    renderApp(withAYear(), '/', { size });
    const user = userEvent.setup();
    await user.click(await homeCard('Income', 'RM 50.00'));
    await waitFor(() => expect(window.location.search).toBe('?plan&category=income'));

    const view = await opened(size, 'All income');
    expect(await view.findByText('RM 50.00')).toBeTruthy();
    // RM 40 over 11 months is RM 3.6363..., RM 3.64 to the cent
    expect(
      await view.findByText(
        usualLine(size, 'Received in November', 'RM 46.36 over your usual RM 3.64'),
      ),
    ).toBeTruthy();
    const year = view.getByRole('region', {
      name: 'All income, last 12 months, November highest in 12 months',
    });
    expect(readYear(year)).toEqual({
      months: expected(TO_NOVEMBER, { 'Sep 2026': 'RM 40.00', 'Nov 2026': 'RM 50.00' }),
      shown: ['Nov 2026, RM 50.00'],
    });
    averageLabel(size, year, 'avg 3.64');
  });

  test('on a phone, Back returns to Home at the month it was opened from', async () => {
    onTheSixth();
    renderApp(withAYear(), '/?month=2026-09', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await homeCard('Expenses so far', 'RM 0.00'));
    await waitFor(() =>
      expect(window.location.search).toBe('?plan&month=2026-09&category=expenses'),
    );
    const view = await opened('phone', 'All expenses');
    await user.click(view.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(window.location.search).toBe('?month=2026-09'));
    expect(await screen.findByRole('link', { name: /^Expenses so far/ })).toBeTruthy();
  });

  test.each(SIZES)(
    'an earlier month on Home opens 12 months ending there, compared with the 11 before (%s)',
    async (size) => {
      onTheSixth();
      renderApp(withAYear(), '/?month=2026-09', { size });
      const user = userEvent.setup();
      await user.click(await homeCard('Expenses so far', 'RM 0.00'));
      await waitFor(() =>
        expect(window.location.search).toBe('?plan&month=2026-09&category=expenses'),
      );

      const view = await opened(size, 'All expenses');
      // Nothing spent in September; RM 124.40 over the 11 months before is RM 11.3090...
      expect(
        await view.findByText(
          usualLine(size, 'Spent in September', 'RM 11.31 under your usual RM 11.31'),
        ),
      ).toBeTruthy();
      const year = view.getByRole('region', { name: /^All expenses, last 12 months/ });
      expect(readYear(year)).toEqual({
        months: expected(twelveTo('Sep'), {
          'Nov 2025': 'RM 99.00',
          'Jan 2026': 'RM 15.40',
          'Aug 2026': 'RM 10.00',
        }),
        shown: ['Sep 2026, RM 0.00'],
      });

      if (size === 'desktop') {
        // The arrows keep it open, a month at a time
        await user.click(screen.getByRole('button', { name: 'Next month' }));
        await waitFor(() =>
          expect(window.location.search).toBe('?plan&month=2026-10&category=expenses'),
        );
        const pane = within(await screen.findByRole('complementary', { name: 'All expenses' }));
        await waitFor(() =>
          expect(
            readYear(pane.getByRole('region', { name: /^All expenses, last 12 months/ })).shown,
          ).toEqual(['Oct 2026, RM 20.00']),
        );
      }
    },
  );

  test.each(SIZES)(
    'an earlier month with no income, against the income of the months before (%s)',
    async (size) => {
      onTheSixth();
      renderApp(withAYear(), '/?month=2026-10', { size });
      const user = userEvent.setup();
      await user.click(await homeCard('Income', 'RM 0.00'));
      await waitFor(() =>
        expect(window.location.search).toBe('?plan&month=2026-10&category=income'),
      );

      const view = await opened(size, 'All income');
      expect(
        await view.findByText(
          usualLine(size, 'Received in October', 'RM 3.64 under your usual RM 3.64'),
        ),
      ).toBeTruthy();
      const year = view.getByRole('region', { name: /^All income, last 12 months/ });
      expect(readYear(year)).toEqual({
        months: expected(twelveTo('Oct'), { 'Sep 2026': 'RM 40.00' }),
        shown: ['Oct 2026, RM 0.00'],
      });
      if (size === 'desktop') {
        // Nothing came in in October: Plan's Income lists no category
        const income = await screen.findByRole('region', { name: 'Income' });
        expect(within(income).queryByRole('list', { name: 'Income by category' })).toBeNull();
      }
    },
  );

  test.each(SIZES)('opens both in a year with nothing in it (%s)', async (size) => {
    onTheSixth();
    renderApp(withAccounts(), '/', { size });
    const user = userEvent.setup();
    for (const [card, name, prefix] of [
      ['Expenses so far', 'All expenses', 'Spent in November'],
      ['Income', 'All income', 'Received in November'],
    ] as const) {
      await user.click(await homeCard(card, 'RM 0.00'));
      const view = await opened(size, name);
      expect(
        await view.findByText(usualLine(size, prefix, 'the same as your usual RM 0.00')),
      ).toBeTruthy();
      // Level with October: nothing to compare in its name
      const year = view.getByRole('region', { name: `${name}, last 12 months` });
      expect(readYear(year)).toEqual({
        months: expected(TO_NOVEMBER, {}),
        shown: ['Nov 2026, RM 0.00'],
      });
      if (size === 'phone') await user.click(view.getByRole('button', { name: 'Home' }));
      else act(() => window.history.back());
      await waitFor(() => expect(window.location.search).toBe(''));
    }
  });

  test('on a computer, spending added offline counts in the months it is on, through a reload, and once saved', async () => {
    onTheSixth();
    const server = withAYear();
    renderApp(server, '/?plan&category=expenses', { size: 'desktop' });
    const user = userEvent.setup();
    let pane = within(await screen.findByRole('complementary', { name: 'All expenses' }));
    await pane.findByText('RM 11.87 over your usual RM 4.13');

    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));
    const spend = async (amount: string, date: string) => {
      await addEntry(amount, async (form) => {
        await user.click(form.getByRole('radio', { name: 'Transport' }));
        await user.click(form.getByRole('button', { name: 'Today' }));
        await user.clear(form.getByLabelText('Date'));
        await user.type(form.getByLabelText('Date'), date);
      });
    };
    await spend('8', '2026-11-04');
    await spend('7', '2026-10-20');

    const counted = expected(TO_NOVEMBER, {
      'Jan 2026': 'RM 15.40',
      'Aug 2026': 'RM 10.00',
      'Oct 2026': 'RM 27.00',
      'Nov 2026': 'RM 24.00',
    });
    // RM 52.40 over the 11 months before is RM 4.7636..., RM 4.76
    const showsBoth = async () => {
      pane = within(await screen.findByRole('complementary', { name: 'All expenses' }));
      await waitFor(() =>
        expect(
          readYear(pane.getByRole('region', { name: /^All expenses, last 12 months/ })).months,
        ).toEqual(counted),
      );
      expect(pane.getByText('RM 24.00')).toBeTruthy();
      expect(pane.getByText('RM 19.24 over your usual RM 4.76')).toBeTruthy();
    };
    await showsBoth();

    // Opened again offline: the 12 months kept on the device, with the changes still to send
    await reloadApp(server, '/?plan&category=expenses', { size: 'desktop' });
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
  });

  test.each(['expenses', 'income'] as const)(
    'shows the month when the 12 months cannot be read, making nothing up, and tries again (%s)',
    async (which) => {
      onTheSixth();
      const server = withAYear();
      server.pathsDown.add('/api/summary/trend');
      renderApp(server, `/?plan&category=${which}`, { size: 'phone' });
      const name = which === 'expenses' ? 'All expenses' : 'All income';
      const view = await opened('phone', name);
      expect(await view.findByText(which === 'expenses' ? 'RM 16.00' : 'RM 50.00')).toBeTruthy();
      expect(await view.findByText("Couldn't load the last 12 months.")).toBeTruthy();
      const year = view.getByRole('region', { name: new RegExp(`^${name}, last 12 months`) });
      expect(within(year).queryAllByRole('listitem')).toEqual([]);
      expect(view.queryByText(/usual/)).toBeNull();
      expect(view.queryByText(/^avg/)).toBeNull();

      server.pathsDown.delete('/api/summary/trend');
      await userEvent.setup().click(view.getByRole('button', { name: 'Try again' }));
      expect(
        await view.findByText(
          which === 'expenses'
            ? usualLine('phone', 'Spent in November', 'RM 11.87 over your usual RM 4.13')
            : usualLine('phone', 'Received in November', 'RM 46.36 over your usual RM 3.64'),
        ),
      ).toBeTruthy();
    },
  );

  test('on a computer, ends the 12 months at the month shown, whichever answer comes last', async () => {
    onTheSixth();
    const server = withAYear();
    // November's 12 months answer only after October's
    const november = holdNext(server, 'GET', '/api/summary/trend');
    renderApp(server, '/?plan&category=expenses', { size: 'desktop' });
    const user = userEvent.setup();
    expect(await screen.findByRole('complementary', { name: 'All expenses' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Previous month' }));
    await waitFor(() =>
      expect(window.location.search).toBe('?plan&month=2026-10&category=expenses'),
    );
    const october = expected(twelveTo('Oct'), {
      'Nov 2025': 'RM 99.00',
      'Jan 2026': 'RM 15.40',
      'Aug 2026': 'RM 10.00',
      'Oct 2026': 'RM 20.00',
    });
    const year = async () =>
      readYear(
        within(await screen.findByRole('complementary', { name: 'All expenses' })).getByRole(
          'region',
          { name: /^All expenses, last 12 months/ },
        ),
      );
    await waitFor(async () => expect((await year()).months).toEqual(october));
    november.release();
    // November's answer arriving late changes nothing shown for October
    await waitFor(() => expect(server.held).toHaveLength(0));
    await pause(50);
    expect(await year()).toEqual({ months: october, shown: ['Oct 2026, RM 20.00'] });

    // And November's own, once back there
    await user.click(screen.getByRole('button', { name: 'Next month' }));
    await waitFor(async () => expect((await year()).shown).toEqual(['Nov 2026, RM 16.00']));
  });
});

describe('income by category', () => {
  /** A year, and RM 70.00 of other income on 4 November: more than Salary's RM 50.00 */
  function withOtherIncome() {
    const server = withAYear();
    seed(server, {
      kind: 'income',
      amountCents: 7_000,
      categoryId: OTHER_INCOME,
      date: '2026-11-04',
    });
    return server;
  }

  test.each(['phone', 'tablet'] as const)(
    'lists what came in by category, largest first, each opening a page of its own 12 months (%s)',
    async (size) => {
      onTheSixth();
      renderApp(withOtherIncome(), '/?plan', { size });
      const user = userEvent.setup();
      const income = await screen.findByRole('region', { name: 'Income' });
      await waitFor(() => expect(text(income)).toContain('RM 120.00'));
      const list = within(income).getByRole('list', { name: 'Income by category' });
      const links = within(list).getAllByRole('link');
      expect(links.map(text)).toEqual([
        'Other income 58% · 1 entry 70.00',
        'Salary 42% · 1 entry 50.00',
      ]);
      expect(links[1].getAttribute('href')).toBe(`?plan&category=${SALARY}`);

      await user.click(links[1]);
      expect(await screen.findByRole('heading', { level: 1, name: 'Salary' })).toBeTruthy();
      expect(window.location.search).toBe(`?plan&category=${SALARY}`);
      expect(screen.queryByRole('navigation', { name: 'Main' })).toBeNull();
      expect(
        await screen.findByText(
          usualLine('phone', 'Received in November', 'RM 46.36 over your usual RM 3.64'),
        ),
      ).toBeTruthy();
      const year = screen.getByRole('region', { name: /^Salary, last 12 months/ });
      expect(readYear(year)).toEqual({
        months: expected(TO_NOVEMBER, { 'Sep 2026': 'RM 40.00', 'Nov 2026': 'RM 50.00' }),
        shown: ['Nov 2026, RM 50.00'],
      });
      // Income has no budget
      expect(screen.queryByRole('meter')).toBeNull();
      expect(screen.getByRole('link', { name: 'See it in Activity' }).getAttribute('href')).toBe(
        `?activity&category=${SALARY}`,
      );

      await user.click(screen.getByRole('button', { name: 'Plan' }));
      await waitFor(() => expect(window.location.search).toBe('?plan'));
      expect(await screen.findByRole('list', { name: 'Income by category' })).toBeTruthy();
    },
  );

  test('on a computer, an income category opens beside the table, with no budget to set', async () => {
    onTheSixth();
    renderApp(withOtherIncome(), '/?plan', { size: 'desktop' });
    const user = userEvent.setup();
    // The largest spending category is open to start with
    expect(await screen.findByRole('complementary', { name: 'Food' })).toBeTruthy();
    const income = await screen.findByRole('region', { name: 'Income' });
    const list = await within(income).findByRole('list', { name: 'Income by category' });
    const links = within(list).getAllByRole('link');
    expect(links.map(text)).toEqual([
      'Other income 58% · 1 entry 70.00',
      'Salary 42% · 1 entry 50.00',
    ]);

    await user.click(links[1]);
    await waitFor(() => expect(window.location.search).toBe(`?plan&category=${SALARY}`));
    const salary = within(await screen.findByRole('complementary', { name: 'Salary' }));
    expect(await salary.findByText('RM 46.36 over your usual RM 3.64')).toBeTruthy();
    expect(readYear(salary.getByRole('region', { name: /^Salary, last 12 months/ })).shown).toEqual(
      ['Nov 2026, RM 50.00'],
    );
    expect(salary.queryByLabelText('Monthly budget')).toBeNull();
    expect(salary.queryByRole('switch')).toBeNull();
    expect(
      within(within(screen.getByRole('region', { name: 'Income' })).getByRole('list'))
        .getByRole('link', { name: /^Salary/ })
        .getAttribute('aria-current'),
    ).toBe('true');
  });
});
