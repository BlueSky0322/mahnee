// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { OPENED_FROM_DEVICE } from '../../offline/cache';
import type { FakeServer } from '../../testing/app';
import {
  OFFLINE_NOTICE,
  fakeServer,
  goToPlace,
  holdNext,
  reloadApp,
  renderApp,
  setupAppTests,
} from '../../testing/app';

// How fresh the figures are, always said: "Up to date" once the server has confirmed them
// and nothing is waiting; "From this device, 2 h old" while they come from the copy kept
// on this device; "Offline · 1 change waiting to save" while changes wait without a
// connection. It sits under the title on Home on phones and tablets, in the sidebar on a
// computer, and at the foot of Settings ("Mahnee · Up to date"). On a phone's or tablet's
// other pages, and on Settings' own pages, it shows whenever it isn't "Up to date", so
// changes waiting are never out of sight. Being offline also shows the offline notice:
// "Offline. Your changes are kept on this phone."

setupAppTests();

type Size = 'desktop' | 'tablet' | 'phone';
const SIZES = ['desktop', 'phone'] as const;
const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
/** Every label the app can show, and nothing else (the notices start alike) */
const LABEL =
  /^(Up to date|From this device(, .+ old)?|Offline|Offline · \d+ changes? waiting to save|Saving \d+ changes?|Signed out · \d+ changes? waiting to save)$/;

function withWallet() {
  const server = fakeServer();
  server.accounts.push({
    id: 'a'.repeat(16),
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 10_000,
    position: 0,
    archived: false,
  });
  return server;
}

/**
 * The figures are showing: the Wallet's row on Accounts, or Home's month end, which with
 * the one account and nothing due names it ("Wallet today", else "RM 100.00 today"), or for
 * an earlier month says what it left
 */
const wallet = () =>
  waitFor(
    () =>
      screen.queryByRole('link', { name: /^Wallet, Cash, 100\.00$/ }) ??
      screen.queryByText(/^(Wallet|RM [\d,.]+) today$/) ??
      screen.getByText(/^Left in /),
  );
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

/**
 * The clock the app reads, from a fixed morning in the middle of a month (November 10,
 * 2026, 9:00 here), which the test moves on; it still ticks with real time
 */
function controlClock(fake: ('Date' | 'setInterval' | 'clearInterval')[] = ['Date']) {
  vi.useFakeTimers({ toFake: fake, shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 10, 9, 0));
  onTestFinished(() => {
    vi.useRealTimers();
  });
  return (ms: number) => vi.setSystemTime(Date.now() + ms);
}

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

/** `path` opened once with a connection, so this device keeps what it showed */
async function seenOnce(server: FakeServer, size: Size, path = '/') {
  renderApp(server, path, { size });
  await wallet();
  // What's kept on the device is written just after it's shown
  await wait(100);
}

/** Where the label is drawn: under Home's title on phones, in the sidebar on a computer */
function labelArea(size: Size) {
  if (size === 'desktop') return within(screen.getByRole('complementary'));
  const title = screen.getByRole('heading', { level: 1 });
  return within(title.closest('header')!);
}

/** Every freshness label on the page, by its text */
const labels = () =>
  screen.queryAllByText(LABEL).map((el) => el.textContent?.replace(/\s+/g, ' ').trim());

