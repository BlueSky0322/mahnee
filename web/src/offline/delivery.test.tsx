// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get, set } from 'idb-keyval';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Account, ChangesBody } from '@shared/api';
import type { FakeServer } from '../testing/app';
import {
  OFFLINE_NOTICE,
  fakeServer,
  goToPlace,
  holdNext,
  openSettings,
  reloadApp,
  renderApp,
  setupAppTests,
} from '../testing/app';
import { LAST_EMAIL_KEY } from './cache';
import { outboxKey } from './outbox';

// Changes made without a connection: shown at once, kept on the device through a reload,
// and saved once, in order, when the connection is back. Each page here is the whole app,
// against the stand-in server; a reload starts the app's code afresh, with only what the
// browser kept.

setupAppTests();

const RYAN = 'ryan@example.com';
const SIZES = ['desktop', 'phone'] as const;
/** The freshness label, under Home's title on phones and in the sidebar on a computer */
const waiting = (n: number) => `Offline · ${n} ${n === 1 ? 'change' : 'changes'} waiting to save`;

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

/** An account's row on Accounts */
const row = (name: string) =>
  waitFor(() => {
    const found = screen.queryByRole('link', { name: new RegExp(`^${name},`) });
    expect(found).not.toBeNull();
    return found!;
  });

/** Back up to Accounts from an account's page; on a computer the list is beside it already */
async function upToAccounts() {
  const back = screen.queryByRole('button', { name: 'Accounts' });
  if (back != null) await userEvent.setup().click(back);
}
const dialog = () => screen.findByRole('dialog');

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

/** The changes each request to save carried, in order */
const requests = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === '/api/changes' && init?.method === 'POST')
    .map(([, init]) => (JSON.parse(init!.body as string) as ChangesBody).changes);

/** What's still waiting on this device for Ryan, as kept there */
const keptForRyan = async () =>
  (await get<{ email: string; value: unknown[] }>(outboxKey(RYAN)))?.value ?? [];

