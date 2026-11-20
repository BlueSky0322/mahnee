// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Account, Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../testing/app';
import { fakeServer, holdNext, reloadApp, setupAppTests } from '../testing/app';

// Each signed-in account's transaction history, downloaded to the device in the background
// a page at a time, so Activity, its filters and an account's entries work offline after a
// cold start: from what's on the device, with the changes still to send on top, counted
// and ordered as the server would. Where the device doesn't hold every day asked for yet,
// it says which days it shows. Every name and figure here is this file's own.

setupAppTests();

const [CASH, BANK] = ['a', 'b'].map((c) => c.repeat(16));
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;

beforeEach(() => {
  // Friday 20 November 2026, mid-morning, in the device's own time
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 20, 10, 0, 0));
  return () => vi.useRealTimers();
});

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

function seed(server: FakeServer, t: Partial<Transaction>) {
  const n = server.transactions.length + 1;
  server.transactions.push({
    id: n.toString(16).padStart(16, '0'),
    kind: 'expense',
    accountId: CASH,
    toAccountId: null,
    amountCents: 100,
    categoryId: id('Food'),
    payee: null,
    note: null,
    date: '2026-11-10',
    createdAt: n,
    ...t,
  });
}

/** September's 230 entries on Cash: "Shop 0" to "Shop 229", RM 1.00 to RM 3.29 */
const SEPTEMBER = 230;
const SEPTEMBER_LINE = '230 found · RM 493.35 spent';

/**
 * Cash and a Bank. September: 230 spends on Cash, eight a day or so. October: a top-up
 * of RM 75.00 from the Bank to Cash on the 4th, and Acme's RM 3,250.00 into the Bank on
 * the 5th. November: Kedai Ali, RM 7.25 on Cash on the 10th.
 */
function withHistory() {
  const server = fakeServer();
  seedAccount(server, { id: CASH, name: 'Cash' });
  seedAccount(server, { id: BANK, name: 'Bank', kind: 'bank', openingCents: 1_000_000 });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  for (let i = 0; i < SEPTEMBER; i++) {
    const day = String(1 + Math.floor((i * 30) / SEPTEMBER)).padStart(2, '0');
    seed(server, { date: `2026-09-${day}`, amountCents: 100 + i, payee: `Shop ${i}` });
  }
  seed(server, {
    date: '2026-10-04',
    kind: 'transfer',
    accountId: BANK,
    toAccountId: CASH,
    amountCents: 7_500,
    categoryId: null,
    note: 'top-up',
  });
  seed(server, {
    date: '2026-10-05',
    kind: 'income',
    accountId: BANK,
    amountCents: 325_000,
    categoryId: id('Salary'),
    payee: 'Acme',
  });
  seed(server, { date: '2026-11-10', amountCents: 725, payee: 'Kedai Ali' });
  return server;
}

/**
 * Opens the app online, as a fresh page: the modules the test reads below (the ledger's)
 * are then the ones this page runs
 */
const openOnline = (server: FakeServer) => reloadApp(server, '/');

/** Downloads the history now, as the app does in the background once it's online */
async function download() {
  const { syncHistory } = await import('../ledger/ledger');
  await act(() => syncHistory());
}

/** The connection is gone: the browser says so, and nothing reaches the server */
function offline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  onTestFinished(() => onLine.mockRestore());
  return () => {
    server.health = 'up';
    onLine.mockReturnValue(true);
  };
}

/** The app closed and opened again at `path` with no connection */
async function coldStartOffline(server: FakeServer, path: string) {
  const back = offline(server);
  await reloadApp(server, path);
  return back;
}

/** Where each request the app made went */
const asked = () =>
  vi
    .mocked(fetch)
    .mock.calls.map(
      ([input]) => new URL(input instanceof Request ? input.url : input.toString(), 'http://app'),
    );

/** What Activity says it found: "230 found · RM 493.35 spent" */
const foundLine = () =>
  screen.findByText(/^\d+ found( on this device)?( · .*)?$/, {}, { timeout: 6000 });

const registerTitles = () =>
  within(screen.getByRole('table', { name: 'Transactions' }))
    .getAllByRole('row')
    .slice(1)
    .map((row) => within(row).getAllByRole('cell')[2]?.textContent?.split(' · ')[0]);

const SEPTEMBER_PATH = '/?activity&from=2026-09-01&to=2026-09-30';

