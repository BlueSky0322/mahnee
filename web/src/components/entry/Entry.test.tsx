// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Account, ChangesBody, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from '../../testing/app';
import { toDateInput } from '../../utils/date-input';

// Adding what was spent or received from the entry sheet, and changing or deleting it
// from an account's page: shown at once, the balances with it, and saved.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const OFFLINE = "Offline. Changes are kept on this device and saved when you're back.";
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

/** A server with RM 100 in a cash Wallet and RM 500 in a Bank account */
function withAccounts() {
  const server = fakeServer();
  seedAccount(server, { id: WALLET, name: 'Wallet', openingCents: 10_000 });
  seedAccount(server, { id: BANK, name: 'Bank', kind: 'bank', openingCents: 50_000 });
  return server;
}

let seeded = 0;
/** A transaction the server has before the app opens */
function seedTransaction(server: FakeServer, t: Partial<Transaction> = {}) {
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
    date: '2026-10-14',
    createdAt: seeded,
    ...t,
  });
}

/** An account's row on Home, read out with its balance */
const accountRow = (name: string, balance: string) =>
  screen.findByRole('button', { name: new RegExp(`^${name}, [\\w-]+, ${balance}$`) });

const dialog = async () => within(await screen.findByRole('dialog'));

/** The transaction changes each save carried, in order */
const sentTransactions = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes)
    .filter((c) => c.op.endsWith('Transaction'));

