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

/** The account's row on Accounts (?accounts), found by its name */
const row = (name: string) => screen.findByRole('link', { name: new RegExp(`^${name},`) });

const dialog = () => screen.findByRole('dialog');

/** Opens an account's Edit form: from its row on Accounts, on its page or beside the list */
async function edit(name: string) {
  const user = userEvent.setup();
  // Any sheet before it (Add account) closed first, so the one found is Edit's
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await user.click(await row(name));
  // Its page, or beside the list on a computer, in place of the one open before
  await screen.findByRole('heading', { name });
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
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = within(await dialog());
    await user.type(form.getByLabelText('Name'), '  Wallet ');
    await user.type(form.getByLabelText('Opening balance'), '1,250.5');
    await user.click(form.getByRole('button', { name: 'Add account' }));

    await shows('Wallet', 'Cash', '1,250.50');
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
    renderApp(server, '/?accounts', { size: 'phone' });
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
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = within(await dialog());
    await user.click(form.getByRole('radio', { name: 'Card' }));
    await user.type(form.getByLabelText('Name'), 'Visa');
    await user.type(form.getByLabelText('Amount owed'), '120');
    await user.click(form.getByRole('button', { name: 'Add account' }));

    await shows('Visa', 'Card', '120.00 owed');
    await waitFor(() =>
      expect(server.accounts[1]).toMatchObject({
        name: 'Visa',
        kind: 'card',
        openingCents: -12_000,
      }),
    );
    // Opened again, it's still the amount owed, as typed
    expect((await edit('Visa')).getByLabelText('Amount owed')).toHaveProperty('value', '120');
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
    // Its kind as it is, ready to change
    expect(form.getByRole('radio', { name: 'Cash' })).toHaveProperty('checked', true);
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

  test.each(SIZES)(
    'changes a card to a bank account, showing the balance it will have first (%s)',
    async (size) => {
      const server = fakeServer();
      seed(server, { id: 'a'.repeat(16), name: 'Visa', kind: 'card', openingCents: -50_000 });
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();

      const form = await edit('Visa');
      expect(form.getByRole('radio', { name: 'Card' })).toHaveProperty('checked', true);
      expect(form.queryByText(/will read/)).toBeNull();
      await user.click(form.getByRole('radio', { name: 'Bank' }));
      // The same cents kept: what was owed reads below zero on a bank account
      expect(form.getByLabelText('Opening balance')).toHaveProperty('value', '-500');
      expect(form.getByText('RM 500.00 owed will read −RM 500.00 as a bank account')).toBeTruthy();
      // Corrected in the same save
      await user.clear(form.getByLabelText('Opening balance'));
      await user.type(form.getByLabelText('Opening balance'), '500');
      expect(form.getByText('RM 500.00 owed will read RM 500.00 as a bank account')).toBeTruthy();
      await user.click(form.getByRole('button', { name: 'Save' }));

      expect(
        await screen.findByRole('heading', { name: 'Visa', level: size === 'phone' ? 1 : 2 }),
      ).toBeTruthy();
      expect(screen.getByLabelText('Balance RM 500.00')).toBeTruthy();
      await backToAccounts();
      await shows('Visa', 'Bank', '500.00');
      expect(await listed('Cash, banks and e-wallets')).toEqual(['Visa, Bank, 500.00']);
      expect(screen.queryByRole('region', { name: 'Cards' })).toBeNull();
      await waitFor(() =>
        expect(server.accounts[0]).toMatchObject({ kind: 'bank', openingCents: 50_000 }),
      );
    },
  );

  test('keeps the opening balance as it was when only the kind changes, and Undo puts both back', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Visa', kind: 'card', openingCents: -50_000 });
    renderApp(server, '/?accounts');
    const user = userEvent.setup();

    const form = await edit('Visa');
    await user.click(form.getByRole('radio', { name: 'Bank' }));
    await user.click(form.getByRole('button', { name: 'Save' }));
    await shows('Visa', 'Bank', '−500.00');
    await waitFor(() =>
      expect(server.accounts[0]).toMatchObject({ kind: 'bank', openingCents: -50_000 }),
    );

    expect(await screen.findByText('Visa is now a bank account')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await shows('Visa', 'Card', '500.00 owed');
    await waitFor(() =>
      expect(server.accounts[0]).toMatchObject({ kind: 'card', openingCents: -50_000 }),
    );
  });

  test('Undo puts back the name and opening balance changed with the kind', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Visa', kind: 'card', openingCents: -50_000 });
    renderApp(server, '/?accounts');
    const user = userEvent.setup();

    const form = await edit('Visa');
    await user.clear(form.getByLabelText('Name'));
    await user.type(form.getByLabelText('Name'), 'Maybank');
    await user.click(form.getByRole('radio', { name: 'Bank' }));
    await user.clear(form.getByLabelText('Opening balance'));
    await user.type(form.getByLabelText('Opening balance'), '500');
    await user.click(form.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(server.accounts[0]).toMatchObject({
        name: 'Maybank',
        kind: 'bank',
        openingCents: 50_000,
      }),
    );

    expect(await screen.findByText('Maybank is now a bank account')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    await shows('Visa', 'Card', '500.00 owed');
    await waitFor(() =>
      expect(server.accounts[0]).toMatchObject({
        name: 'Visa',
        kind: 'card',
        openingCents: -50_000,
      }),
    );
  });

  test('a kind changed and changed back sends nothing and says nothing', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Visa', kind: 'card', openingCents: -50_000 });
    renderApp(server, '/?accounts');
    const user = userEvent.setup();

    const form = await edit('Visa');
    await user.click(form.getByRole('radio', { name: 'Bank' }));
    await user.click(form.getByRole('radio', { name: 'Card' }));
    expect(form.getByLabelText('Amount owed')).toHaveProperty('value', '500');
    expect(form.queryByText(/will read/)).toBeNull();
    await user.click(form.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // Long enough for a save to have gone out
    await act(() => new Promise((r) => setTimeout(r, 100)));
    expect(saves()).toBe(0);
    expect(screen.queryByText(/is now/)).toBeNull();
    expect(server.accounts[0]).toMatchObject({ kind: 'card', openingCents: -50_000 });
  });

  test('a kind changed offline and undone reaches the server in order', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Visa', kind: 'card', openingCents: -50_000 });
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    await row('Visa');

    const back = goOffline(server);
    const form = await edit('Visa');
    await user.click(form.getByRole('radio', { name: 'Bank' }));
    await user.click(form.getByRole('button', { name: 'Save' }));
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    await backToAccounts();
    await shows('Visa', 'Card', '500.00 owed');

    back();
    // Each change sent once, the kind first and Undo after it
    await waitFor(
      () => {
        const sent = new Map<string, string | undefined>();
        for (const [path, init] of vi.mocked(fetch).mock.calls) {
          if (path !== '/api/changes' || init?.method !== 'POST') continue;
          const body = JSON.parse(init.body as string) as {
            changes: { kind?: string }[];
            ids: string[];
          };
          body.ids.forEach((cid, i) => sent.set(cid, body.changes[i].kind));
        }
        expect([...sent.values()]).toEqual(['bank', 'card']);
      },
      { timeout: 8000 },
    );
    await waitFor(() =>
      expect(server.accounts[0]).toMatchObject({ kind: 'card', openingCents: -50_000 }),
    );
    await shows('Visa', 'Card', '500.00 owed');
  });

  test('changes the kind offline, and saves it once back online', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Visa', kind: 'card', openingCents: -50_000 });
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    await row('Visa');

    const back = goOffline(server);
    const form = await edit('Visa');
    await user.click(form.getByRole('radio', { name: 'E-wallet' }));
    expect(form.getByText('RM 500.00 owed will read −RM 500.00 as an e-wallet')).toBeTruthy();
    await user.click(form.getByRole('button', { name: 'Save' }));
    await backToAccounts();
    // Shown at once, kept on the phone
    await shows('Visa', 'E-wallet', '−500.00');
    expect(server.accounts[0].kind).toBe('card');

    back();
    await waitFor(() => expect(server.accounts[0]).toMatchObject({ kind: 'ewallet' }), {
      timeout: 8000,
    });
    await shows('Visa', 'E-wallet', '−500.00');
  });

  test('says what is wrong with a name or amount, and saves nothing', async () => {
    const server = fakeServer();
    renderApp(server, '/?accounts');
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

  test.each(SIZES)(
    'works an opening balance typed as a sum out exactly, as Add does (%s)',
    async (size) => {
      const server = fakeServer();
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();

      await user.click(await screen.findByRole('button', { name: 'Add account' }));
      const form = within(await dialog());
      await user.type(form.getByLabelText('Name'), 'Wallet');
      // 1.035 exactly, half a cent up: 1.04, never 1.03
      await user.type(form.getByLabelText('Opening balance'), '0.25*4.14');
      await user.click(form.getByRole('button', { name: 'Add account' }));
      await shows('Wallet', 'Cash', '1.04');
      await waitFor(() => expect(server.accounts[0]).toMatchObject({ openingCents: 104 }));

      // Edit takes a sum too, up to the largest amount exactly
      const edited = await edit('Wallet');
      expect(edited.getByLabelText('Opening balance')).toHaveProperty('value', '1.04');
      await user.clear(edited.getByLabelText('Opening balance'));
      await user.type(edited.getByLabelText('Opening balance'), '0.1+0.2x5000000+8999999.9');
      await user.click(edited.getByRole('button', { name: 'Save' }));
      await backToAccounts();
      await shows('Wallet', 'Cash', '10,000,000.00');
      await waitFor(() =>
        expect(server.accounts[0]).toMatchObject({ openingCents: 1_000_000_000 }),
      );
    },
  );

  test('refuses an opening balance sum past the largest amount, and saves nothing', async () => {
    const server = fakeServer();
    renderApp(server, '/?accounts');
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add account' }));
    const form = within(await dialog());
    await user.type(form.getByLabelText('Name'), 'Rich');
    await user.type(form.getByLabelText('Opening balance'), '5000000+5000000.01');
    await user.click(form.getByRole('button', { name: 'Add account' }));
    expect(form.getByText('Up to 10,000,000 either way')).toBeTruthy();

    // Past it on the way is past it, as on Add's keypad, though it comes back under
    await user.clear(form.getByLabelText('Opening balance'));
    await user.type(form.getByLabelText('Opening balance'), '20000000-10000000');
    await user.click(form.getByRole('button', { name: 'Add account' }));
    expect(form.getByText('Up to 10,000,000 either way')).toBeTruthy();
    expect(server.accounts).toEqual([]);
  });

  test.each(SIZES)(
    "a card's amount owed typed as a sum below zero is in credit (%s)",
    async (size) => {
      const server = fakeServer();
      seed(server, { id: 'a'.repeat(16), name: 'Visa', kind: 'card', openingCents: -12_000 });
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();

      const form = await edit('Visa');
      await user.clear(form.getByLabelText('Amount owed'));
      await user.type(form.getByLabelText('Amount owed'), '-0.25x4.14');
      await user.click(form.getByRole('button', { name: 'Save' }));
      await backToAccounts();
      expect(await screen.findByRole('link', { name: 'Visa, Card, 1.04 in credit' })).toBeTruthy();
      await waitFor(() => expect(server.accounts[0]).toMatchObject({ openingCents: 104 }));
    },
  );

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

  test('a refused change is put back and kept to review; one made after it is still saved', async () => {
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
    // The rename is put back, and waits to be tried again or discarded
    expect(await row('Wallet')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Purse,/ })).toBeNull();
    expect(await screen.findByText("1 change couldn't be saved.")).toBeTruthy();
    // The new account doesn't depend on it, so it's saved
    await waitFor(() => expect(server.accounts.map((a) => a.name)).toEqual(['Wallet', 'Bank']));
    expect(await row('Bank')).toBeTruthy();
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
