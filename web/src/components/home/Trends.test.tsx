// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from '../../testing/app';

// Spending over time on Home's month card: every category row, Spent and Received open
// in place to the last 12 months ending at the month the card shows, one bar a month with
// its amount, then the average of the 11 months before and how the shown month compares.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const COFFEE = 'e'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

/** The app's clock reads Friday 6 November 2026, mid-morning, and still ticks */
function onTheSixth() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 6, 10, 0, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
}

/** December 2025 to November 2026, as each bar is labelled */
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
  seed(server, {
    kind: 'income',
    amountCents: 5_000,
    categoryId: categoryId('Salary'),
    date: '2026-11-05',
  });
  seed(server, {
    kind: 'income',
    amountCents: 4_000,
    categoryId: categoryId('Salary'),
    date: '2026-09-25',
  });
  seed(server, {
    kind: 'transfer',
    toAccountId: BANK,
    amountCents: 40_000,
    categoryId: null,
    date: '2026-10-10',
  });
  return server;
}

/** The month card showing `heading` ("November 2026") */
const monthCard = async (heading: string) =>
  within(await screen.findByRole('region', { name: heading }));

/** A figure on the card, as read out: "RM 11.00" for "Spent" */
const figure = (card: ReturnType<typeof within>, label: string) =>
  card.getByLabelText(label).textContent;

const rows = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((li) => li.textContent);

/** The last 12 months opened under a row, as named: "Food, last 12 months" */
const twelveMonths = (card: ReturnType<typeof within>, name: string) =>
  card.findByRole('group', { name: `${name}, last 12 months` });

/** The same, once it's open */
const openTwelveMonths = (card: ReturnType<typeof within>, name: string) =>
  card.getByRole('group', { name: `${name}, last 12 months` });

/** Each month's bar as read out, oldest first: "Dec 2025, RM 0.00" */
const bars = (group: HTMLElement) =>
  within(within(group).getByRole('list')).getAllByRole('listitem');

/** The bars read out with each month's amount, and which month is highlighted */
function readBars(group: HTMLElement) {
  const all = bars(group);
  return {
    amounts: all.map((li) => li.textContent),
    highlighted: all
      .filter((li) => li.getAttribute('aria-current') === 'true')
      .map((li) => li.textContent),
  };
}

/** The 12 bars read out, from `months` and their amounts (RM 0.00 where none is given) */
const expected = (months: string[], amounts: Record<string, string>) =>
  months.map((m) => `${m}, ${amounts[m] ?? 'RM 0.00'}`);