describe('adding from Home', () => {
  test.each(SIZES)('saves an RM 8 coffee with the defaults: type 8, Save (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/', { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = await dialog();
    // The amount is ready to type into straight away
    await waitFor(() => expect(document.activeElement).toBe(form.getByLabelText('Amount')));
    await user.keyboard('8');
    await user.click(form.getByRole('button', { name: 'Save' }));

    expect(await accountRow('Wallet', 'RM 92.00')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({
          kind: 'expense',
          accountId: WALLET,
          amountCents: 800,
          categoryId: categoryId('Food'),
          payee: null,
          note: null,
          date: toDateInput(new Date()),
        }),
      ]),
    );
    // The first change of all, so the default categories were saved with it
    expect(server.categories).toHaveLength(DEFAULT_CATEGORIES.length);
  });

  test.each(SIZES)('adds money received to the balance (%s)', async (size) => {
    const server = withAccounts();
    renderApp(server, '/', { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = await dialog();
    await user.type(form.getByLabelText('Amount'), '1,250.50');
    await user.click(form.getByRole('radio', { name: 'Received' }));
    // Income goes in an income category: the first is picked unless another is
    expect(form.getByRole('radio', { name: 'Salary' })).toHaveProperty('checked', true);
    expect(form.queryByRole('radio', { name: 'Food' })).toBeNull();
    await user.click(form.getByRole('button', { name: 'Save' }));

    expect(await accountRow('Wallet', 'RM 1,350.50')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({
          kind: 'income',
          amountCents: 125_050,
          categoryId: categoryId('Salary'),
        }),
      ]),
    );
  });

  test('remembers the account and each kind’s category used last, on this device', async () => {
    const server = withAccounts();
    renderApp(server);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add' }));
    let form = await dialog();
    await user.type(form.getByLabelText('Amount'), '3.20');
    await user.selectOptions(form.getByLabelText('Account'), 'Bank');
    await user.click(form.getByRole('radio', { name: 'Transport' }));
    await user.click(form.getByRole('button', { name: 'More' }));
    await user.type(form.getByLabelText('Paid to'), '  LRT ');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({
          accountId: BANK,
          categoryId: categoryId('Transport'),
          payee: 'LRT',
        }),
      ]),
    );

    // Opened again after a reload: the same account and category, ready for the next
    await reloadApp(server);
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    form = await dialog();
    expect(form.getByLabelText('Account')).toHaveProperty('value', BANK);
    expect(form.getByRole('radio', { name: 'Transport' })).toHaveProperty('checked', true);
    // Income has its own: none used yet, so the first
    await user.click(form.getByRole('radio', { name: 'Received' }));
    expect(form.getByRole('radio', { name: 'Salary' })).toHaveProperty('checked', true);
  });

  test('picks a subcategory under the category it is in', async () => {
    const server = withAccounts();
    server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    const coffee = 'e'.repeat(16);
    server.categories.push({
      id: coffee,
      name: 'Coffee',
      kind: 'expense',
      parentId: categoryId('Food'),
      position: 0,
      archived: false,
    });
    renderApp(server);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = await dialog();
    // Food is picked, so what's in it shows under it
    const inFood = within(form.getByRole('radiogroup', { name: 'In Food' }));
    await user.click(inFood.getByRole('radio', { name: 'Coffee' }));
    await user.type(form.getByLabelText('Amount'), '8');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(server.transactions[0]?.categoryId).toBe(coffee));

    await user.click(await accountRow('Wallet', 'RM 92.00'));
    expect(await screen.findByRole('button', { name: 'Food › Coffee, −RM 8.00' })).toBeTruthy();
  });

  test('says what is wrong with the amount or day, and saves nothing', async () => {
    const server = withAccounts();
    renderApp(server);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = await dialog();
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(form.getByText('Enter an amount, like 8.50')).toBeTruthy();
    await user.type(form.getByLabelText('Amount'), '10000000.01');
    await user.clear(form.getByLabelText('Date'));
    await user.type(form.getByLabelText('Date'), '1999-12-31');
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(form.getByText('Up to 10,000,000')).toBeTruthy();
    expect(form.getByText('Pick a day from 2000 up to today')).toBeTruthy();
    expect(sentTransactions()).toEqual([]);
  });

  test('has no Add until there is an account to put it on', async () => {
    const server = fakeServer();
    renderApp(server);
    expect(await screen.findByText('Add your first account')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
  });

  test.each(SIZES)("puts a refused one back, with the server's explanation (%s)", async (size) => {
    const server = withAccounts();
    server.failNext.changes = { status: 409, error: 'Wallet is archived' };
    const held = holdNext(server, 'POST', '/api/changes');
    renderApp(server, '/', { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = await dialog();
    await user.type(form.getByLabelText('Amount'), '8');
    await user.click(form.getByRole('button', { name: 'Save' }));
    // Shown straight away, before the server answers
    expect(await accountRow('Wallet', 'RM 92.00')).toBeTruthy();

    held.release();
    expect(await screen.findByText('Wallet is archived')).toBeTruthy();
    expect(await accountRow('Wallet', 'RM 100.00')).toBeTruthy();
    expect(server.transactions).toEqual([]);
  });

  test('keeps one added offline through a reload, and saves it once back', async () => {
    const server = withAccounts();
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();
    // The account's page was seen once, so its first page is kept on the device
    await user.click(await accountRow('Wallet', 'RM 100.00'));
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Home' }));
    await accountRow('Wallet', 'RM 100.00');

    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = await dialog();
    await user.type(form.getByLabelText('Amount'), '8');
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText(`${OFFLINE} 1 change waiting.`)).toBeTruthy();

    await reloadApp(server, '/', { size: 'phone' });
    expect(await accountRow('Wallet', 'RM 92.00')).toBeTruthy();
    // Its page shows it too, from what the device kept
    await user.click(await accountRow('Wallet', 'RM 92.00'));
    expect(await screen.findByRole('button', { name: 'Food, −RM 8.00' })).toBeTruthy();
    expect(server.transactions).toEqual([]);

    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
    expect(sentTransactions()).toHaveLength(1);
    expect(screen.getByLabelText('Balance RM 92.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Food, −RM 8.00' })).toBeTruthy();
  });
});

