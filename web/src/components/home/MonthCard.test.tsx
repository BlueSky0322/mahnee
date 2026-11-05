// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from '../../testing/app';
import { addMonths, monthHeading, thisMonth } from '../../utils/date-input';

// The month at the top of Home: what's left, spent and received, and where the spending
// went by category, for this month or an earlier one.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const COFFEE = 'e'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const NOW = thisMonth();
const BEFORE = addMonths(NOW, -1);

/** A Wallet with RM 0 in it, and Coffee under Food */
function withWallet() {
  const server = fakeServer();
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 0,
    position: 0,
    archived: false,
  });
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
/** A transaction the server has before the app opens: spending on the 1st of this month */
function seed(server: FakeServer, t: Partial<Transaction>) {
  seeded++;
  server.transactions.push({
    id: seeded.toString(16).padStart(16, 'd'),
    kind: 'expense',
    accountId: WALLET,
    amountCents: 800,
    categoryId: categoryId('Food'),
    payee: null,
    note: null,
    date: `${NOW}-01`,
    createdAt: seeded,
    ...t,
  });
}

/** RM 8 on Food, RM 3 on Coffee and RM 50 of salary this month */
function withFoodAndSalary() {
  const server = withWallet();
  seed(server, { amountCents: 800 });
  seed(server, { amountCents: 300, categoryId: COFFEE });
  seed(server, { kind: 'income', amountCents: 5_000, categoryId: categoryId('Salary') });
  return server;
}

/** The month card showing `month` */
const monthCard = async (month: string) =>
  within(await screen.findByRole('region', { name: monthHeading(month) }));

/** A figure on the card, as read out: "RM 39.00" for "Left this month" */
const figure = (card: ReturnType<typeof within>, label: string) =>
  card.getByLabelText(label).textContent;

const rows = (list: HTMLElement) =>
  within(list)
    .getAllByRole('listitem')
    .map((li) => li.textContent);

describe('the month on Home', () => {
  test.each(SIZES)(
    'shows what is left, spent and received, and opens Food to its subcategories (%s)',
    async (size) => {
      const server = withFoodAndSalary();
      // Moved between the person's own accounts: never spending
      seed(server, { kind: 'transfer', amountCents: 40_000, categoryId: null });
      renderApp(server, '/', { size });
      const user = userEvent.setup();

      const card = await monthCard(NOW);
      await waitFor(() => expect(figure(card, 'Left this month')).toBe('RM 39.00'));
      expect(figure(card, 'Spent')).toBe('RM 11.00');
      expect(figure(card, 'Received')).toBe('RM 50.00');

      const spending = card.getByRole('list', { name: 'Spending by category' });
      expect(rows(spending)).toEqual(['Food, RM 11.00']);
      expect(card.queryByRole('list', { name: 'In Food' })).toBeNull();
      await user.click(card.getByRole('button', { name: 'Food, RM 11.00' }));
      expect(rows(card.getByRole('list', { name: 'In Food' }))).toEqual([
        'Coffee, RM 3.00',
        'Filed under Food itself, RM 8.00',
      ]);

      // Where the income came from is folded under Received
      expect(card.queryByRole('list', { name: 'Income by category' })).toBeNull();
      await user.click(card.getByRole('button', { name: /^Received/ }));
      expect(rows(card.getByRole('list', { name: 'Income by category' }))).toEqual([
        'Salary, RM 50.00',
      ]);
    },
  );

  test.each(SIZES)('steps back to earlier months, and Back returns (%s)', async (size) => {
    const server = withWallet();
    seed(server, { date: `${BEFORE}-20`, amountCents: 2_000, categoryId: categoryId('Fun') });
    seed(server, {
      date: `${BEFORE}-02`,
      kind: 'income',
      amountCents: 10_000,
      categoryId: categoryId('Salary'),
    });
    renderApp(server, '/', { size });
    const user = userEvent.setup();

    let card = await monthCard(NOW);
    // Nothing comes after this month
    expect(card.getByRole('button', { name: 'Next month' })).toHaveProperty('disabled', true);
    expect(
      await card.findByText(`Nothing spent or received in ${monthName(NOW)} yet.`),
    ).toBeTruthy();

    await user.click(card.getByRole('button', { name: 'Previous month' }));
    card = await monthCard(BEFORE);
    expect(window.location.search).toBe(`?month=${BEFORE}`);
    await waitFor(() => expect(figure(card, `Left in ${monthName(BEFORE)}`)).toBe('RM 80.00'));
    expect(rows(card.getByRole('list', { name: 'Spending by category' }))).toEqual([
      'Fun, RM 20.00',
    ]);

    await user.click(card.getByRole('button', { name: 'Previous month' }));
    card = await monthCard(addMonths(NOW, -2));
    expect(
      await card.findByText(`Nothing spent or received in ${monthName(addMonths(NOW, -2))}.`),
    ).toBeTruthy();

    act(() => window.history.back());
    card = await monthCard(BEFORE);
    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 20.00'));
    // Forward again to this month, whose address names no month
    await user.click(card.getByRole('button', { name: 'Next month' }));
    await monthCard(NOW);
    expect(window.location.search).toBe('');
  });

  test('says plainly when more was spent than came in', async () => {
    const server = withWallet();
    seed(server, { amountCents: 1_500 });
    seed(server, { kind: 'income', amountCents: 1_000, categoryId: categoryId('Salary') });
    renderApp(server, '/', { size: 'phone' });

    const card = await monthCard(NOW);
    await waitFor(() => expect(figure(card, 'Over this month')).toBe('−RM 5.00'));
    expect(card.getByText('RM 5.00 more was spent than came in.')).toBeTruthy();
  });

  test('shows placeholders until the month arrives, never the empty month first', async () => {
    const server = withWallet();
    const held = holdNext(server, 'GET', '/api/summary');
    renderApp(server);

    const card = await monthCard(NOW);
    expect(card.getByText('Loading this month')).toBeTruthy();
    await screen.findByRole('button', { name: /^Wallet/ });
    expect(card.queryByText(/Nothing spent/)).toBeNull();
    held.release();
    expect(
      await card.findByText(`Nothing spent or received in ${monthName(NOW)} yet.`),
    ).toBeTruthy();
    expect(card.queryByText('Loading this month')).toBeNull();
  });

  test('counts spending added offline at once, through a reload, and once saved', async () => {
    const server = withFoodAndSalary();
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();
    let card = await monthCard(NOW);
    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 11.00'));

    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = within(await screen.findByRole('dialog'));
    await user.type(form.getByLabelText('Amount'), '8');
    await user.click(form.getByRole('radio', { name: 'Transport' }));
    await user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 19.00'));
    expect(figure(card, 'Left this month')).toBe('RM 31.00');
    expect(rows(card.getByRole('list', { name: 'Spending by category' }))).toEqual([
      'Food, RM 11.00',
      'Transport, RM 8.00',
    ]);

    // Opened again offline: the month kept on the device, with the change still to send
    await reloadApp(server, '/', { size: 'phone' });
    card = await monthCard(NOW);
    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 19.00'));
    expect(server.transactions).toHaveLength(3);

    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(server.transactions).toHaveLength(4));
    await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
    // Counted once, now that the server sums it too
    await waitFor(() => expect(figure(card, 'Spent')).toBe('RM 19.00'));
    expect(figure(card, 'Left this month')).toBe('RM 31.00');
  });
});

const monthName = (month: string) => monthHeading(month, { short: true });