/** Adds an account on Accounts, where they're listed, and comes back to Home */
async function addAccount(name: string) {
  const user = userEvent.setup();
  await goToPlace('Accounts');
  await user.click((await screen.findAllByRole('button', { name: 'Add account' }))[0]);
  const form = within(await screen.findByRole('dialog'));
  await user.type(form.getByLabelText('Name'), name);
  await user.click(form.getByRole('button', { name: 'Add account' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await goToPlace('Home');
}

describe('how fresh the figures are', () => {
  test.each(['desktop', 'tablet', 'phone'] as const)(
    'fresh from the server, it says "Up to date", once, where it belongs (%s)',
    async (size) => {
      const server = withWallet();
      renderApp(server, '/', { size });
      await wallet();
      await wait(100);
      expect(labelArea(size).getByText('Up to date')).toBeTruthy();
      expect(labels()).toEqual(['Up to date']);
      if (size === 'desktop') {
        // A computer's Home leaves it to the sidebar
        expect(within(screen.getByRole('main')).queryByText('Up to date')).toBeNull();
      }
    },
  );

  test('nothing is said while the figures load for the first time', async () => {
    const server = withWallet();
    const accounts = holdNext(server, 'GET', '/api/accounts');
    renderApp(server, '/', { size: 'phone' });
    try {
      await screen.findByRole('heading', { level: 1 });
      await wait(200);
      expect(labels()).toEqual([]);
    } finally {
      accounts.release();
    }
    await wallet();
    expect(await labelArea('phone').findByText('Up to date')).toBeTruthy();
  });

  test.each(SIZES)(
    'opened offline, it says the figures are from this device and how old (%s)',
    async (size) => {
      const server = withWallet();
      const moveOn = controlClock();
      await seenOnce(server, size);

      moveOn(2 * HOUR_MS);
      const back = goOffline(server);
      await reloadApp(server, '/', { size });
      await wallet();
      expect(await labelArea(size).findByText('From this device, 2 h old')).toBeTruthy();
      expect(labels()).toEqual(['From this device, 2 h old']);

      // Back online, fresh from the server
      back();
      expect(await labelArea(size).findByText('Up to date')).toBeTruthy();
      expect(labels()).toEqual(['Up to date']);
      expect(await wallet()).toBeTruthy();
    },
  );

  test.each(SIZES)(
    'while the server has not answered yet, it says so until it does (%s)',
    async (size) => {
      const server = withWallet();
      const moveOn = controlClock();
      await seenOnce(server, size);

      moveOn(2 * HOUR_MS);
      const accounts = holdNext(server, 'GET', '/api/accounts');
      try {
        await reloadApp(server, '/', { size });
        await wallet();
        expect(await labelArea(size).findByText('From this device, 2 h old')).toBeTruthy();
        expect(labels()).toEqual(['From this device, 2 h old']);
      } finally {
        accounts.release();
      }
      expect(await labelArea(size).findByText('Up to date')).toBeTruthy();
      expect(labels()).toEqual(['Up to date']);
    },
  );

  test('a page left open says the copy is older as time passes', async () => {
    const server = withWallet();
    const moveOn = controlClock(['Date', 'setInterval', 'clearInterval']);
    await seenOnce(server, 'phone');

    moveOn(5 * MINUTE_MS);
    goOffline(server);
    await reloadApp(server, '/', { size: 'phone' });
    await wallet();
    expect(await labelArea('phone').findByText('From this device, 5 min old')).toBeTruthy();
    // A minute on, with no reload
    act(() => void vi.advanceTimersByTime(MINUTE_MS));
    expect(await labelArea('phone').findByText('From this device, 6 min old')).toBeTruthy();
  });

  test('the age is the older of the balances and the month shown', async () => {
    const server = withWallet();
    const moveOn = controlClock();
    await seenOnce(server, 'phone');
    // Two hours on, the balances are seen again on Accounts; the month isn't
    moveOn(2 * HOUR_MS);
    await reloadApp(server, '/?accounts', { size: 'phone' });
    await wallet();
    await wait(100);

    moveOn(HOUR_MS);
    goOffline(server);
    await reloadApp(server, '/', { size: 'phone' });
    await wallet();
    expect(await labelArea('phone').findByText('From this device, 3 h old')).toBeTruthy();
  });

  test("an earlier month on Home is judged by that month's copy, other pages by the balances", async () => {
    const server = withWallet();
    const moveOn = controlClock();
    await seenOnce(server, 'desktop');
    // An hour on, October is seen once, and the balances with it
    moveOn(HOUR_MS);
    await reloadApp(server, '/?month=2026-10', { size: 'desktop' });
    await wallet();
    await wait(100);

    moveOn(HOUR_MS);
    goOffline(server);
    await reloadApp(server, '/', { size: 'desktop' });
    await wallet();
    // November was last confirmed two hours ago
    expect(await labelArea('desktop').findByText('From this device, 2 h old')).toBeTruthy();

    await reloadApp(server, '/?month=2026-10', { size: 'desktop' });
    await wallet();
    expect(await labelArea('desktop').findByText('From this device, 1 h old')).toBeTruthy();

    // Activity shows no month's totals: the balances' age
    await goToPlace('Activity');
    expect(await labelArea('desktop').findByText('From this device, 1 h old')).toBeTruthy();
  });

  test.each(SIZES)(
    'offline with changes waiting, it says how many are waiting to save (%s)',
    async (size) => {
      const server = withWallet();
      renderApp(server, '/', { size });
      await wallet();
      const back = goOffline(server);

      await addAccount('Savings');
      expect(await labelArea(size).findByText('Offline · 1 change waiting to save')).toBeTruthy();
      await addAccount('Purse');
      expect(await labelArea(size).findByText('Offline · 2 changes waiting to save')).toBeTruthy();
      expect(labels()).toEqual(['Offline · 2 changes waiting to save']);

      // Back online, both are saved, and the figures are the server's again
      back();
      expect(await labelArea(size).findByText('Up to date', {}, { timeout: 5000 })).toBeTruthy();
      expect(server.accounts.map((a) => a.name)).toEqual(['Wallet', 'Savings', 'Purse']);
    },
  );

  test('offline with a copy from the device and a change waiting, the count wins', async () => {
    const server = withWallet();
    const moveOn = controlClock();
    await seenOnce(server, 'phone');
    moveOn(2 * HOUR_MS);
    goOffline(server);
    await reloadApp(server, '/', { size: 'phone' });
    await wallet();
    expect(await labelArea('phone').findByText('From this device, 2 h old')).toBeTruthy();
    await addAccount('Savings');
    expect(await labelArea('phone').findByText('Offline · 1 change waiting to save')).toBeTruthy();
    expect(labels()).toEqual(['Offline · 1 change waiting to save']);
  });

  test.each(SIZES)(
    'offline with nothing waiting and the figures fetched before, it says "Offline" (%s)',
    async (size) => {
      const server = withWallet();
      renderApp(server, '/', { size });
      await wallet();
      await wait(100);
      goOffline(server);
      expect(await labelArea(size).findByText('Offline')).toBeTruthy();
      expect(labels()).toEqual(['Offline']);
    },
  );

  test.each(SIZES)('online while changes are being saved, it says so (%s)', async (size) => {
    const server = withWallet();
    renderApp(server, '/', { size });
    await wallet();
    const held = holdNext(server, 'POST', '/api/changes');
    try {
      await addAccount('Savings');
      expect(await labelArea(size).findByText('Saving 1 change')).toBeTruthy();
      // The second waits behind the first
      await addAccount('Purse');
      expect(await labelArea(size).findByText('Saving 2 changes')).toBeTruthy();
      expect(labels()).toEqual(['Saving 2 changes']);
    } finally {
      held.release();
    }
    expect(await labelArea(size).findByText('Up to date', {}, { timeout: 5000 })).toBeTruthy();
    expect(server.accounts.map((a) => a.name)).toEqual(['Wallet', 'Savings', 'Purse']);
  });

  test("online but the server failing, a change waits and the figures stay the device's", async () => {
    const server = withWallet();
    const moveOn = controlClock();
    await seenOnce(server, 'phone');
    moveOn(2 * HOUR_MS);
    server.health = 'down';
    // The page itself comes from the device, as the service worker opens it then
    const mark = document.createElement('meta');
    mark.name = OPENED_FROM_DEVICE;
    mark.content = 'true';
    document.head.append(mark);
    onTestFinished(() => mark.remove());
    await reloadApp(server, '/', { size: 'phone' });
    await wallet();
    expect(await labelArea('phone').findByText('From this device, 2 h old')).toBeTruthy();
    await addAccount('Savings');
    await wait(300);
    // Nothing is being saved while the server fails
    expect(labels()).toEqual(['From this device, 2 h old']);
  });

  test('signed out with changes waiting, it says they wait', async () => {
    const server = withWallet();
    renderApp(server, '/', { size: 'phone' });
    await wallet();
    server.health = 'signedOut';
    await addAccount('Savings');
    expect(
      await labelArea('phone').findByText('Signed out · 1 change waiting to save'),
    ).toBeTruthy();
    await addAccount('Purse');
    expect(
      await labelArea('phone').findByText('Signed out · 2 changes waiting to save'),
    ).toBeTruthy();
    expect(labels()).toEqual(['Signed out · 2 changes waiting to save']);
  });

  test.each(['desktop', 'tablet', 'phone'] as const)(
    'Settings ends with "Mahnee · Up to date" (%s)',
    async (size) => {
      const server = withWallet();
      renderApp(server, '/?settings', { size });
      expect(await screen.findByText('Mahnee · Up to date')).toBeTruthy();
    },
  );

  test.each(SIZES)('Settings says so too while changes wait offline (%s)', async (size) => {
    const server = withWallet();
    renderApp(server, '/', { size });
    await wallet();
    goOffline(server);
    await addAccount('Savings');
    await reloadApp(server, '/?settings', { size });
    expect(await screen.findByText('Mahnee · Offline · 1 change waiting to save')).toBeTruthy();
  });

  test("a computer's Settings pages end with it too", async () => {
    const server = withWallet();
    renderApp(server, '/?settings=categories', { size: 'desktop' });
    expect(await screen.findByText('Mahnee · Up to date')).toBeTruthy();
  });

  // Opened at its own size: a reload keeps the first render's screen width
  test("a phone's Settings pages say it only when not up to date", async () => {
    const server = withWallet();
    renderApp(server, '/?settings=categories', { size: 'phone' });
    await screen.findByRole('heading', { name: 'Categories', level: 1 });
    await wait(200);
    expect(screen.queryByText(/^Mahnee · /)).toBeNull();
    goOffline(server);
    expect(await screen.findByText('Mahnee · Offline')).toBeTruthy();
  });
});

describe("a phone's other pages", () => {
  test.each(['phone', 'tablet'] as const)(
    'say nothing while up to date, and the count while changes wait (%s)',
    async (size) => {
      const server = withWallet();
      renderApp(server, '/', { size });
      await wallet();
      await goToPlace('Accounts');
      await wallet();
      await wait(100);
      expect(labels()).toEqual([]);

      goOffline(server);
      await addAccount('Savings');
      expect(await screen.findByText('Offline · 1 change waiting to save')).toBeTruthy();
      expect(labels()).toEqual(['Offline · 1 change waiting to save']);

      await goToPlace('Activity');
      expect(await screen.findByText('Offline · 1 change waiting to save')).toBeTruthy();
      await goToPlace('Plan');
      expect(await screen.findByText('Offline · 1 change waiting to save')).toBeTruthy();
    },
  );
});

describe('the offline notice', () => {
  test.each(['phone', 'tablet', 'desktop'] as const)(
    'on a %s it names the device, and leaves the count to the label',
    async (size) => {
      const text = OFFLINE_NOTICE[size];
      const server = withWallet();
      renderApp(server, '/', { size });
      await wallet();
      goOffline(server);
      const notice = await screen.findByRole('status');
      expect(notice.textContent?.trim()).toBe(text);

      await addAccount('Savings');
      // The count is the label's to say; the notice adds what happens once back (this
      // browser has no Background Sync)
      expect(await screen.findByText('Offline · 1 change waiting to save')).toBeTruthy();
      await waitFor(async () =>
        expect((await screen.findByRole('status')).textContent?.trim()).toBe(
          `${text}Open Mahnee when connected to finish syncing.`,
        ),
      );
    },
  );
});

describe('the undo toast', () => {
  /** Archives the wallet from its page, which offers Undo */
  async function archiveWallet(size: (typeof SIZES)[number]) {
    const server = withWallet();
    renderApp(server, '/?accounts', { size });
    const user = userEvent.setup(
      vi.isFakeTimers() ? { advanceTimers: vi.advanceTimersByTime } : undefined,
    );
    await user.click(await wallet());
    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Archive' }),
    );
    await waitFor(() => expect(server.accounts[0].archived).toBe(true));
    return { server, user };
  }

  test.each(SIZES)(
    'is announced, with Undo its only button, from the keyboard too (%s)',
    async (size) => {
      const { server, user } = await archiveWallet(size);
      const toast = await screen.findByRole('alert');
      expect(within(toast).getByText('Archived Wallet')).toBeTruthy();
      expect(
        within(toast)
          .getAllByRole('button')
          .map((b) => b.textContent),
      ).toEqual(['Undo']);
      within(toast).getByRole('button', { name: 'Undo' }).focus();
      await user.keyboard('{Enter}');
      await waitFor(() => expect(server.accounts[0].archived).toBe(false));
      await waitFor(() => expect(screen.queryByText('Archived Wallet')).toBeNull());
    },
  );

  test.each(SIZES)(
    'keeps focus on Undo once reached, while the dialog is still closing (%s)',
    async (size) => {
      const server = withWallet();
      renderApp(server, '/?accounts', { size });
      const user = userEvent.setup();
      await user.click(await wallet());
      await user.click(await screen.findByRole('button', { name: 'Edit' }));
      const archive = within(await screen.findByRole('dialog')).getByRole('button', {
        name: 'Archive',
      });
      // Undo is reached the moment the toast shows, before the closing dialog has
      // handed focus back to Edit
      act(() => archive.click());
      const undo = within(screen.getByRole('alert')).getByRole('button', { name: 'Undo' });
      undo.focus();
      await wait(100);
      expect(document.activeElement).toBe(undo);
      await user.keyboard('{Enter}');
      await waitFor(() => expect(server.accounts[0].archived).toBe(false));
      // Enter undid the archive; it didn't open the dialog again
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    },
  );

  test.each(SIZES)(
    'leaves focus on Edit once the dialog closes, when nothing else took it (%s)',
    async (size) => {
      await archiveWallet(size);
      await screen.findByRole('alert');
      await waitFor(() =>
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Edit' })),
      );
    },
  );

  test('goes away by itself after 6 seconds, not before', async () => {
    // The clock runs, but the seconds the message stays can be skipped
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
    onTestFinished(() => void vi.useRealTimers());
    await archiveWallet('phone');
    expect(await screen.findByText('Archived Wallet')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText('Archived Wallet')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(1000));
    await waitFor(() => expect(screen.queryByText('Archived Wallet')).toBeNull(), {
      timeout: 2500,
    });
  });

  test('a refusal keeps its close button', async () => {
    const server = withWallet();
    renderApp(server, '/', { size: 'phone' });
    await wallet();
    server.failNext.changes = { status: 409, error: 'Changed somewhere else at the same time.' };
    await addAccount('Savings');
    const message = await screen.findByText('Changed somewhere else at the same time.');
    const toast = message.closest('[role="alert"]') as HTMLElement;
    expect(within(toast).getAllByRole('button')).toHaveLength(1);
    expect(within(toast).queryByRole('button', { name: 'Undo' })).toBeNull();
  });
});
