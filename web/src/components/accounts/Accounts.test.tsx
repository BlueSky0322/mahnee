// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Account } from '@shared/api';
import type { FakeServer } from '../../testing/app';
import { RETRY_DELAY_MS } from '../../ledger/save-queue';
import { fakeServer, holdNext, renderApp, setupAppTests } from '../../testing/app';

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;

/** An account the server has before the app opens */
function seed(server: FakeServer, account: Partial<Account> & Pick<Account, 'id' | 'name'>) {
  server.accounts.push({
    kind: 'cash',
    currency: 'MYR',
    openingCents: 0,
    position: server.accounts.length,
    archived: false,
    ...account,
  });
}

/** The account's row in today's list (on Plan until it's rebuilt), found by its name */
const homeRow = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name},`) });

/** The account's row on Accounts (?accounts), found by its name */
const row = (name: string) => screen.findByRole('link', { name: new RegExp(`^${name},`) });

const dialog = () => screen.findByRole('dialog');

/** Opens an account's Edit form: from its row on Home or Accounts, on its page or beside the list */
async function edit(name: string, from: 'home' | 'accounts' = 'accounts') {
  const user = userEvent.setup();
  await user.click(await (from === 'home' ? homeRow(name) : row(name)));
  await user.click(await screen.findByRole('button', { name: 'Edit' }));
  return within(await dialog());
}

/**
 * Back up to Accounts from an account's page, once its form has closed; on a computer the
 * list is beside it already
 */
async function backToAccounts() {
  const user = userEvent.setup();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  const back = screen.queryByRole('button', { name: 'Accounts' });
  if (back != null) await user.click(back);
}

/** How many times the app has sent changes to the server */
const saves = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST').length;

/** Waits for an account's row in today's list (Plan) to show this kind and balance */
async function showsOnHome(name: string, kind: string, balance: string) {
  const found = await screen.findByRole('button', { name: `${name}, ${kind}, ${balance}` });
  expect(within(found).getByText(balance)).toBeTruthy();
}

/** Waits for an account's row on Accounts to show this kind and balance, read out and drawn */
async function shows(name: string, kind: string, balance: string) {
  const found = await screen.findByRole('link', { name: `${name}, ${kind}, ${balance}` });
  expect(found.textContent).toContain(balance.replace(/ owed$/, ''));
}

/** The accounts a group on Accounts lists, read out */
const listed = async (group: string) =>
  within(await screen.findByRole('region', { name: group }))
    .getAllByRole('link')
    .map((a) => a.getAttribute('aria-label'));

describe('accounts', () => {
  test.each(SIZES)('adds the first account and shows its balance (%s)', async (size) => {
    const server = fakeServer();
    renderApp(server, '/?plan', { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = within(await dialog());
    await user.type(form.getByLabelText('Name'), '  Wallet ');
    await user.type(form.getByLabelText('Opening balance'), '1,250.5');
    await user.click(form.getByRole('button', { name: 'Add account' }));

    await showsOnHome('Wallet', 'Cash', 'RM 1,250.50');
    await waitFor(() =>
      expect(server.accounts).toEqual([
        expect.objectContaining({ name: 'Wallet', kind: 'cash', openingCents: 125_050 }),
      ]),
    );
    expect(screen.queryByText('Add your first account')).toBeNull();
  });

  test('shows placeholders until the accounts arrive, never the empty list first', async () => {
    const server = fakeServer();
    const held = holdNext(server, 'GET', '/api/accounts');
    renderApp(server, '/?plan', { size: 'phone' });
    expect(await screen.findByText('Loading your accounts')).toBeTruthy();
    // Long enough for anything else to have loaded (who's signed in)
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(screen.queryByText('Add your first account')).toBeNull();

    held.release();
    expect(await screen.findByText('Add your first account')).toBeTruthy();
    expect(screen.queryByText('Loading your accounts')).toBeNull();
  });

  test.each(SIZES)("shows what's owed on a card (%s)", async (size) => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?plan', { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = within(await dialog());
    await user.click(form.getByRole('radio', { name: 'Card' }));
    await user.type(form.getByLabelText('Name'), 'Visa');
    await user.type(form.getByLabelText('Amount owed'), '120');
    await user.click(form.getByRole('button', { name: 'Add account' }));

    await showsOnHome('Visa', 'Card', 'RM 120.00 owed');
    await waitFor(() =>
      expect(server.accounts[1]).toMatchObject({
        name: 'Visa',
        kind: 'card',
        openingCents: -12_000,
      }),
    );
    // Opened again, it's still the amount owed, as typed
    expect((await edit('Visa', 'home')).getByLabelText('Amount owed')).toHaveProperty(
      'value',
      '120',
    );
  });

  test('lists accounts in their order, an overdrawn one below zero', async () => {
    const server = fakeServer();
    seed(server, {
      id: 'b'.repeat(16),
      name: 'Bank',
      kind: 'bank',
      position: 1,
      openingCents: -5_000,
    });
    seed(server, { id: 'a'.repeat(16), name: 'Wallet', position: 0, openingCents: 2_000 });
    renderApp(server, '/?accounts');
    expect(await listed('Cash, banks and e-wallets')).toEqual([
      'Wallet, Cash, 20.00',
      'Bank, Bank, −50.00',
    ]);
  });

  test.each(SIZES)('renames an account and changes its opening balance (%s)', async (size) => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet', openingCents: 2_000 });
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();

    const form = await edit('Wallet');
    expect(form.getByLabelText('Opening balance')).toHaveProperty('value', '20');
    // The kind is fixed once added
    expect(form.queryByRole('radio')).toBeNull();
    await user.clear(form.getByLabelText('Name'));
    await user.type(form.getByLabelText('Name'), 'Purse');
    await user.clear(form.getByLabelText('Opening balance'));
    await user.type(form.getByLabelText('Opening balance'), '35.20');
    await user.click(form.getByRole('button', { name: 'Save' }));

    // The account's page (beside the list on a computer) shows it at once, and so does the list
    expect(
      await screen.findByRole('heading', { name: 'Purse', level: size === 'phone' ? 1 : 2 }),
    ).toBeTruthy();
    expect(screen.getByLabelText('Balance RM 35.20')).toBeTruthy();
    await backToAccounts();
    await shows('Purse', 'Cash', '35.20');
    await waitFor(() =>
      expect(server.accounts[0]).toMatchObject({ name: 'Purse', openingCents: 3_520 }),
    );
  });

  test('says what is wrong with a name or amount, and saves nothing', async () => {
    const server = fakeServer();
    renderApp(server, '/?plan');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = within(await dialog());
    await user.type(form.getByLabelText('Opening balance'), '12abc');
    await user.click(form.getByRole('button', { name: 'Add account' }));
    expect(form.getByText('Give it a name')).toBeTruthy();
    expect(form.getByText('Enter an amount, like 120.50')).toBeTruthy();

    await user.type(form.getByLabelText('Name'), 'Rich');
    await user.clear(form.getByLabelText('Opening balance'));
    await user.type(form.getByLabelText('Opening balance'), '10000000.01');
    await user.click(form.getByRole('button', { name: 'Add account' }));
    expect(form.getByText('Up to 10,000,000 either way')).toBeTruthy();
    expect(server.accounts).toEqual([]);
  });

  test.each(SIZES)('archives an account, and Undo brings it back (%s)', async (size) => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    seed(server, { id: 'b'.repeat(16), name: 'Bank', kind: 'bank' });
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();

    await user.click((await edit('Wallet')).getByRole('button', { name: 'Archive' }));
    expect((await screen.findAllByText(/^Cash · archived /)).length).toBeGreaterThan(0);
    await backToAccounts();
    await waitFor(async () =>
      expect(await listed('Cash, banks and e-wallets')).toEqual(['Bank, Bank, 0.00']),
    );
    await waitFor(() => expect(server.accounts[0].archived).toBe(true));

    expect(await screen.findByText('Archived Wallet')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await waitFor(async () =>
      expect(await listed('Cash, banks and e-wallets')).toEqual([
        'Wallet, Cash, 0.00',
        'Bank, Bank, 0.00',
      ]),
    );
    await waitFor(() => expect(server.accounts[0].archived).toBe(false));
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
  });

  test('an archived account is listed apart, and Unarchive on its page brings it back', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    seed(server, { id: 'b'.repeat(16), name: 'Old card', kind: 'card', archived: true });
    renderApp(server, '/?accounts');
    const user = userEvent.setup();

    await row('Wallet');
    expect(screen.queryByRole('link', { name: /^Old card,/ })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Archived · 1' }));
    await user.click(await row('Old card'));
    await user.click(await screen.findByRole('button', { name: 'Unarchive' }));

    await waitFor(() =>
      expect(server.accounts[1]).toMatchObject({ archived: false, archivedAt: null }),
    );
    await backToAccounts();
    expect(screen.queryByRole('button', { name: /^Archived/ })).toBeNull();
    expect(await listed('Cash, banks and e-wallets')).toEqual(['Wallet, Cash, 0.00']);
    expect(await listed('Cards')).toEqual(['Old card, Card, 0.00 owed']);
  });

  test.each(SIZES)(
    "puts a refused change back, with the server's explanation (%s)",
    async (size) => {
      const server = fakeServer();
      seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
      server.failNext.changes = { status: 409, error: 'Changed somewhere else at the same time.' };
      const held = holdNext(server, 'POST', '/api/changes');
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();

      const form = await edit('Wallet');
      await user.clear(form.getByLabelText('Name'));
      await user.type(form.getByLabelText('Name'), 'Purse');
      await user.click(form.getByRole('button', { name: 'Save' }));
      await backToAccounts();
      // Shown straight away, before the server answers
      expect(await row('Purse')).toBeTruthy();

      held.release();
      expect(await screen.findByText('Changed somewhere else at the same time.')).toBeTruthy();
      expect(await row('Wallet')).toBeTruthy();
      expect(screen.queryByRole('link', { name: /^Purse,/ })).toBeNull();
      expect(server.accounts[0].name).toBe('Wallet');
    },
  );

  test('keeps a change while the server is failing, and saves it once it is back', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });

    await user.click(await row('Wallet'));
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    const form = within(await dialog());
    await user.clear(form.getByLabelText('Name'));
    await user.type(form.getByLabelText('Name'), 'Purse');
    server.health = 'down';
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saves()).toBe(1));
    await user.click(screen.getByRole('button', { name: 'Accounts' }));

    // Not the change's fault: it stays, and nothing says it was refused
    expect(await row('Purse')).toBeTruthy();
    expect(screen.queryByText('Internal error')).toBeNull();
    server.health = 'up';
    await act(() => vi.advanceTimersByTimeAsync(RETRY_DELAY_MS));
    await waitFor(() => expect(server.accounts[0].name).toBe('Purse'));
    expect(saves()).toBe(2);
    expect(await row('Purse')).toBeTruthy();
  });

  test('drops what was made after a refused change, and shows what the server has', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    server.failNext.changes = { status: 404, error: 'Account not found' };
    const held = holdNext(server, 'POST', '/api/changes');
    renderApp(server, '/?accounts');
    const user = userEvent.setup();

    // A rename, then an account added while it's still being sent
    let form = await edit('Wallet');
    await user.clear(form.getByLabelText('Name'));
    await user.type(form.getByLabelText('Name'), 'Purse');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await backToAccounts();
    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    form = within(await dialog());
    await user.type(form.getByLabelText('Name'), 'Bank');
    await user.click(form.getByRole('button', { name: 'Add account' }));
    expect(await row('Bank')).toBeTruthy();

    held.release();
    expect(await screen.findByText('Account not found')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Bank,/ })).toBeNull());
    expect(await row('Wallet')).toBeTruthy();
    expect(server.accounts.map((a) => a.name)).toEqual(['Wallet']);
  });

  test('a fresh copy answered out of order never shows an older name', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    const user = userEvent.setup();
    const renameTo = async (from: string, to: string) => {
      const form = await edit(from);
      await user.clear(form.getByLabelText('Name'));
      await user.type(form.getByLabelText('Name'), to);
      await user.click(form.getByRole('button', { name: 'Save' }));
      await backToAccounts();
    };

    await row('Wallet');
    // The copy fetched once the first rename is saved is held back: it has "Purse"
    const fresh = holdNext(server, 'GET', '/api/accounts');
    await renameTo('Wallet', 'Purse');
    await waitFor(() => expect(server.accounts[0].name).toBe('Purse'));
    // A second rename, still being sent when that copy arrives
    const saving = holdNext(server, 'POST', '/api/changes');
    await renameTo('Purse', 'Pouch');
    fresh.release();
    await new Promise((r) => setTimeout(r, 50));
    await shows('Pouch', 'Cash', '0.00');

    // (The server saved it when it arrived; only its answer was held back)
    expect(server.accounts[0].name).toBe('Pouch');
    saving.release();
    await new Promise((r) => setTimeout(r, 50));
    await shows('Pouch', 'Cash', '0.00');
    expect(screen.queryByRole('link', { name: /^Purse,/ })).toBeNull();
  });
});
