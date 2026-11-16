// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Account, ChangesBody, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../../testing/app';
import {
  OFFLINE_NOTICE,
  addButton,
  addEntry,
  addForm,
  fakeServer,
  holdNext,
  queryAddButton,
  reloadApp,
  renderApp,
  setupAppTests,
} from '../../testing/app';

// Adding what was spent or received from the entry sheet, and changing or deleting it
// from an account's page: shown at once, the balances with it, and saved.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const WALLET = 'a'.repeat(16);
const BANK = 'b'.repeat(16);
const OFFLINE = OFFLINE_NOTICE.phone;
const ONE_WAITING = 'Offline · 1 change waiting to save';
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

/**
 * An account's row, read out with its balance: on Home ("RM 100.00"), or on Accounts, where
 * a list drops the RM ("100.00")
 */
const accountRow = (name: string, balance: string) =>
  waitFor(() => {
    const found =
      screen.queryByRole('button', { name: new RegExp(`^${name}, [\\w-]+, ${balance}$`) }) ??
      screen.queryByRole('link', {
        name: new RegExp(`^${name}, [\\w-]+, ${balance.replace(/^RM /, '')}$`),
      });
    expect(found).not.toBeNull();
    return found!;
  });

/** Back up to Accounts from an account's page; on a computer the list is beside it already */
async function upToAccounts() {
  const back = screen.queryByRole('button', { name: 'Accounts' });
  if (back != null) await userEvent.setup().click(back);
}

/**
 * An entry on an account's page, by its row's name (title, subtitle, amount): the row on a
 * phone or tablet; on a computer, its payee in the register, on a row that reads the same
 */
const entry = (name: string) =>
  waitFor(() => {
    const row = screen.queryByRole('button', { name });
    if (row != null) return row;
    const [title, subtitle, amount] = name.split(', ');
    const found = within(screen.getByRole('table', { name: 'Transactions' }))
      .getAllByRole('button', { name: title })
      .find((b) => b.closest('tr')?.textContent?.includes(`${title}${subtitle}${amount}`));
    expect(found).toBeTruthy();
    return found!;
  });

const dialog = async () => within(await screen.findByRole('dialog'));

/** The transaction changes each save carried, in order */
const sentTransactions = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .flatMap(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes)
    .filter((c) => c.op.endsWith('Transaction'));

