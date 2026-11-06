// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { Account, ChangesBody, LedgerChange, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, renderApp, setupAppTests } from '../../testing/app';

// Finding transactions from Home: a "Search" row opens ?search, which matches what's typed
// against payees, notes, category names and amounts across every account, newest first,
// with filters for account, category and days. The catch-up (a date range and Other,
// select all, move them to the right category) happens there too, with no other page.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const VISA = 'c'.repeat(16);
const COFFEE = 'e'.repeat(16);
const categoryId = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

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

/**
 * A Wallet, a Bank and a Visa card, Coffee under Food, and one transaction on each day from
 * 1 to 9 September 2025, each with a word of its own to tell it by (its payee or note):
 *   1 Wallet RM 8.00 Food, paid to "Kopi Corner"
 *   2 Bank RM 8.50 Food › Coffee, note "kopi with Mei"
 *   3 Visa RM 80.00 Transport, paid to "Grab"
 *   4 Wallet RM 8.00 Other, note "mystery"
 *   5 Bank RM 1,000.00 Salary, from "ACME"
 *   6 Bank to Wallet RM 50.00, a transfer, note "top-up"
 *   7 Visa RM 12.00 Other, paid to "KOPI KING"
 *   8 Wallet RM 800.00 Other, note "big one"
 *   9 Bank RM 20.00 Other income, note "8 refund"
 */
function withHistory() {
  const server = fakeServer();
  seedAccount(server, { id: WALLET, name: 'Wallet', openingCents: 10_000 });
  seedAccount(server, { id: BANK, name: 'Bank', kind: 'bank', openingCents: 100_000 });
  seedAccount(server, { id: VISA, name: 'Visa', kind: 'card' });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  server.categories.push({
    id: COFFEE,
    name: 'Coffee',
    kind: 'expense',
    parentId: categoryId('Food'),
    position: 0,
    archived: false,
  });
  const rows: Partial<Transaction>[] = [
    { amountCents: 800, payee: 'Kopi Corner' },
    { accountId: BANK, amountCents: 850, categoryId: COFFEE, note: 'kopi with Mei' },
    { accountId: VISA, amountCents: 8_000, categoryId: categoryId('Transport'), payee: 'Grab' },
    { amountCents: 800, categoryId: categoryId('Other'), note: 'mystery' },
    {
      kind: 'income',
      accountId: BANK,
      amountCents: 100_000,
      categoryId: categoryId('Salary'),
      payee: 'ACME',
    },
    {
      kind: 'transfer',
      accountId: BANK,
      toAccountId: WALLET,
      amountCents: 5_000,
      categoryId: null,
      note: 'top-up',
    },
    { accountId: VISA, amountCents: 1_200, categoryId: categoryId('Other'), payee: 'KOPI KING' },
    { amountCents: 80_000, categoryId: categoryId('Other'), note: 'big one' },
    {
      kind: 'income',
      accountId: BANK,
      amountCents: 2_000,
      categoryId: categoryId('Other income'),
      note: '8 refund',
    },
  ];
  rows.forEach((t, i) =>
    server.transactions.push({
      id: (i + 1).toString(16).padStart(16, 'd'),
      kind: 'expense',
      accountId: WALLET,
      toAccountId: null,
      amountCents: 100,
      categoryId: categoryId('Food'),
      payee: null,
      note: null,
      date: `2025-09-0${i + 1}`,
      createdAt: i + 1,
      ...t,
    }),
  );
  return server;
}

/** The word each seeded transaction is told by, newest first */
const WORDS = [
  '8 refund',
  'big one',
  'KOPI KING',
  'top-up',
  'ACME',
  'mystery',
  'Grab',
  'kopi with Mei',
  'Kopi Corner',
];

/** The transactions found, newest first, each by its word; null before any are shown */
function foundWords() {
  const results = screen.queryByRole('region', { name: 'Results' });
  if (results == null) return null;
  return within(results)
    .queryAllByRole('listitem')
    .map((li) => WORDS.find((word) => li.textContent?.includes(word)) ?? li.textContent);
}

/** Opens Search from Home's row */
async function openSearch() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Search' }));
  expect(await screen.findByRole('heading', { name: 'Search transactions' })).toBeTruthy();
  return user;
}

/** Types into the search box in place of what was there */
async function searchFor(user: ReturnType<typeof userEvent.setup>, text: string) {
  const box = screen.getByRole('searchbox', { name: 'Search' });
  await user.clear(box);
  if (text !== '') await user.type(box, text);
}

/** Sets a day filter ("From" or "To") */
const setDay = (label: 'From' | 'To', day: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value: day } });

/** Every change each save carried, in order */
const sentChanges = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes);