describe('offline, from the history on the device', () => {
  test('a month never opened shows every entry, page by page, with the server’s figures', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    const back = await coldStartOffline(server, SEPTEMBER_PATH);
    expect((await foundLine()).textContent).toBe(SEPTEMBER_LINE);
    expect(screen.queryByText(/aren't on this device/)).toBeNull();
    // 200 at a time, newest first, as the server pages them
    await waitFor(() => expect(registerTitles()).toHaveLength(200));
    expect(registerTitles()[0]).toBe('Shop 229');
    await userEvent.setup().click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(registerTitles()).toHaveLength(SEPTEMBER));
    expect(registerTitles().at(-1)).toBe('Shop 0');

    // The server says the same once the connection is back
    back();
    await reloadApp(server, SEPTEMBER_PATH);
    expect((await foundLine()).textContent).toBe(SEPTEMBER_LINE);
  }, 30_000);

  test('a transfer shows on the account it went to, and an edit made offline shows at once', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    const path = `/?activity&account=${CASH}&kind=all&from=2026-10-01&to=2026-10-31`;
    const back = await coldStartOffline(server, path);
    expect((await foundLine()).textContent).toBe('1 found');
    expect(registerTitles()).toEqual(['top-up']);

    // Changed offline, kept to send: shown and counted straight away
    const { change } = await import('../ledger/ledger');
    act(() =>
      change({
        op: 'addTransaction',
        transaction: {
          id: 'f'.repeat(16),
          kind: 'expense',
          accountId: CASH,
          toAccountId: null,
          amountCents: 1_250,
          categoryId: id('Food'),
          payee: 'Warung offline',
          note: null,
          date: '2026-10-08',
        },
      }),
    );
    await waitFor(() => expect(registerTitles()).toEqual(['Warung offline', 'top-up']));
    expect((await foundLine()).textContent).toBe('2 found · RM 12.50 spent');

    // Saved once back, and the server finds the same
    back();
    await reloadApp(server, path);
    await waitFor(() =>
      expect(server.transactions.some((t) => t.payee === 'Warung offline')).toBe(true),
    );
    expect((await foundLine()).textContent).toBe('2 found · RM 12.50 spent');
  }, 30_000);

  test('an account’s entries go back past the first page offline', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    await coldStartOffline(server, `/?account=${CASH}`);
    const entries = await screen.findByRole('table', { name: 'Transactions' }, { timeout: 6000 });
    expect(within(entries).getByText('Kedai Ali')).toBeTruthy();
    const user = userEvent.setup();
    // 50 at a time, as the server pages them, to the very first
    const rows = () =>
      within(screen.getByRole('table', { name: 'Transactions' })).getAllByRole('row');
    expect(rows()).toHaveLength(1 + 50);
    for (const shown of [100, 150, 200, 232]) {
      await user.click(screen.getByRole('button', { name: 'Show 50 more' }));
      await waitFor(() => expect(rows()).toHaveLength(1 + shown));
    }
    expect(
      within(screen.getByRole('table', { name: 'Transactions' })).getByText('Shop 0'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Show 50 more' })).toBeNull();
    expect(screen.queryByText(/aren't on this device/)).toBeNull();
  }, 30_000);
});

describe('a download not finished', () => {
  test('says which days it shows, and carries on where it stopped once back', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    // Cash's first page arrives; then the connection drops
    const first = holdNext(server, 'GET', '/api/transactions');
    const run = import('../ledger/ledger').then(({ syncHistory }) => syncHistory());
    await waitFor(() =>
      expect(asked().some((url) => url.searchParams.get('limit') === '200')).toBe(true),
    );
    server.pathsDown.add('/api/transactions');
    first.release();
    await act(() => run);

    // The 200 newest on Cash are on the device: back to a day in September
    const cash = server.transactions
      .filter((t) => t.accountId === CASH || t.toAccountId === CASH)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    const oldestHeld = cash[199].date;
    const firstWhole = `Sep ${Number(oldestHeld.slice(8)) + 1}`;
    const inCash = `/?activity&account=${CASH}&from=2026-09-01&to=2026-09-30`;
    const back = await coldStartOffline(server, inCash);
    await screen.findByText(
      `Showing ${firstWhole} to Sep 30. Older entries aren't on this device yet.`,
      {},
      { timeout: 6000 },
    );
    // Counted as what's on the device, never as if it were all
    expect((await foundLine()).textContent).toMatch(/^\d+ found on this device · /);

    // Every account: the Bank's hasn't started, so none of these days are whole
    window.history.replaceState(null, '', SEPTEMBER_PATH);
    await reloadApp(server, SEPTEMBER_PATH);
    expect(
      await screen.findByText(
        "Entries for these days aren't on this device yet.",
        {},
        {
          timeout: 6000,
        },
      ),
    ).toBeTruthy();

    // Back online: it carries on from Cash's second page, not from the start
    back();
    server.pathsDown.delete('/api/transactions');
    await reloadApp(server, '/');
    await screen.findByRole('navigation', { name: 'Main' });
    vi.mocked(fetch).mockClear();
    await download();
    const cashPages = asked().filter(
      (url) => url.pathname === '/api/transactions' && url.searchParams.get('account') === CASH,
    );
    const c = cash[199];
    expect(
      cashPages.some(
        (url) => url.searchParams.get('before') === `${c.date}__${c.createdAt}_${c.id}`,
      ),
    ).toBe(true);
    // Nothing on Cash fetched twice in full: a short look for anything new, then the rest
    expect(cashPages.filter((url) => url.searchParams.get('limit') === '200')).toHaveLength(1);

    await coldStartOffline(server, inCash);
    expect((await foundLine()).textContent).toMatch(/^\d+ found · /);
    expect(screen.queryByText(/aren't on this device/)).toBeNull();
  }, 40_000);
});

describe('whose history', () => {
  test('another account’s history is never shown', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    // Someone else signs in on this device, with their own one entry in September
    server.me = { ...server.me, email: 'mei@example.com', displayName: 'Mei' };
    server.transactions = [];
    seed(server, { date: '2026-09-09', amountCents: 4_200, payee: 'Mei’s lunch' });
    await reloadApp(server, '/');
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    await coldStartOffline(server, SEPTEMBER_PATH);
    expect((await foundLine()).textContent).toBe('1 found · RM 42.00 spent');
    expect(registerTitles()).toEqual(['Mei’s lunch']);
    expect(screen.queryByText('Shop 0')).toBeNull();
  }, 30_000);

  test('signing out leaves nothing of it on the device', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();
    const { clearCache } = await import('./cache');
    await act(() => clearCache());
    const { heldEntries } = await import('./history-store');
    expect(await heldEntries()).toBe(0);
  });
});

describe('when the device can’t keep it', () => {
  test('nothing is read from it while the currency its amounts are in isn’t known', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();
    const { localAccountPage, localSince } = await import('../ledger/history');
    // Kept in ringgit: read in ringgit, and not at all before the profile says
    expect((await localAccountPage(CASH, null, 'MYR'))?.transactions.length).toBeGreaterThan(0);
    expect(await localAccountPage(CASH, null, null)).toBeNull();
    expect(await localAccountPage(CASH, null, 'SGD')).not.toBeNull();
    expect(await localSince(CASH, '2026-09-01', null)).toBeNull();
  }, 30_000);

  test('offline, Activity says searching needs a connection', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    // The browser refuses this app's history database (full, or blocked), whichever page asks
    const factory = Object.getPrototypeOf(indexedDB) as IDBFactory;
    const real = factory.open.bind(indexedDB);
    const blocked = vi.spyOn(factory, 'open').mockImplementation((name, version) => {
      if (name === 'mahnee-history') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return real(name, version);
    });
    onTestFinished(() => blocked.mockRestore());
    await download();

    await coldStartOffline(server, SEPTEMBER_PATH);
    expect(
      await screen.findByRole('heading', { name: 'Connect to search' }, { timeout: 6000 }),
    ).toBeTruthy();
    expect(
      await screen.findByText(
        "This device couldn't keep your entries, so searching needs a connection.",
      ),
    ).toBeTruthy();
  }, 30_000);
});