describe("an account's page", () => {
  test.each(SIZES)(
    'opens from Home with its transactions by day, newest first, and goes back (%s)',
    async (size) => {
      const server = withAccounts();
      seedTransaction(server, { date: '2026-10-13', payee: 'Kopi Corner', note: 'With Mei' });
      seedTransaction(server, {
        date: '2026-10-14',
        kind: 'income',
        amountCents: 5_000,
        categoryId: categoryId('Salary'),
      });
      seedTransaction(server, {
        date: '2026-10-14',
        categoryId: categoryId('Transport'),
        amountCents: 320,
      });
      seedTransaction(server, { accountId: BANK, amountCents: 999 });
      renderApp(server, '/', { size });
      const user = userEvent.setup();

      await user.click(await accountRow('Wallet', 'RM 138.80'));
      expect(await screen.findByRole('heading', { name: 'Wallet', level: 1 })).toBeTruthy();
      expect(screen.getByLabelText('Balance RM 138.80')).toBeTruthy();
      const days = within(screen.getByRole('region', { name: 'Transactions' })).getAllByRole(
        'list',
      );
      const read = (list: HTMLElement) =>
        within(list)
          .getAllByRole('button')
          .map((b) => b.getAttribute('aria-label'));
      expect(days.map((d) => d.getAttribute('aria-label'))).toEqual([
        expect.stringMatching(/14/),
        expect.stringMatching(/13/),
      ]);
      expect(read(days[0])).toEqual(['Transport, −RM 3.20', 'Salary, +RM 50.00']);
      expect(read(days[1])).toEqual(['Food, Kopi Corner · With Mei, −RM 8.00']);

      await user.click(screen.getByRole('button', { name: 'Home' }));
      expect(await accountRow('Bank', 'RM 490.01')).toBeTruthy();
    },
  );

  test('shows placeholders until the transactions arrive, never the empty state first', async () => {
    const server = withAccounts();
    const held = holdNext(server, 'GET', '/api/transactions');
    renderApp(server, `/?account=${WALLET}`);
    expect(await screen.findByText('Loading the transactions')).toBeTruthy();
    await screen.findByRole('heading', { name: 'Wallet', level: 1 });
    expect(screen.queryByText('Nothing here yet')).toBeNull();
    held.release();
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
    expect(screen.queryByText('Loading the transactions')).toBeNull();
  });

  test('loads older ones a page at a time', async () => {
    const server = withAccounts();
    for (let i = 0; i < 60; i++) seedTransaction(server, { amountCents: 100 + i });
    renderApp(server, `/?account=${WALLET}`);
    const user = userEvent.setup();
    const shown = () =>
      within(screen.getByRole('region', { name: 'Transactions' })).getAllByRole('listitem');

    await screen.findByRole('button', { name: 'Load more' });
    expect(shown()).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(shown()).toHaveLength(60));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
    // Newest first all the way down: the first seeded is last
    expect(shown().at(-1)?.textContent).toContain('RM 1.00');
  });

  test.each(SIZES)('edits one, the balance following (%s)', async (size) => {
    const server = withAccounts();
    seedTransaction(server);
    renderApp(server, `/?account=${WALLET}`, { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Food, −RM 8.00' }));
    const form = await dialog();
    expect(form.getByLabelText('Amount')).toHaveProperty('value', '8');
    expect(form.getByLabelText('Date')).toHaveProperty('value', '2026-10-14');
    await user.clear(form.getByLabelText('Amount'));
    await user.type(form.getByLabelText('Amount'), '12.40');
    await user.click(form.getByRole('radio', { name: 'Groceries' }));
    await user.click(form.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: 'Groceries, −RM 12.40' })).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 87.60')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions[0]).toMatchObject({
        amountCents: 1_240,
        categoryId: categoryId('Groceries'),
      }),
    );
  });

  test('turns spending into income, with an income category', async () => {
    const server = withAccounts();
    seedTransaction(server);
    renderApp(server, `/?account=${WALLET}`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Food, −RM 8.00' }));
    const form = await dialog();
    await user.click(form.getByRole('radio', { name: 'Received' }));
    await user.click(form.getByRole('radio', { name: 'Other income' }));
    await user.click(form.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: 'Other income, +RM 8.00' })).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 108.00')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions[0]).toMatchObject({
        kind: 'income',
        categoryId: categoryId('Other income'),
      }),
    );
  });

  test.each(SIZES)('deletes one, and Undo brings it back (%s)', async (size) => {
    const server = withAccounts();
    seedTransaction(server, { payee: 'Kopi Corner' });
    renderApp(server, `/?account=${WALLET}`, { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Food, Kopi Corner, −RM 8.00' }));
    await user.click((await dialog()).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 100.00')).toBeTruthy();
    await waitFor(() => expect(server.transactions).toEqual([]));

    expect(await screen.findByText('Deleted RM 8.00, Food')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await screen.findByRole('button', { name: 'Food, Kopi Corner, −RM 8.00' })).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 92.00')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({
          id: seeded.toString(16).padStart(16, 'd'),
          payee: 'Kopi Corner',
        }),
      ]),
    );
  });

  test('adds to this account from its own page', async () => {
    const server = withAccounts();
    renderApp(server, `/?account=${BANK}`);
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = await dialog();
    expect(form.getByLabelText('Account')).toHaveProperty('value', BANK);
    await user.type(form.getByLabelText('Amount'), '20');
    await user.click(form.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('button', { name: 'Food, −RM 20.00' })).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 480.00')).toBeTruthy();
  });

  test('an archived account offers no Add, and its Edit can bring it back', async () => {
    const server = withAccounts();
    server.accounts[0].archived = true;
    renderApp(server, `/?account=${WALLET}`);
    const user = userEvent.setup();

    expect(await screen.findByText('Cash, archived')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    await user.click((await dialog()).getByRole('button', { name: 'Bring back' }));
    expect(await screen.findByRole('button', { name: 'Add' })).toBeTruthy();
  });
});