describe('spending over time on the month card', () => {
  test.each(SIZES)(
    'opens Food to its subcategories, then its last 12 months, with the average of the 11 before (%s)',
    async (size) => {
      onTheSixth();
      renderApp(withAYear(), '/', { size });
      const user = userEvent.setup();
      const card = await monthCard('November 2026');
      await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 16.00'));

      expect(card.queryByText('Last 12 months')).toBeNull();
      await user.click(card.getByRole('button', { name: 'Food, RM 11.00' }));
      // Its subcategories first, as before
      expect(rows(card.getByRole('list', { name: 'In Food' }))).toEqual([
        'Coffee, RM 3.00',
        'Filed under Food itself, RM 8.00',
      ]);
      const food = await twelveMonths(card, 'Food');
      expect(within(food).getByText('Last 12 months')).toBeTruthy();
      // Coffee counts toward Food; November 2025 is a month too early
      const { amounts, highlighted } = readBars(food);
      expect(amounts).toEqual(
        expected(TO_NOVEMBER, {
          'Jan 2026': 'RM 15.40',
          'Aug 2026': 'RM 10.00',
          'Oct 2026': 'RM 20.00',
          'Nov 2026': 'RM 11.00',
        }),
      );
      // This month's bar is the card's figure for Food, and it's the one highlighted
      expect(highlighted).toEqual(['Nov 2026, RM 11.00']);
      // RM 45.40 over the 11 months before is RM 4.1272..., RM 4.13 to the cent
      expect(within(food).getByText('Average RM 4.13 a month (previous 11)')).toBeTruthy();
      expect(within(food).getByText('This month RM 6.87 above average')).toBeTruthy();
    },
  );

  test.each(SIZES)(
    'opens a category without subcategories to its last 12 months alone (%s)',
    async (size) => {
      onTheSixth();
      renderApp(withAYear(), '/', { size });
      const user = userEvent.setup();
      const card = await monthCard('November 2026');

      await user.click(await card.findByRole('button', { name: 'Transport, RM 5.00' }));
      const transport = await twelveMonths(card, 'Transport');
      expect(card.queryByRole('list', { name: 'In Transport' })).toBeNull();
      const { amounts, highlighted } = readBars(transport);
      expect(amounts).toEqual(expected(TO_NOVEMBER, { 'Nov 2026': 'RM 5.00' }));
      expect(highlighted).toEqual(['Nov 2026, RM 5.00']);
      expect(within(transport).getByText('Average RM 0.00 a month (previous 11)')).toBeTruthy();
      expect(within(transport).getByText('This month RM 5.00 above average')).toBeTruthy();
      // Opening one row leaves the others as they were
      await user.click(card.getByRole('button', { name: 'Food, RM 11.00' }));
      expect(await twelveMonths(card, 'Food')).toBeTruthy();
      expect(await twelveMonths(card, 'Transport')).toBeTruthy();
    },
  );

  test.each(SIZES)(
    'opens Spent to all spending over 12 months, never counting money moved between accounts (%s)',
    async (size) => {
      onTheSixth();
      renderApp(withAYear(), '/', { size });
      const user = userEvent.setup();
      const card = await monthCard('November 2026');
      await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 16.00'));

      const spent = card.getByRole('button', { name: /^Spent/ });
      expect(spent.getAttribute('aria-expanded')).toBe('false');
      await user.click(spent);
      expect(spent.getAttribute('aria-expanded')).toBe('true');
      const spending = await twelveMonths(card, 'Spending');
      // October is Food's RM 20 alone: the RM 400 moved to the Bank isn't spending
      const { amounts, highlighted } = readBars(spending);
      expect(amounts).toEqual(
        expected(TO_NOVEMBER, {
          'Jan 2026': 'RM 15.40',
          'Aug 2026': 'RM 10.00',
          'Oct 2026': 'RM 20.00',
          'Nov 2026': 'RM 16.00',
        }),
      );
      // The card's Spent figure
      expect(highlighted).toEqual(['Nov 2026, RM 16.00']);
      expect(within(spending).getByText('Average RM 4.13 a month (previous 11)')).toBeTruthy();
      expect(within(spending).getByText('This month RM 11.87 above average')).toBeTruthy();
      // Spent opens no list of categories of its own: they're on the card already
      expect(card.getAllByRole('list', { name: 'Spending by category' })).toHaveLength(1);
    },
  );

  test.each(SIZES)(
    'opens Received to income by category and all income over 12 months, and an income category to its own (%s)',
    async (size) => {
      onTheSixth();
      renderApp(withAYear(), '/', { size });
      const user = userEvent.setup();
      const card = await monthCard('November 2026');
      await waitFor(() => expect(figure(card, 'Received')).toBe('RM 50.00'));

      await user.click(card.getByRole('button', { name: /^Received/ }));
      expect(rows(card.getByRole('list', { name: 'Income by category' }))).toEqual([
        'Salary, RM 50.00',
      ]);
      const income = await twelveMonths(card, 'Income');
      const all = readBars(income);
      expect(all.amounts).toEqual(
        expected(TO_NOVEMBER, { 'Sep 2026': 'RM 40.00', 'Nov 2026': 'RM 50.00' }),
      );
      expect(all.highlighted).toEqual(['Nov 2026, RM 50.00']);
      // RM 40 over 11 months is RM 3.6363..., RM 3.64 to the cent
      expect(within(income).getByText('Average RM 3.64 a month (previous 11)')).toBeTruthy();
      expect(within(income).getByText('This month RM 46.36 above average')).toBeTruthy();

      await user.click(card.getByRole('button', { name: 'Salary, RM 50.00' }));
      const salary = await twelveMonths(card, 'Salary');
      expect(readBars(salary).amounts).toEqual(
        expected(TO_NOVEMBER, { 'Sep 2026': 'RM 40.00', 'Nov 2026': 'RM 50.00' }),
      );
    },
  );

  test.each(SIZES)(
    'steps back two months: the 12 months end there, compared with the 11 before (%s)',
    async (size) => {
      onTheSixth();
      renderApp(withAYear(), '/', { size });
      const user = userEvent.setup();
      let card = await monthCard('November 2026');
      await user.click(card.getByRole('button', { name: 'Previous month' }));
      card = await monthCard('October 2026');
      await user.click(card.getByRole('button', { name: 'Previous month' }));
      card = await monthCard('September 2026');
      expect(window.location.search).toBe('?month=2026-09');
      await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 0.00'));

      // Nothing spent in September, and Spent still opens
      await user.click(card.getByRole('button', { name: /^Spent/ }));
      const spending = await twelveMonths(card, 'Spending');
      const months = [
        'Oct 2025',
        'Nov 2025',
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
      ];
      const { amounts, highlighted } = readBars(spending);
      expect(amounts).toEqual(
        expected(months, {
          'Nov 2025': 'RM 99.00',
          'Jan 2026': 'RM 15.40',
          'Aug 2026': 'RM 10.00',
        }),
      );
      expect(highlighted).toEqual(['Sep 2026, RM 0.00']);
      // RM 124.40 over the 11 months before is RM 11.3090..., RM 11.31
      expect(within(spending).getByText('Average RM 11.31 a month (previous 11)')).toBeTruthy();
      expect(within(spending).getByText('This month RM 11.31 below average')).toBeTruthy();
    },
  );

  test.each(SIZES)('opens Spent and Received in a year with nothing in it (%s)', async (size) => {
    onTheSixth();
    renderApp(withAccounts(), '/', { size });
    const user = userEvent.setup();
    const card = await monthCard('November 2026');
    expect(await card.findByText('Nothing spent or received in November yet.')).toBeTruthy();

    await user.click(card.getByRole('button', { name: /^Spent/ }));
    await user.click(card.getByRole('button', { name: /^Received/ }));
    for (const name of ['Spending', 'Income']) {
      const group = await twelveMonths(card, name);
      const { amounts, highlighted } = readBars(group);
      expect(amounts).toEqual(expected(TO_NOVEMBER, {}));
      expect(highlighted).toEqual(['Nov 2026, RM 0.00']);
      expect(within(group).getByText('Average RM 0.00 a month (previous 11)')).toBeTruthy();
      expect(within(group).getByText('This month the same as average')).toBeTruthy();
    }
    // No income categories: Received opens to its 12 months alone
    expect(card.queryByRole('list', { name: 'Income by category' })).toBeNull();
  });

  test('says when this month is the same as the average, with no amount', async () => {
    onTheSixth();
    const server = withAccounts();
    for (const month of [
      '2025-12',
      ...TO_NOVEMBER.slice(1).map((_, i) => `2026-${String(i + 1).padStart(2, '0')}`),
    ]) {
      seed(server, { amountCents: 1_000, categoryId: categoryId('Fun'), date: `${month}-01` });
    }
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();
    const card = await monthCard('November 2026');

    await user.click(await card.findByRole('button', { name: 'Fun, RM 10.00' }));
    const fun = await twelveMonths(card, 'Fun');
    expect(readBars(fun).amounts).toEqual(TO_NOVEMBER.map((m) => `${m}, RM 10.00`));
    expect(within(fun).getByText('Average RM 10.00 a month (previous 11)')).toBeTruthy();
    expect(within(fun).getByText('This month the same as average')).toBeTruthy();
    expect(within(fun).queryByText(/RM 0\.00 (above|below)/)).toBeNull();
  });

  test('counts spending added offline in the month it is on, through a reload, and once saved', async () => {
    onTheSixth();
    const server = withAYear();
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();
    let card = await monthCard('November 2026');
    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 16.00'));

    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));
    const spend = async (amount: string, date: string) => {
      await user.click(await screen.findByRole('button', { name: 'Add' }));
      const form = within(await screen.findByRole('dialog'));
      await user.type(form.getByLabelText('Amount'), amount);
      await user.click(form.getByRole('radio', { name: 'Transport' }));
      await user.clear(form.getByLabelText('Date'));
      await user.type(form.getByLabelText('Date'), date);
      await user.click(form.getByRole('button', { name: 'Save' }));
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    };
    await spend('8', '2026-11-04');
    await spend('7', '2026-10-20');
    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 24.00'));

    const counted = {
      'Jan 2026': 'RM 15.40',
      'Aug 2026': 'RM 10.00',
      'Oct 2026': 'RM 27.00',
      'Nov 2026': 'RM 24.00',
    };
    await user.click(card.getByRole('button', { name: /^Spent/ }));
    await waitFor(() =>
      expect(readBars(openTwelveMonths(card, 'Spending')).amounts).toEqual(
        expected(TO_NOVEMBER, counted),
      ),
    );
    await user.click(card.getByRole('button', { name: 'Transport, RM 13.00' }));
    expect(readBars(await twelveMonths(card, 'Transport')).amounts).toEqual(
      expected(TO_NOVEMBER, { 'Oct 2026': 'RM 7.00', 'Nov 2026': 'RM 13.00' }),
    );

    // Opened again offline: the 12 months kept on the device, with the changes still to send
    await reloadApp(server, '/', { size: 'phone' });
    card = await monthCard('November 2026');
    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 24.00'));
    await user.click(card.getByRole('button', { name: /^Spent/ }));
    await waitFor(() =>
      expect(readBars(openTwelveMonths(card, 'Spending')).amounts).toEqual(
        expected(TO_NOVEMBER, counted),
      ),
    );
    expect(server.transactions).toHaveLength(10);

    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(server.transactions).toHaveLength(12));
    await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
    // Counted once, now that the server sums them too
    await waitFor(() =>
      expect(readBars(openTwelveMonths(card, 'Spending')).amounts).toEqual(
        expected(TO_NOVEMBER, counted),
      ),
    );
    expect(
      within(await twelveMonths(card, 'Spending')).getByText('This month RM 19.24 above average'),
    ).toBeTruthy();
  });
  test.each(SIZES)(
    'opens Received in a month with no income to the income of the months before (%s)',
    async (size) => {
      onTheSixth();
      renderApp(withAYear(), '/', { size });
      const user = userEvent.setup();
      let card = await monthCard('November 2026');
      await user.click(card.getByRole('button', { name: 'Previous month' }));
      card = await monthCard('October 2026');
      await waitFor(() => expect(figure(card, 'Received')).toBe('RM 0.00'));

      const received = card.getByRole('button', { name: /^Received/ });
      await user.click(received);
      expect(received.getAttribute('aria-expanded')).toBe('true');
      expect(card.queryByRole('list', { name: 'Income by category' })).toBeNull();
      const income = await twelveMonths(card, 'Income');
      const months = [
        'Nov 2025',
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
      ];
      const { amounts, highlighted } = readBars(income);
      expect(amounts).toEqual(expected(months, { 'Sep 2026': 'RM 40.00' }));
      expect(highlighted).toEqual(['Oct 2026, RM 0.00']);
      expect(within(income).getByText('Average RM 3.64 a month (previous 11)')).toBeTruthy();
      expect(within(income).getByText('This month RM 3.64 below average')).toBeTruthy();
    },
  );

  test('shows the month, and opens Spent and Received, when the 12 months cannot be read', async () => {
    onTheSixth();
    const server = withAYear();
    server.pathsDown.add('/api/summary/trend');
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();
    const card = await monthCard('November 2026');
    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 16.00'));
    expect(figure(card, 'Received')).toBe('RM 50.00');
    expect(figure(card, 'Left this month')).toBe('RM 34.00');

    await user.click(card.getByRole('button', { name: /^Spent/ }));
    await user.click(card.getByRole('button', { name: /^Received/ }));
    await user.click(card.getByRole('button', { name: 'Food, RM 11.00' }));
    for (const name of ['Spending', 'Income', 'Food']) {
      const group = await twelveMonths(card, name);
      // Nothing made up in place of the months it couldn't read
      await waitFor(() => expect(within(group).queryByText(/Loading/)).toBeNull());
      expect(within(group).queryAllByRole('listitem')).toEqual([]);
      expect(within(group).queryByText(/RM 0\.00/)).toBeNull();
      expect(within(group).queryByText(/^Average/)).toBeNull();
    }
    // The rest of the card is as it was
    expect(rows(card.getByRole('list', { name: 'Income by category' }))).toEqual([
      'Salary, RM 50.00',
    ]);
  });

  test('ends the 12 months at the month shown, whichever answer comes last', async () => {
    onTheSixth();
    const server = withAYear();
    // November's 12 months answer only after October's
    const november = holdNext(server, 'GET', '/api/summary/trend');
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();
    let card = await monthCard('November 2026');
    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 16.00'));
    await user.click(card.getByRole('button', { name: 'Previous month' }));
    card = await monthCard('October 2026');
    await user.click(card.getByRole('button', { name: /^Spent/ }));
    const october = [
      'Nov 2025',
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
    ];
    const octoberAmounts = {
      'Nov 2025': 'RM 99.00',
      'Jan 2026': 'RM 15.40',
      'Aug 2026': 'RM 10.00',
      'Oct 2026': 'RM 20.00',
    };
    await waitFor(() =>
      expect(readBars(openTwelveMonths(card, 'Spending')).amounts).toEqual(
        expected(october, octoberAmounts),
      ),
    );
    november.release();
    // November's answer arriving late changes nothing shown for October
    await waitFor(() => expect(server.held).toHaveLength(0));
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    const { amounts, highlighted } = readBars(openTwelveMonths(card, 'Spending'));
    expect(amounts).toEqual(expected(october, octoberAmounts));
    expect(highlighted).toEqual(['Oct 2026, RM 20.00']);

    // And November's own, once back there
    await user.click(card.getByRole('button', { name: 'Next month' }));
    card = await monthCard('November 2026');
    await user.click(card.getByRole('button', { name: /^Spent/ }));
    await waitFor(() =>
      expect(readBars(openTwelveMonths(card, 'Spending')).highlighted).toEqual([
        'Nov 2026, RM 16.00',
      ]),
    );
  });

  test('closes a row on a second tap, leaving the others open', async () => {
    onTheSixth();
    renderApp(withAYear(), '/', { size: 'phone' });
    const user = userEvent.setup();
    const card = await monthCard('November 2026');

    await user.click(await card.findByRole('button', { name: 'Transport, RM 5.00' }));
    const food = card.getByRole('button', { name: 'Food, RM 11.00' });
    await user.click(food);
    expect(await twelveMonths(card, 'Food')).toBeTruthy();
    expect(food.getAttribute('aria-expanded')).toBe('true');

    await user.click(food);
    expect(food.getAttribute('aria-expanded')).toBe('false');
    expect(card.queryByRole('list', { name: 'In Food' })).toBeNull();
    expect(card.queryByRole('group', { name: 'Food, last 12 months' })).toBeNull();
    expect(
      card.getByRole('button', { name: 'Transport, RM 5.00' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(await twelveMonths(card, 'Transport')).toBeTruthy();
  });
});