describe('kept up to date', () => {
  /** Nine days on, past when the device checks its whole history again */
  const nineDaysOn = () => vi.setSystemTime(new Date(2026, 10, 29, 10, 0, 0));

  test('edits, deletions and back-dated entries made on another device reach it', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    // Elsewhere: Shop 5 renamed, Shop 229 deleted, a receipt from September entered late
    server.transactions.find((t) => t.payee === 'Shop 5')!.payee = 'Shop five';
    server.transactions = server.transactions.filter((t) => t.payee !== 'Shop 229');
    seed(server, { date: '2026-09-15', amountCents: 999, payee: 'Late receipt', createdAt: 9e9 });
    nineDaysOn();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    await coldStartOffline(server, `${SEPTEMBER_PATH}&q=shop%20f`);
    expect((await foundLine()).textContent).toBe('1 found · RM 1.05 spent');
    await reloadApp(server, SEPTEMBER_PATH);
    expect((await foundLine()).textContent).toBe('230 found · RM 500.05 spent');
    await reloadApp(server, `${SEPTEMBER_PATH}&q=late`);
    await waitFor(() => expect(registerTitles()).toEqual(['Late receipt']));
    await reloadApp(server, `${SEPTEMBER_PATH}&q=shop%20229`);
    expect(await screen.findByText('No transactions match', {}, { timeout: 6000 })).toBeTruthy();
  }, 40_000);

  test('a check stopped part way keeps every entry shown, saying they are being refreshed', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    nineDaysOn();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    const first = holdNext(server, 'GET', '/api/transactions');
    const run = import('../ledger/ledger').then(({ syncHistory }) => syncHistory());
    await waitFor(() =>
      expect(asked().some((url) => url.pathname === '/api/transactions')).toBe(true),
    );
    server.pathsDown.add('/api/transactions');
    first.release();
    await act(() => run);

    const cash = server.transactions
      .filter((t) => t.accountId === CASH || t.toAccountId === CASH)
      .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    const firstChecked = `Sep ${Number(cash[199].date.slice(8)) + 1}`;
    await coldStartOffline(server, `/?activity&account=${CASH}&from=2026-09-01&to=2026-09-30`);
    expect((await foundLine()).textContent).toBe('230 found on this device · RM 493.35 spent');
    expect(
      screen.getByText(
        `Checked from ${firstChecked} to Sep 30. Older entries are being refreshed and may be out of date.`,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/aren't on this device/)).toBeNull();
  }, 40_000);

  test('a new home currency set on another device downloads the history again', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    // Converted elsewhere: every amount is now in Singapore dollars
    server.me = { ...server.me, settings: { ...server.me.settings, currency: 'SGD' } };
    for (const t of server.transactions) t.amountCents = Math.round(t.amountCents * 0.3);
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    const back = await coldStartOffline(server, SEPTEMBER_PATH);
    expect(
      await screen.findByText(
        'These entries are being refreshed and may be out of date.',
        {},
        {
          timeout: 6000,
        },
      ),
    ).toBeTruthy();

    back();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();
    await reloadApp(server, SEPTEMBER_PATH);
    const online = (await foundLine()).textContent;
    await coldStartOffline(server, SEPTEMBER_PATH);
    expect((await foundLine()).textContent).toBe(online);
    expect(screen.queryByText(/being refreshed/)).toBeNull();
  }, 40_000);

  test('offline, it says when it was last checked, and when that was too long ago', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    await coldStartOffline(server, SEPTEMBER_PATH);
    expect((await foundLine()).textContent).toBe(SEPTEMBER_LINE);
    expect(screen.getByText('Checked Nov 20.')).toBeTruthy();

    // A week and more away, offline all along: nothing can be checked meanwhile
    nineDaysOn();
    await reloadApp(server, SEPTEMBER_PATH);
    expect((await foundLine()).textContent).toBe('230 found on this device · RM 493.35 spent');
    expect(screen.getByText('Not checked since Nov 20. Entries may be out of date.')).toBeTruthy();
    expect(screen.queryByText(/being refreshed/)).toBeNull();
  }, 30_000);

  test('kinds narrow it as the server does', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    await coldStartOffline(server, '/?activity&kind=income&dates=all');
    expect((await foundLine()).textContent).toBe('1 found · RM 3,250.00 received');
    expect(registerTitles()).toEqual(['Acme']);
    await reloadApp(server, '/?activity&kind=transfer&dates=all');
    await waitFor(() => expect(registerTitles()).toEqual(['top-up']));
  }, 30_000);
});

