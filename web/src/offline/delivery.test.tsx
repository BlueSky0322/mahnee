// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get } from 'idb-keyval';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Account, ChangesBody } from '@shared/api';
import type { FakeServer } from '../testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from '../testing/app';
import { outboxKey } from './outbox';

// Changes made without a connection: shown at once, kept on the device through a reload,
// and saved once, in order, when the connection is back. Each page here is the whole app,
// against the stand-in server; a reload starts the app's code afresh, with only what the
// browser kept.

setupAppTests();

const RYAN = 'ryan@example.com';
const SIZES = ['desktop', 'phone'] as const;
const OFFLINE = "Offline. Changes are kept on this device and saved when you're back.";

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

const row = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name},`) });
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

/** Renames an account on its page, and goes back to Home */
async function rename(from: string, to: string) {
  const user = userEvent.setup();
  const form = await edit(from);
  await user.clear(form.getByLabelText('Name'));
  await user.type(form.getByLabelText('Name'), to);
  await user.click(form.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await user.click(screen.getByRole('button', { name: 'Home' }));
}

describe('changes made offline', () => {
  test.each(SIZES)(
    'show at once, stay through a reload, and are saved once when back (%s)',
    async (size) => {
      const server = fakeServer();
      seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
      renderApp(server, '/', { size });
      await row('Wallet');

      goOffline(server);
      await addAccount('Savings');
      expect(await row('Savings')).toBeTruthy();
      expect(await screen.findByText(`${OFFLINE} 1 change waiting.`)).toBeTruthy();
      await waitFor(async () => expect(await keptForRyan()).toHaveLength(1));

      // Reloaded while still offline: the page starts from what the device kept
      await reloadApp(server, '/', { size });
      expect(await row('Savings')).toBeTruthy();
      expect(await row('Wallet')).toBeTruthy();
      expect(await screen.findByText(`${OFFLINE} 1 change waiting.`)).toBeTruthy();
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
    15_000,
  );

  test('a change refused once back is put back, and explained', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server);
    await row('Wallet');
    goOffline(server);
    await rename('Wallet', 'Purse');
    await addAccount('Made on top');
    await reloadApp(server);
    expect(await row('Purse')).toBeTruthy();
    expect(await screen.findByText(`${OFFLINE} 2 changes waiting.`)).toBeTruthy();

    server.failNext.changes = { status: 409, error: 'Changed somewhere else at the same time.' };
    const back = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
    onTestFinished(() => back.mockRestore());
    server.health = 'up';
    act(() => void window.dispatchEvent(new Event('online')));

    expect(await screen.findByText('Changed somewhere else at the same time.')).toBeTruthy();
    expect(await row('Wallet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Purse,/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Made on top,/ })).toBeNull();
    expect(await keptForRyan()).toEqual([]);
    // Sent once, both together, and nothing after
    expect(requests()).toHaveLength(1);
    expect(server.accounts.map((a) => a.name)).toEqual(['Wallet']);
  });

  test('archiving and Undo offline are both kept, and saved in order', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    seed(server, { id: 'b'.repeat(16), name: 'Bank', kind: 'bank' });
    renderApp(server, '/', { size: 'phone' });
    const user = userEvent.setup();
    await row('Wallet');
    const back = goOffline(server);

    await user.click((await edit('Wallet')).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await user.click(screen.getByRole('button', { name: 'Home' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Wallet,/ })).toBeNull());
    await user.click(await screen.findByRole('button', { name: 'Undo' }));
    expect(await row('Wallet')).toBeTruthy();
    expect(await screen.findByText(`${OFFLINE} 2 changes waiting.`)).toBeTruthy();

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
    renderApp(server);
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
  test('says so, and still saves from the open page', async () => {
    const server = fakeServer();
    seed(server, { id: 'a'.repeat(16), name: 'Wallet' });
    renderApp(server);
    await row('Wallet');
    // Storage full, or blocked: every write fails
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    onTestFinished(() => put.mockRestore());
    const held = holdNext(server, 'POST', '/api/changes');
    await rename('Wallet', 'Purse');
    expect(
      await screen.findByText(
        "This device's storage is full or blocked. Keep the app open until your changes are saved. 1 change waiting.",
      ),
    ).toBeTruthy();
    held.release();
    await waitFor(() => expect(server.accounts[0].name).toBe('Purse'));
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
    renderApp(server);
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
    renderApp(server, '/', { size });
    const user = userEvent.setup();
    await row('Wallet');
    goOffline(server);
    await rename('Wallet', 'Purse');
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

  test('with nothing waiting, signs out straight away', async () => {
    const server = fakeServer();
    renderApp(server);
    await screen.findByText('Signed in as Ryan');
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
    renderApp(server);
    await row('Wallet');
    const back = goOffline(server);
    await addAccount("Ryan's savings");
    await waitFor(async () => expect(await keptForRyan()).toHaveLength(1));

    // Ann signs in on Ryan's device, online
    back();
    server.me = { ...server.me, email: 'ann@example.com', displayName: 'Ann' };
    await reloadApp(server);
    expect(await screen.findByText('Signed in as Ann')).toBeTruthy();
    expect(await row('Wallet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /^Ryan's savings,/ })).toBeNull();
    expect(screen.queryByRole('status')).toBeNull();
    // Only refused writes could have reached the server: none were sent as Ann
    expect(requests()).toEqual([]);
    expect(server.accounts.map((a) => a.name)).toEqual(['Wallet']);
    expect(await get(outboxKey(RYAN))).toMatchObject({ email: RYAN });

    // Ryan is back: his change goes, as him
    server.me = { ...server.me, email: RYAN, displayName: 'Ryan' };
    await reloadApp(server);
    expect(await row("Ryan's savings")).toBeTruthy();
    await waitFor(() => expect(server.accounts.map((a) => a.name)).toContain("Ryan's savings"));
    expect(await keptForRyan()).toEqual([]);
  });
});