async function addAccount(name: string) {
  const user = userEvent.setup();
  await user.click((await screen.findAllByRole('button', { name: 'Add account' }))[0]);
  const form = within(await dialog());
  await user.type(form.getByLabelText('Name'), name);
  await user.click(form.getByRole('button', { name: 'Add account' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
}

/** Opens an account's page from Home, then its Edit form */
async function edit(name: string) {
  const user = userEvent.setup();
  await user.click(await row(name));
  await user.click(await screen.findByRole('button', { name: 'Edit' }));
  return within(await dialog());
}

/** Renames an account on its page, and goes back up to Accounts */
async function rename(from: string, to: string) {
  const user = userEvent.setup();
  const form = await edit(from);
  await user.clear(form.getByLabelText('Name'));
  await user.type(form.getByLabelText('Name'), to);
  await user.click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await upToAccounts();
}

describe('changes made offline', () => {
  test.each(SIZES)(
    'show at once, stay through a reload, and are saved once when back (%s)',
    async (size) => {
      const server = fakeServer();
      seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
      renderApp(server, '/?accounts', { size });
      await row('Wallet');

      goOffline(server);
      await addAccount('Savings');
      expect(await row('Savings')).toBeTruthy();
      expect(await screen.findByText(OFFLINE_NOTICE[size])).toBeTruthy();
      expect(await screen.findByText(waiting(1))).toBeTruthy();
      await waitFor(async () => expect(await keptForRyan()).toHaveLength(1));

      // Reloaded while still offline: the page starts from what the device kept
      await reloadApp(server, '/?accounts', { size });
      expect(await row('Savings')).toBeTruthy();
      expect(await row('Wallet')).toBeTruthy();
      expect(await screen.findByText(OFFLINE_NOTICE[size])).toBeTruthy();
      expect(await screen.findByText(waiting(1))).toBeTruthy();
      expect(server.accounts.map((a) => a.name)).toEqual(['Wallet']);

      // Back online, the server saves it, but its answer is lost on the way back
      server.loseNext.changes = true;
      const back = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
      onTestFinished(() => back.mockRestore());
      server.health = 'up';
      act(() => void window.dispatchEvent(new Event('online')));
      await waitFor(() => expect(requests().length).toBeGreaterThan(0));
      // So it's sent again (on coming back to the app, at the latest), and counted once
      act(() => void document.dispatchEvent(new Event('visibilitychange')));
      await waitFor(async () => expect(await keptForRyan()).toEqual([]));
      expect(requests().length).toBeGreaterThan(1);
      expect(new Set(requests().map((r) => JSON.stringify(r))).size).toBe(1);
      expect(server.accounts.map((a) => a.name)).toEqual(['Wallet', 'Savings']);
      expect(await row('Savings')).toBeTruthy();
      expect(screen.queryByText('That account already exists')).toBeNull();
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    },
  );

  test('a change refused once back is kept to review; the others are saved', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    await row('Wallet');
    goOffline(server);
    await rename('Wallet', 'Purse');
    await addAccount('Made later');
    await reloadApp(server, '/?accounts');
    expect(await row('Purse')).toBeTruthy();
    expect(await screen.findByText(waiting(2))).toBeTruthy();

    // Meanwhile the account went from the server, so the rename can't be saved
    const wallet = server.accounts.splice(0, 1);
    const back = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    onTestFinished(() => back.mockRestore());
    server.health = 'up';
    act(() => void window.dispatchEvent(new Event('online')));

    expect(await screen.findByText('Account not found')).toBeTruthy();
    await waitFor(() => expect(server.accounts.map((a) => a.name)).toEqual(['Made later']));
    expect(await row('Made later')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Purse,/ })).toBeNull();
    const notice = await screen.findByText("1 change couldn't be saved.");
    expect(await keptForRyan()).toHaveLength(1);

    // Still there after closing the app
    await reloadApp(server, '/?accounts');
    expect(await screen.findByText("1 change couldn't be saved.")).toBeTruthy();
    expect(notice).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Review' }));
    const review = within(await dialog());
    const item = within(review.getByRole('listitem'));
    expect(item.getByText('Rename an account to "Purse"')).toBeTruthy();
    expect(item.getByText('Account not found')).toBeTruthy();

    // The account is back on the server, so trying again saves it
    server.accounts.unshift(...wallet);
    await user.click(item.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(server.accounts[0].name).toBe('Purse'));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(async () => expect(await keptForRyan()).toEqual([]));
    expect(screen.queryByText(/couldn't be saved/)).toBeNull();
    expect(await row('Purse')).toBeTruthy();
  });

  test('a refused change can be discarded', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    await row('Wallet');
    server.accounts.splice(0, 1);
    await rename('Wallet', 'Purse');
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const item = within(within(await dialog()).getByRole('listitem'));
    await user.click(item.getByRole('button', { name: 'Discard' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(async () => expect(await keptForRyan()).toEqual([]));
    expect(screen.queryByText(/couldn't be saved/)).toBeNull();
    // Sent once together with nothing else, refused, and never again
    expect(requests()).toHaveLength(1);
  });

  test('archiving and Undo offline are both kept, and saved in order', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    seed(server, { id: 'b'.repeat(16), name: 'Bank', kind: 'bank' });
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    await row('Wallet');
    const back = goOffline(server);

    await user.click((await edit('Wallet')).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Accounts' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: /^Wallet,/ })).toBeNull());
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await row('Wallet')).toBeTruthy();
    expect(await screen.findByText(OFFLINE_NOTICE.phone)).toBeTruthy();
    // Accounts says how many wait, and the device keeps both
    expect(await screen.findByText(waiting(2))).toBeTruthy();
    await waitFor(async () => expect(await keptForRyan()).toHaveLength(2));

    back();
    await waitFor(async () => expect(await keptForRyan()).toEqual([]));
    expect(requests()).toEqual([
      [
        { op: 'archiveAccount', id: 'a'.repeat(16), archived: true },
        { op: 'archiveAccount', id: 'a'.repeat(16), archived: false },
      ],
    ]);
    expect(server.accounts[0].archived).toBe(false);
  });
});

describe('changes waiting when the session runs out', () => {
  test('are kept, and the notice offers to sign in', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    await row('Wallet');
    server.health = 'signedOut';
    await rename('Wallet', 'Purse');

    expect(
      await screen.findByText(
        'Signed out. Changes are kept on this device until you sign in. 1 change waiting.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeTruthy();
    expect(await row('Purse')).toBeTruthy();
    expect(await keptForRyan()).toHaveLength(1);
  });
});

describe("when this device can't keep changes", () => {
  test('says so, still saves from the open page, and keeps it once trying again works', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    await row('Wallet');
    // Storage full, or blocked: every write fails
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    onTestFinished(() => put.mockRestore());
    const back = goOffline(server);
    await rename('Wallet', 'Purse');
    expect(
      await screen.findByText(
        "Couldn't save on this device. Keep the app open until your changes are saved. 1 change waiting.",
      ),
    ).toBeTruthy();
    expect(await keptForRyan()).toEqual([]);

    // Space is made: trying again keeps it on the device
    put.mockRestore();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(async () => expect(await keptForRyan()).toHaveLength(1));
    expect(await screen.findByText(OFFLINE_NOTICE.desktop)).toBeTruthy();
    expect(screen.queryByText(/Couldn't save on this device/)).toBeNull();
    back();
    await waitFor(() => expect(server.accounts[0].name).toBe('Purse'));
  });

  test('a change the device never kept is still saved from the open page', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    await row('Wallet');
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    onTestFinished(() => put.mockRestore());
    const held = holdNext(server, 'POST', '/api/changes');
    await rename('Wallet', 'Purse');
    expect(await screen.findByText(/^Couldn't save on this device\./)).toBeTruthy();
    held.release();
    await waitFor(() => expect(server.accounts[0].name).toBe('Purse'));
    await waitFor(() => expect(screen.queryByText(/Couldn't save on this device/)).toBeNull());
  });
});

describe('closing the app while a save is on its way', () => {
  test('a change made meanwhile is kept on the device, and each reaches the server once', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    await row('Wallet');
    // The server saves the first, but its answer never comes back before the app closes
    const lost = holdNext(server, 'POST', '/api/changes');
    await rename('Wallet', 'Purse');
    await waitFor(() => expect(requests()).toHaveLength(1));
    await addAccount('Savings');
    expect(await screen.findByText('Saving 2 changes')).toBeTruthy();
    await waitFor(async () => expect(await keptForRyan()).toHaveLength(2));

    await reloadApp(server, '/?accounts');
    await waitFor(async () => expect(await keptForRyan()).toEqual([]));
    expect(server.accounts.map((a) => a.name)).toEqual(['Purse', 'Savings']);
    expect(await row('Savings')).toBeTruthy();
    expect(await row('Purse')).toBeTruthy();
    // The closed page's request is let go of, as the browser does with the page
    lost.release();
  });
});

describe('saving while the app is in the background', () => {
  /** The page on screen, or behind another app */
  function showPage(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  }

  test('a hidden page sends so the save finishes after it goes; one on screen as usual', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    onTestFinished(() => showPage('visible'));
    const keepalive = () =>
      vi
        .mocked(fetch)
        .mock.calls.filter(([path]) => path === '/api/changes')
        .map(([, init]) => init?.keepalive === true);

    await rename('Wallet', 'Purse');
    await waitFor(() => expect(server.accounts[0].name).toBe('Purse'));
    // Archived, and the app put behind another before the save goes
    const user = userEvent.setup();
    const form = await edit('Purse');
    const held = holdNext(server, 'POST', '/api/changes');
    showPage('hidden');
    await user.click(form.getByRole('button', { name: 'Archive' }));
    held.release();
    await waitFor(() => expect(server.accounts[0].archived).toBe(true));
    expect(keepalive()).toEqual([false, true]);
  });
});

describe('signing out', () => {
  /** Where the page is sent, which jsdom can't go: noted instead */
  function watchLeaving() {
    const sentTo: string[] = [];
    const real = window.location;
    vi.stubGlobal(
      'location',
      new Proxy(
        {},
        {
          get: (_, key) => Reflect.get(real, key),
          set: (_, key, value: string) => {
            if (key === 'href') sentTo.push(value);
            return true;
          },
        },
      ),
    );
    return sentTo;
  }

  test.each(SIZES)('asks first when changes are waiting (%s)', async (size) => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup();
    await row('Wallet');
    goOffline(server);
    await rename('Wallet', 'Purse');
    await openSettings();
    const sentTo = watchLeaving();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const asking = within(await dialog());
    expect(asking.getByText(/1 change hasn't been saved yet/)).toBeTruthy();
    await user.click(asking.getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sentTo).toEqual([]);
    expect(await keptForRyan()).toHaveLength(1);

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(within(await dialog()).getByRole('button', { name: 'Sign out anyway' }));
    await waitFor(() => expect(sentTo).toEqual(['/cdn-cgi/access/logout']));
    expect(await get(outboxKey(RYAN))).toBeUndefined();
  });

  test('keeps a change the server refused for when they sign in again', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    await row('Wallet');
    // Gone from the server, so the rename is refused and held for review
    server.accounts.splice(0, 1);
    await rename('Wallet', 'Purse');
    expect(await screen.findByText("1 change couldn't be saved.")).toBeTruthy();
    // Settings, from a page that no longer shows the account
    await reloadApp(server, '/?settings');
    await screen.findByText('Ryan');
    const sentTo = watchLeaving();

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const asking = within(await dialog());
    expect(
      asking.getByText(
        /1 change the server couldn't save stays on this device for when you sign in again/,
      ),
    ).toBeTruthy();
    await user.click(asking.getByRole('button', { name: 'Sign out anyway' }));
    await waitFor(() => expect(sentTo).toEqual(['/cdn-cgi/access/logout']));
    vi.unstubAllGlobals();

    // Signed in again: still there to review
    await reloadApp(server, '/?accounts');
    expect(await screen.findByText("1 change couldn't be saved.")).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Review' }));
    const item = within(within(await dialog()).getByRole('listitem'));
    expect(item.getByText('Account not found')).toBeTruthy();
  });

  test('with nothing waiting, signs out straight away', async () => {
    const server = fakeServer();
    renderApp(server, '/?settings');
    await screen.findByText('Ryan');
    const sentTo = watchLeaving();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(sentTo).toEqual(['/cdn-cgi/access/logout']));
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('someone else signing in on this device', () => {
  test("doesn't see or send the first person's changes, which wait for them", async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts');
    await row('Wallet');
    const back = goOffline(server);
    await addAccount("Ryan's savings");
    await waitFor(async () => expect(await keptForRyan()).toHaveLength(1));

    // Ann signs in on Ryan's device, online
    back();
    server.me = { ...server.me, email: 'ann@example.com', displayName: 'Ann' };
    await reloadApp(server, '/?settings');
    expect(await screen.findByText('Ann')).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Close settings' }));
    await goToPlace('Accounts');
    expect(await row('Wallet')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /^Ryan's savings,/ })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // Only refused writes could have reached the server: none were sent as Ann
    expect(requests()).toEqual([]);
    expect(server.accounts.map((a) => a.name)).toEqual(['Wallet']);
    expect(await get(outboxKey(RYAN))).toMatchObject({ email: RYAN });

    // Ryan is back: his change goes, as him, and stays on the device until the server answers
    server.me = { ...server.me, email: RYAN, displayName: 'Ryan' };
    const answer = holdNext(server, 'POST', '/api/changes');
    await reloadApp(server, '/?accounts');
    expect(await row("Ryan's savings")).toBeTruthy();
    await waitFor(() => expect(server.accounts.map((a) => a.name)).toContain("Ryan's savings"));
    expect(await keptForRyan()).toHaveLength(1);
    answer.release();
    await waitFor(async () => expect(await keptForRyan()).toEqual([]));
  });
});

describe('what happens once the connection is back', () => {
  test.each(SIZES)('without background sync, says to open Mahnee to finish (%s)', async (size) => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts', { size });
    await row('Wallet');
    goOffline(server);
    // Nothing waiting yet: only that changes are kept
    expect(await screen.findByText(OFFLINE_NOTICE[size])).toBeTruthy();
    expect(screen.queryByText(/finish syncing/)).toBeNull();
    await rename('Wallet', 'Purse');
    await addAccount('Savings');
    expect(await screen.findByText(OFFLINE_NOTICE[size])).toBeTruthy();
    expect(await screen.findByText('Open Mahnee when connected to finish syncing.')).toBeTruthy();
  });

  test('with background sync, says they are sent even with the app closed', async () => {
    vi.stubGlobal('SyncManager', class {});
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server, '/?accounts', { size: 'phone' });
    await row('Wallet');
    goOffline(server);
    await rename('Wallet', 'Purse');
    expect(
      await screen.findByText("It's sent when the connection is back, even with Mahnee closed."),
    ).toBeTruthy();
    expect(screen.queryByText(/finish syncing/)).toBeNull();
  });
});

describe('reviewing the rest of a large import', () => {
  const WALLET = 'a'.repeat(16);
  const IMPORT = 'f'.repeat(16);
  const entry = (n: number) => ({
    cid: `c${n}`.padEnd(16, '0'),
    group: 'c0'.padEnd(16, '0'),
    change: {
      op: 'addTransaction',
      importId: IMPORT,
      transaction: {
        id: n.toString(16).padStart(16, 'e'),
        kind: 'expense',
        accountId: WALLET,
        toAccountId: null,
        amountCents: 100,
        categoryId: null,
        payee: `Row ${n}`,
        note: null,
        date: '2026-01-05',
      },
    },
    currency: 'MYR',
  });
  /** What waits of an import, refused: its rows from `from` on, and its opening change */
  async function heldImport(server: FakeServer, from: number, withRecord: boolean) {
    seed(server, { id: WALLET, name: 'Wallet' });
    const first = withRecord ? 'c0'.padEnd(16, '0') : `c${from}`.padEnd(16, '0');
    const refused = { reason: 'Enter an amount', set: first };
    const record = {
      cid: 'c0'.padEnd(16, '0'),
      group: 'c0'.padEnd(16, '0'),
      change: {
        op: 'addImport',
        import: {
          id: IMPORT,
          fileName: 'bank.csv',
          accountId: WALLET,
          addedCount: 3,
          skippedCount: 0,
        },
      },
      currency: 'MYR',
      refused,
    };
    const rows = [from, from + 1].map((n) => ({ ...entry(n), refused }));
    const opening = {
      cid: 'c9'.padEnd(16, '0'),
      group: 'c0'.padEnd(16, '0'),
      change: { op: 'updateAccount', id: WALLET, openingCents: 5000, importId: IMPORT },
      currency: 'MYR',
      refused,
    };
    localStorage.setItem(LAST_EMAIL_KEY, RYAN);
    await set(outboxKey(RYAN), {
      email: RYAN,
      value: [...(withRecord ? [record] : []), ...rows, opening],
    });
  }

  test('warns that discarding leaves part of the import, and points to Undo import', async () => {
    const server = fakeServer();
    await heldImport(server, 2, false);
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const item = within(within(await dialog()).getByRole('listitem'));
    expect(
      item.getByText(
        'Part of this import is saved already. Discarding leaves that part in, without its opening balance change. To take the whole import back, use Undo import in Settings › Import and export.',
      ),
    ).toBeTruthy();
  });

  test('says nothing more when none of the import is saved yet', async () => {
    const server = fakeServer();
    await heldImport(server, 1, true);
    renderApp(server, '/?accounts', { size: 'phone' });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    const item = within(within(await dialog()).getByRole('listitem'));
    expect(item.getByText('Enter an amount')).toBeTruthy();
    expect(item.queryByText(/Part of this import/)).toBeNull();
  });
});