describe('two tabs', () => {
  test('only one downloads at a time; the other waits its turn', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    const { takeDownload } = await import('./history-store');
    expect(await takeDownload(server.me.email, 'another-tab', Date.now())).toBe(true);
    vi.mocked(fetch).mockClear();
    await download();
    expect(asked().filter((url) => url.pathname === '/api/transactions')).toEqual([]);

    // The other tab closed without letting go: after a while it's taken over
    vi.setSystemTime(new Date(2026, 10, 20, 10, 5, 0));
    await download();
    expect(asked().filter((url) => url.pathname === '/api/transactions').length).toBeGreaterThan(0);
  }, 30_000);
});

describe('out of space', () => {
  test('says so once, stops downloading, and still shows what it holds offline', async () => {
    const server = withHistory();
    await openOnline(server);
    await screen.findByRole('navigation', { name: 'Main' });
    await download();

    // Full: nothing more can be written to the history
    const { put } = Object.getOwnPropertyDescriptors(IDBObjectStore.prototype);
    const full = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (
      this: IDBObjectStore,
      ...args: Parameters<IDBObjectStore['put']>
    ) {
      if (this.name === 'entries') throw new DOMException('Full', 'QuotaExceededError');
      return (put.value as IDBObjectStore['put']).apply(this, args);
    });
    onTestFinished(() => full.mockRestore());
    seed(server, { date: '2026-11-18', amountCents: 300, payee: 'New one' });
    await download();
    const message =
      'This device is out of space for your history, so offline it shows what it has kept.';
    expect(await screen.findByText(message)).toBeTruthy();
    vi.mocked(fetch).mockClear();
    await download();
    expect(asked().filter((url) => url.pathname === '/api/transactions')).toEqual([]);
    expect(screen.getAllByText(message)).toHaveLength(1);

    await coldStartOffline(server, SEPTEMBER_PATH);
    expect((await foundLine()).textContent).toBe(SEPTEMBER_LINE);
  }, 30_000);
});