describe('adding from Home', () => {
  test('has no Add until there is an account to put it on', async () => {
    const server = fakeServer();
    renderApp(server, '/?plan');
    expect(await screen.findByText('Add your first account')).toBeTruthy();
    expect(queryAddButton()).toBeNull();
  });

  test('keeps one added offline through a reload, and saves it once back', async () => {
    const server = withAccounts();
    renderApp(server, '/?plan', { size: 'phone' });
    const user = userEvent.setup();
    // The account's page was seen once, so its first page is kept on the device
    await user.click(await accountRow('Wallet', 'RM 100.00'));
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
    await upToAccounts();
    await accountRow('Wallet', 'RM 100.00');

    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));
    await addEntry('8');
    expect(await screen.findByText(OFFLINE)).toBeTruthy();
    expect(await screen.findByText(ONE_WAITING)).toBeTruthy();

    await reloadApp(server, '/?plan', { size: 'phone' });
    expect(await accountRow('Wallet', 'RM 92.00')).toBeTruthy();
    // Its page shows it too, from what the device kept
    await user.click(await accountRow('Wallet', 'RM 92.00'));
    expect(await entry('Food, Food, −8.00')).toBeTruthy();
    expect(server.transactions).toEqual([]);

    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
    expect(sentTransactions()).toHaveLength(1);
    expect(screen.getByLabelText('Balance RM 92.00')).toBeTruthy();
    expect(await entry('Food, Food, −8.00')).toBeTruthy();
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
      renderApp(server, '/?plan', { size });
      const user = userEvent.setup();

      await user.click(await accountRow('Wallet', 'RM 138.80'));
      expect(
        await screen.findByRole('heading', { name: 'Wallet', level: size === 'desktop' ? 2 : 1 }),
      ).toBeTruthy();
      expect(screen.getByLabelText('Balance RM 138.80')).toBeTruthy();
      if (size === 'desktop') {
        // The register, newest first: day, payee or transfer, category, amount
        const rows = within(screen.getByRole('table', { name: 'Transactions' }))
          .getAllByRole('row')
          .slice(1)
          .map((r) =>
            within(r)
              .getAllByRole('cell')
              .slice(0, 4)
              .map((c) => c.textContent),
          );
        expect(rows).toEqual([
          [expect.stringMatching(/14/), 'Transport', 'Transport', '−3.20'],
          [expect.stringMatching(/14/), 'Salary', 'Salary', '+50.00'],
          [expect.stringMatching(/13/), 'Kopi Corner', 'Food · With Mei', '−8.00'],
        ]);
      } else {
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
        expect(read(days[0])).toEqual(['Transport, Transport, −3.20', 'Salary, Salary, +50.00']);
        expect(read(days[1])).toEqual(['Kopi Corner, Food · With Mei, −8.00']);
      }

      await upToAccounts();
      expect(await accountRow('Bank', 'RM 490.01')).toBeTruthy();
    },
  );

  test('shows placeholders until the transactions arrive, never the empty state first', async () => {
    const server = withAccounts();
    const held = holdNext(server, 'GET', '/api/transactions');
    renderApp(server, `/?account=${WALLET}`);
    expect(await screen.findByText('Loading the transactions')).toBeTruthy();
    // Beside the list on a computer
    await screen.findByRole('heading', { name: 'Wallet', level: 2 });
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
    // The register's rows, on a computer
    const shown = () =>
      within(screen.getByRole('table', { name: 'Transactions' }))
        .getAllByRole('row')
        .slice(1);

    await screen.findByRole('button', { name: 'Show 50 more' });
    expect(shown()).toHaveLength(50);
    await user.click(screen.getByRole('button', { name: 'Show 50 more' }));
    await waitFor(() => expect(shown()).toHaveLength(60));
    expect(screen.queryByRole('button', { name: 'Show 50 more' })).toBeNull();
    // Newest first all the way down: the first seeded is last
    expect(shown().at(-1)?.textContent).toContain('−1.00');
  });

  test.each(SIZES)('edits one, the balance following (%s)', async (size) => {
    const server = withAccounts();
    seedTransaction(server);
    renderApp(server, `/?account=${WALLET}`, { size });
    const user = userEvent.setup();

    await user.click(await entry('Food, Food, −8.00'));
    const form = await dialog();
    expect(form.getByLabelText('Amount')).toHaveProperty('value', '8');
    expect(form.getByLabelText('Date')).toHaveProperty('value', '2026-10-14');
    await user.clear(form.getByLabelText('Amount'));
    await user.type(form.getByLabelText('Amount'), '12.40');
    await user.click(form.getByRole('radio', { name: 'Groceries' }));
    await user.click(form.getByRole('button', { name: 'Save' }));

    expect(await entry('Groceries, Groceries, −12.40')).toBeTruthy();
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

    await user.click(await entry('Food, Food, −8.00'));
    const form = await dialog();
    await user.click(form.getByRole('radio', { name: 'Received' }));
    await user.click(form.getByRole('radio', { name: 'Other income' }));
    await user.click(form.getByRole('button', { name: 'Save' }));

    expect(await entry('Other income, Other income, +8.00')).toBeTruthy();
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

    await user.click(await entry('Kopi Corner, Food, −8.00'));
    await user.click((await dialog()).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 100.00')).toBeTruthy();
    await waitFor(() => expect(server.transactions).toEqual([]));

    expect(await screen.findByText('Deleted RM 8.00, Food')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(await entry('Kopi Corner, Food, −8.00')).toBeTruthy();
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

    await addEntry('20', (form) => {
      expect(form.getByRole('button', { name: /^From Bank/ })).toBeTruthy();
      return Promise.resolve();
    });
    expect(await entry('Food, Food, −20.00')).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 480.00')).toBeTruthy();
  });

  // A changed rule: the archived account's page used to offer no Add. The tab bar and
  // sidebar keep Add on every page (R-Account-Archived), opening on an account in use.
  test("an archived account's page keeps Add, on an account in use, until it is unarchived", async () => {
    const server = withAccounts();
    server.accounts[0].archived = true;
    renderApp(server, `/?account=${WALLET}`);
    const user = userEvent.setup();

    expect((await screen.findAllByText('Cash · archived')).length).toBeGreaterThan(0);
    await user.click(await addButton());
    expect((await addForm()).getByRole('button', { name: /^From Bank/ })).toBeTruthy();
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    // Unarchive, on the page (R-Desk-Accounts-Archived)
    await user.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(await screen.findByRole('button', { name: 'Add here' })).toBeTruthy();
    expect(screen.queryByText('Cash · archived')).toBeNull();
    await user.click(await addButton());
    expect((await addForm()).getByRole('button', { name: /^From Wallet/ })).toBeTruthy();
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

  /** Adds a transfer with Add: Transfer, then From and To, then the amount */
  async function addTransfer(amount: string, from: string, to: string) {
    const user = userEvent.setup();
    await addEntry(amount, async (form) => {
      await user.click(form.getByRole('radio', { name: 'Transfer' }));
      // No category: it's neither spending nor income
      expect(form.queryByRole('radiogroup', { name: 'Recent categories' })).toBeNull();
      await user.click(form.getByRole('button', { name: /^From / }));
      await user.click(await screen.findByRole('radio', { name: new RegExp(`^${from} `) }));
      await user.click(form.getByRole('button', { name: /^To / }));
      await user.click(await screen.findByRole('radio', { name: new RegExp(`^${to} `) }));
    });
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
      renderApp(server, '/?plan', { size });
      const user = userEvent.setup();

      await addTransfer('100', 'Bank', 'TNG');
      expect(await accountRow('TNG', 'RM 100.00')).toBeTruthy();
      expect(await accountRow('Bank', 'RM 900.00')).toBeTruthy();

      await addEntry('30', async (form) => {
        await user.click(form.getByRole('button', { name: /^From / }));
        await user.click(await screen.findByRole('radio', { name: /^TNG / }));
      });

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
      expect(await entry('From Bank, Transfer, +100.00')).toBeTruthy();
      expect(await entry('Food, Food, −30.00')).toBeTruthy();
      await upToAccounts();
      await user.click(await accountRow('Bank', 'RM 900.00'));
      expect(await entry('To TNG, Transfer, −100.00')).toBeTruthy();
    },
  );

  test('pays the card from the bank, lowering what is owed on it', async () => {
    const server = withTransferAccounts();
    renderApp(server, '/?plan', { size: 'phone' });
    const user = userEvent.setup();

    await addTransfer('200', 'Bank', 'Visa');
    expect(await accountRow('Visa', 'RM 300.00 owed')).toBeTruthy();
    expect(await accountRow('Bank', 'RM 800.00')).toBeTruthy();
    await user.click(await accountRow('Visa', 'RM 300.00 owed'));
    expect(await entry('From Bank, Transfer, +200.00')).toBeTruthy();
    await waitFor(() =>
      expect(server.transactions).toEqual([
        expect.objectContaining({ accountId: BANK, toAccountId: VISA, amountCents: 20_000 }),
      ]),
    );
  });

  test.each(SIZES)("edits a transfer's amount, both balances following (%s)", async (size) => {
    const server = withTransferAccounts();
    seedTopUp(server);
    renderApp(server, `/?account=${BANK}`, { size });
    const user = userEvent.setup();

    await user.click(await entry('To TNG, Transfer, −100.00'));
    const form = await dialog();
    expect(form.getByRole('radio', { name: 'Transfer' })).toHaveProperty('checked', true);
    expect(form.getByLabelText('From')).toHaveProperty('value', BANK);
    expect(form.getByLabelText('To')).toHaveProperty('value', TNG);
    await user.clear(form.getByLabelText('Amount'));
    await user.type(form.getByLabelText('Amount'), '150');
    await user.click(form.getByRole('button', { name: 'Save' }));

    expect(await entry('To TNG, Transfer, −150.00')).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 850.00')).toBeTruthy();
    await upToAccounts();
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

      await user.click(await entry('From Bank, Transfer, +100.00'));
      await user.click((await dialog()).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByText('Nothing here yet')).toBeTruthy();
      expect(screen.getByLabelText('Balance RM 0.00')).toBeTruthy();
      await waitFor(() => expect(server.transactions).toEqual([]));

      expect(await screen.findByText('Deleted RM 100.00, Bank to TNG')).toBeTruthy();
      await user.click(screen.getByRole('button', { name: 'Undo' }));
      expect(await entry('From Bank, Transfer, +100.00')).toBeTruthy();
      expect(screen.getByLabelText('Balance RM 100.00')).toBeTruthy();
      await waitFor(() =>
        expect(server.transactions).toEqual([
          expect.objectContaining({ id, accountId: BANK, toAccountId: TNG, amountCents: 10_000 }),
        ]),
      );
      await upToAccounts();
      expect(await accountRow('Bank', 'RM 900.00')).toBeTruthy();
    },
  );

  test('keeps a transfer made offline through a reload, and saves it once back', async () => {
    const server = withTransferAccounts();
    renderApp(server, '/?plan', { size: 'phone' });
    const user = userEvent.setup();
    // The e-wallet's page was seen once, so its first page is kept on the device
    await user.click(await accountRow('TNG', 'RM 0.00'));
    expect(await screen.findByText('Nothing here yet')).toBeTruthy();
    await upToAccounts();
    await accountRow('TNG', 'RM 0.00');

    server.health = 'unreachable';
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => onLine.mockRestore());
    act(() => void window.dispatchEvent(new Event('offline')));
    await addTransfer('100', 'Bank', 'TNG');
    expect(await screen.findByText(OFFLINE)).toBeTruthy();
    expect(await screen.findByText(ONE_WAITING)).toBeTruthy();

    await reloadApp(server, '/?plan', { size: 'phone' });
    expect(await accountRow('Bank', 'RM 900.00')).toBeTruthy();
    // The e-wallet's page shows it coming in, from what the device kept
    await user.click(await accountRow('TNG', 'RM 100.00'));
    expect(await entry('From Bank, Transfer, +100.00')).toBeTruthy();
    expect(server.transactions).toEqual([]);

    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
    await waitFor(() => expect(server.transactions).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText(/changes? waiting/)).toBeNull());
    expect(sentTransactions()).toHaveLength(1);
    expect(screen.getByLabelText('Balance RM 100.00')).toBeTruthy();
    expect(await entry('From Bank, Transfer, +100.00')).toBeTruthy();
    await upToAccounts();
    expect(await accountRow('Bank', 'RM 900.00')).toBeTruthy();
  });
});
