// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, test, vi } from 'vitest';
import type { StartScreen } from '@shared/api';
import type { FakeServer } from '../testing/app';
import {
  fakeServer,
  goToPlace,
  openSettings,
  reloadApp,
  renderApp,
  settle,
  setupAppTests,
} from '../testing/app';
import { SESSION_KEY, openStartScreen } from './useRoute';

// "Open the app on" (R-Set-Look; owner decision D15): a fresh start at the app's own
// address (the installed app's icon, or typing the address) opens on Home, Activity or
// Plan, as the person chose. It replaces reopening the last page. A reload, or a link to a
// particular page, keeps its own address. The choice kept on the device is that account's
// alone: someone else signing in on it lands on their own choice, never the last person's.

setupAppTests();

function withWallet(start: StartScreen): FakeServer {
  const server = fakeServer();
  server.me.settings.startScreen = start;
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

/** The app closed, then started afresh at `path`, as tapping its icon does */
async function freshStart(server: FakeServer, path = '/') {
  sessionStorage.clear();
  window.history.replaceState(null, '', path);
  openStartScreen();
  const opened = `${window.location.pathname}${window.location.search}`;
  await reloadApp(server, opened, { size: 'phone' });
  return window.location.search;
}

/** Each place's own heading, as it's drawn */
const PLACE_HEADINGS = { activity: 'Activity', plan: 'Plan' } as const;

/** The app used once (so it knows the person's choice), then closed */
async function usedOnce(server: FakeServer) {
  renderApp(server, '/', { size: 'phone' });
  await screen.findByRole('link', { name: 'You and settings' });
  await settle();
}

/** Signs out with Settings' own Sign out button; the browser is sent to Access's sign-out */
async function signOutForReal() {
  await openSettings();
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
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  const asking = screen.queryByRole('dialog');
  if (asking != null) {
    await user.click(within(asking).getByRole('button', { name: /^Sign out/ }));
  }
  await waitFor(() => expect(sentTo).toEqual(['/cdn-cgi/access/logout']));
  // The page is gone with the sign-out; the browser's own location again
  vi.unstubAllGlobals();
}

describe('a fresh start', () => {
  test.each(['activity', 'plan'] as const)('opens on %s when that is chosen', async (start) => {
    const server = withWallet(start);
    await usedOnce(server);
    expect(await freshStart(server)).toBe(`?${start}`);
    expect(
      await screen.findByRole('heading', { name: PLACE_HEADINGS[start], level: 1 }),
    ).toBeTruthy();
  });

  test('opens on Home when Home is chosen, not on the page open last time', async () => {
    const server = withWallet('home');
    await usedOnce(server);
    await goToPlace('Activity');
    await screen.findByRole('heading', { name: 'Activity', level: 1 });
    await settle();
    expect(await freshStart(server)).toBe('');
    expect(await screen.findByRole('link', { name: 'You and settings' })).toBeTruthy();
  });

  test('a link to a page keeps it', async () => {
    const server = withWallet('plan');
    await usedOnce(server);
    expect(await freshStart(server, '/?accounts')).toBe('?accounts');
  });

  test('a reload keeps the page it was on', async () => {
    const server = withWallet('plan');
    await usedOnce(server);
    // Not afresh: this tab has started before
    sessionStorage.setItem(SESSION_KEY, '1');
    window.history.replaceState(null, '', '/');
    openStartScreen();
    expect(window.location.search).toBe('');
  });

  test('a choice changed opens the new place next time', async () => {
    const server = withWallet('home');
    await usedOnce(server);
    server.me.settings.startScreen = 'activity';
    // Changed on another device: this one learns it the next time it starts
    await freshStart(server);
    await settle();
    expect(await freshStart(server)).toBe('?activity');
  });

  test('offline, the choice kept on this device is used', async () => {
    const server = withWallet('plan');
    await usedOnce(server);
    server.health = 'unreachable';
    expect(await freshStart(server)).toBe('?plan');
  });

  test("after Sign out, nobody's choice is kept: the next start opens on Home", async () => {
    const server = withWallet('plan');
    await usedOnce(server);
    await signOutForReal();
    expect(await freshStart(server)).toBe('');
  });

  test("someone else signing in on this device lands on their own choice, never the last person's", async () => {
    const server = withWallet('plan');
    await usedOnce(server);
    // Ann signs in here next, having chosen Activity elsewhere
    server.me = {
      ...server.me,
      email: 'ann@example.com',
      displayName: 'Ann',
      settings: { ...server.me.settings, startScreen: 'activity' },
    };
    await freshStart(server);
    await waitFor(() => expect(window.location.search).toBe('?activity'));
    expect(await screen.findByRole('heading', { name: 'Activity', level: 1 })).toBeTruthy();
    await settle();
    // And her own choice the start after
    expect(await freshStart(server)).toBe('?activity');
  });

  test('with nothing kept yet, the first start opens on Home, then their choice once known', async () => {
    expect(await freshStart(withWallet('activity'))).toBe('');
    await waitFor(() => expect(window.location.search).toBe('?activity'));
  });

  test('once known, a fresh start that has moved on is left where the person went', async () => {
    const server = withWallet('activity');
    // Nothing kept yet, and the server slow to say who's signed in
    sessionStorage.clear();
    window.history.replaceState(null, '', '/');
    openStartScreen();
    renderApp(server, '/?accounts', { size: 'phone' });
    await settle();
    expect(window.location.search).toBe('?accounts');
  });
});