describe('search', () => {
  test.each(SIZES)(
    'opens from Home as its own page, lists everything newest first, and goes back (%s)',
    async (size) => {
      renderApp(withHistory(), '/', { size });
      const user = await openSearch();
      expect(window.location.search).toBe('?search');
      await waitFor(() => expect(foundWords()).toEqual(WORDS));
      // Every account's, transfers too, with the account each is on
      const results = within(screen.getByRole('region', { name: 'Results' }));
      expect(results.getByText(/top-up/).closest('li')?.textContent).toMatch(/Bank/);
      expect(results.getByText(/Grab/).closest('li')?.textContent).toMatch(/Visa/);

      await user.click(screen.getByRole('button', { name: 'Home' }));
      expect(await screen.findByRole('button', { name: 'Search' })).toBeTruthy();
      expect(window.location.search).toBe('');
    },
  );

  test.each(SIZES)(
    'matches the payee, note, category name or amount, across every account, newest first (%s)',
    async (size) => {
      renderApp(withHistory(), '/', { size });
      const user = await openSearch();

      await searchFor(user, 'kopi');
      await waitFor(() =>
        expect(foundWords()).toEqual(['KOPI KING', 'kopi with Mei', 'Kopi Corner']),
      );
      // A category's name: Food finds Food › Coffee too
      await searchFor(user, 'food');
      await waitFor(() => expect(foundWords()).toEqual(['kopi with Mei', 'Kopi Corner']));
      await searchFor(user, 'transport');
      await waitFor(() => expect(foundWords()).toEqual(['Grab']));
      // An amount, exactly: 8.50 isn't 8, and 8 isn't 80 or 800
      await searchFor(user, '8.50');
      await waitFor(() => expect(foundWords()).toEqual(['kopi with Mei']));
      await searchFor(user, '8');
      await waitFor(() => expect(foundWords()).toEqual(['8 refund', 'mystery', 'Kopi Corner']));
      await searchFor(user, 'nothing like this');
      expect(await screen.findByText('No transactions match')).toBeTruthy();
      expect(foundWords()).toEqual([]);
    },
  );

  test('filters by account, category and days, with or without words', async () => {
    renderApp(withHistory(), '/?search');
    const user = userEvent.setup();
    expect(await screen.findByRole('heading', { name: 'Search transactions' })).toBeTruthy();
    await waitFor(() => expect(foundWords()).toEqual(WORDS));

    // The transfer into the Wallet is on it too
    await user.selectOptions(screen.getByLabelText('Account'), 'Wallet');
    await waitFor(() =>
      expect(foundWords()).toEqual(['big one', 'top-up', 'mystery', 'Kopi Corner']),
    );
    await user.selectOptions(screen.getByLabelText('Account'), 'All accounts');

    // A category brings its subcategories with it
    await user.selectOptions(screen.getByLabelText('Category'), 'Food');
    await waitFor(() => expect(foundWords()).toEqual(['kopi with Mei', 'Kopi Corner']));
    await user.selectOptions(screen.getByLabelText('Category'), 'Food › Coffee');
    await waitFor(() => expect(foundWords()).toEqual(['kopi with Mei']));
    await user.selectOptions(screen.getByLabelText('Category'), 'All categories');

    // From and To are both included
    setDay('From', '2025-09-03');
    setDay('To', '2025-09-07');
    await waitFor(() =>
      expect(foundWords()).toEqual(['KOPI KING', 'top-up', 'ACME', 'mystery', 'Grab']),
    );
    // With words as well
    await searchFor(user, 'kopi');
    await waitFor(() => expect(foundWords()).toEqual(['KOPI KING']));
  });
});

describe('catching up', () => {
  test.each(SIZES)(
    'filters to a date range and Other, selects all and moves them to Food, all from ?search (%s)',
    async (size) => {
      const server = withHistory();
      renderApp(server, '/', { size });
      const user = await openSearch();
      // No other page is ever opened on the way
      const pages = new Set<string>();
      const notePage = () => pages.add(window.location.search.split('&')[0]);
      window.addEventListener('popstate', notePage);
      const watch = setInterval(notePage, 20);
      try {
        // Everything found first: the category list is filled once the ledger has loaded
        await waitFor(() => expect(foundWords()).toEqual(WORDS));
        setDay('From', '2025-09-04');
        setDay('To', '2025-09-08');
        await user.selectOptions(screen.getByLabelText('Category'), 'Other');
        await waitFor(() => expect(foundWords()).toEqual(['big one', 'KOPI KING', 'mystery']));

        await user.click(screen.getByRole('button', { name: 'Select' }));
        await user.click(screen.getByRole('button', { name: 'Select all' }));
        expect(await screen.findByText('3 selected')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Change category' }));
        const preview = within(await screen.findByRole('dialog'));
        await user.selectOptions(preview.getByLabelText('Category'), 'Food');
        expect(preview.getByText('Move 3 transactions from Other to Food')).toBeTruthy();
        await user.click(preview.getByRole('button', { name: 'Move' }));

        // None left in Other over those days, at once
        expect(await screen.findByText('No transactions match')).toBeTruthy();
        await waitFor(() =>
          expect(
            Object.fromEntries(server.transactions.map((t) => [t.note ?? t.payee, t.categoryId])),
          ).toEqual({
            'Kopi Corner': categoryId('Food'),
            'kopi with Mei': COFFEE,
            'Grab': categoryId('Transport'),
            'mystery': categoryId('Food'),
            'ACME': categoryId('Salary'),
            'top-up': null,
            'KOPI KING': categoryId('Food'),
            'big one': categoryId('Food'),
            '8 refund': categoryId('Other income'),
          }),
        );
        // In one change
        const moved = sentChanges();
        expect(moved).toHaveLength(1);
        const [only] = moved as Extract<LedgerChange, { op: 'recategoriseTransactions' }>[];
        expect(only.op).toBe('recategoriseTransactions');
        expect(only.categoryId).toBe(categoryId('Food'));
        expect([...only.ids].sort()).toEqual(
          server.transactions
            .filter((t) => ['mystery', 'KOPI KING', 'big one'].includes(t.note ?? t.payee ?? ''))
            .map((t) => t.id)
            .sort(),
        );

        // Undo puts every one back in Other
        await user.click(await screen.findByRole('button', { name: 'Undo' }));
        await waitFor(() =>
          expect(
            server.transactions
              .filter((t) => t.categoryId === categoryId('Other'))
              .map((t) => t.note ?? t.payee)
              .sort(),
          ).toEqual(['KOPI KING', 'big one', 'mystery']),
        );
        await waitFor(() => expect(foundWords()).toEqual(['big one', 'KOPI KING', 'mystery']));
      } finally {
        clearInterval(watch);
        window.removeEventListener('popstate', notePage);
      }
      notePage();
      expect([...pages]).toEqual(['?search']);
    },
  );
});