describe('moving money between accounts', () => {
  const TNG = 'c'.repeat(16);
  const VISA = 'f'.repeat(16);

  /** RM 1,000 in the Bank, an empty TNG e-wallet, and RM 500 owed on a Visa card */
  function withTransferAccounts() {
    const server = fakeServer();
    seedAccount(server, { id: BANK, name: 'Bank', kind: 'bank', openingCents: 100_000 });
    seedAccount(server, { id: TNG, name: 'TNG', kind: 'ewallet' });
    seedAccount(server, { id: VISA, name: 'Visa', kind: 'card', openingCents: -50_000 });
    return server;
  }

  /** Adds a transfer from Home: the amount, Transfer, then From and To */
  async function addTransfer(amount: string, from: string, to: string) {
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = await dialog();
    await user.type(form.getByLabelText('Amount'), amount);
    await user.click(form.getByRole('radio', { name: 'Transfer' }));
    // No category: it's neither spending nor income
    expect(form.queryByRole('radiogroup', { name: 'Category' })).toBeNull();
    await user.selectOptions(form.getByLabelText('From'), from);
    await user.selectOptions(form.getByLabelText('To'), to);
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  }

  /** A transfer the server has before the app opens: RM 100 from the Bank to TNG */
  const seedTopUp = (server: FakeServer) =>
    seedTransaction(server, {
      kind: 'transfer',
      accountId: BANK,
      toAccountId: TNG,
      amountCents: 10_000,
      categoryId: null,
    });

  test.each(SIZES)(
    'tops up an e-wallet by RM 100 from the bank, then spends RM 30 from it (%s)',
    async (size) => {
      const server = withTransferAccounts();
      renderApp(server, '/', { size });
      const user = userEvent.setup();

      await addTransfer('100', 'Bank', 'TNG');
      expect(await accountRow('TNG', 'RM 100.00')).toBeTruthy();
      expect(await accountRow('Bank', 'RM 900.00')).toBeTruthy();

      await user.click(await screen.findByRole('button', { name: 'Add' }));
      const form = await dialog();
      await user.type(form.getByLabelText('Amount'), '30');
      await user.selectOptions(form.getByLabelText('Account'), 'TNG');
      await user.click(form.getByRole('button', { name: 'Save' }));

      expect(await accountRow('TNG', 'RM 70.00')).toBeTruthy();
      expect(await accountRow('Bank', 'RM 900.00')).toBeTruthy();
      await waitFor(() =>
        expect(server.transactions).toEqual([
          expect.objectContaining({
            kind: 'transfer',
            accountId: BANK,
            toAccountId: TNG,
            amountCents: 10_000,
            categoryId: null,
          }),
          expect.objectContaining({ kind: 'expense', accountId: TNG, amountCents: 3_000 }),
        ]),
      );

      // Each account's page shows it from its own side
      await user.click(await accountRow('TNG', 'RM 70.00'));
      expect(await screen.findByRole('button', { name: 'From Bank, +RM 100.00' })).toBeTruthy();
      expect(screen.getByRole('button', { name: 'Food, −RM 30.00' })).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Home' }));
      await user.click(await accountRow('Bank', 'RM 900.00'));
      expect(await screen.findByRole('button', { name: 'To TNG, −RM 100.00' })).toBeTruthy();
    },
  );

  test('pays the card from the bank, lowering what is owed on it', async () => {
    const server = withTransferAccounts();
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();

    await addTransfer('200', 'Bank', 'Visa');
    expect(await accountRow('Visa', 'RM 300.00 owed')).toBeTruthy();
    expect(await accountRow('Bank', 'RM 800.00')).toBeTruthy();
    await user.click(await accountRow('Visa', 'RM 300.00 owed'));
    expect(await screen.findByRole('button', { name: 'From Bank, +RM 200.00' })).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({ accountId: BANK, toAccountId: VISA, amountCents: 20_000 }),
      ]),
    );
  });

  test('offers the account moved to last, never the one it comes from', async () => {
    const server = withTransferAccounts();
    renderApp(server);
    const user = userEvent.setup();

    await addTransfer('50', 'Bank', 'Visa');
    await user.click(await screen.findByRole('button', { name: 'Add' }));
    const form = await dialog();
    await user.click(form.getByRole('radio', { name: 'Transfer' }));
    expect(form.getByLabelText('To')).toHaveProperty('value', VISA);
    // From the Visa itself, it goes somewhere else, and the Visa isn't offered
    await user.selectOptions(form.getByLabelText('From'), 'Visa');
    const to = form.getByLabelText('To');
    expect(to).toHaveProperty('value', BANK);
    expect(within(to).queryByRole('option', { name: 'Visa' })).toBeNull();
  });

  test.each(SIZES)("edits a transfer's amount, both balances following (%s)", async (size) => {
    const server = withTransferAccounts();
    seedTopUp(server);
    renderApp(server, `/?account=${BANK}`, { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'To TNG, −RM 100.00' }));
    const form = await dialog();
    expect(form.getByRole('radio', { name: 'Transfer' })).toHaveProperty('checked', true);
    expect(form.getByLabelText('From')).toHaveProperty('value', BANK);
    expect(form.getByLabelText('To')).toHaveProperty('value', TNG);
    await user.clear(form.getByLabelText('Amount'));
    await user.type(form.getByLabelText('Amount'), '150');
    await user.click(form.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('button', { name: 'To TNG, −RM 150.00' })).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 850.00')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Home' }));
    expect(await accountRow('TNG', 'RM 150.00')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({ kind: 'transfer', toAccountId: TNG, amountCents: 15_000 }),
      ]),
    );
  });

  test.each(SIZES)(
    'deletes a transfer, and Undo brings it back on both accounts (%s)',
    async (size) => {
      const server = withTransferAccounts();
      seedTopUp(server);
      const id = server.transactions[0].id;
      renderApp(server, `/?account=${TNG}`, { size });
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'From Bank, +RM 100.00' }));
      await user.click((await dialog()).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByText('Nothing here yet')).toBeTruthy();
      expect(screen.getByLabelText('Balance RM 0.00')).toBeTruthy();
      await waitFor(() => expect(server.transactions).toEqual([]));

      expect(await screen.findByText('Deleted RM 100.00, Bank to TNG')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await screen.findByRole('button', { name: 'From Bank, +RM 100.00' })).toBeTruthy();
      expect(screen.getByLabelText('Balance RM 100.00')).toBeTruthy();
      await waitFor(() =>
        expect(server.transactions).toEqual([
          expect.objectContaining({ id, accountId: BANK, toAccountId: TNG, amountCents: 10_000 }),
        ]),
      );
      await user.click(screen.getByRole('button', { name: 'Home' }));
      expect(await accountRow('Bank', 'RM 900.00')).toBeTruthy();
    },
  );

  test('keeps a transfer made offline through a reload, and saves it once back', async () => {
    const server = withTransferAccounts();
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();
    // The e-wallet's page was seen once, so its first page is kept on the device
    await user.click(await accountRow('TNG', 'RM 0.00'));
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Home' }));
    await accountRow('TNG', 'RM 0.00');

    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));
    await addTransfer('100', 'Bank', 'TNG');
    expect(await screen.findByText(`${OFFLINE} 1 change waiting.`)).toBeTruthy();

    await reloadApp(server, '/', { size: 'phone' });
    expect(await accountRow('Bank', 'RM 900.00')).toBeTruthy();
    // The e-wallet's page shows it coming in, from what the device kept
    await user.click(await accountRow('TNG', 'RM 100.00'));
    expect(await screen.findByRole('button', { name: 'From Bank, +RM 100.00' })).toBeTruthy();
    expect(server.transactions).toEqual([]);

    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
    expect(sentTransactions()).toHaveLength(1);
    expect(screen.getByLabelText('Balance RM 100.00')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'From Bank, +RM 100.00' })).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Home' }));
    expect(await accountRow('Bank', 'RM 900.00')).toBeTruthy();
  });
});
