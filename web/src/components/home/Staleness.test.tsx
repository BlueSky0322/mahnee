// @vitest-environment jsdom
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { FakeServer } from '../../testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from '../../testing/app';

// How old the numbers on Home are, said only when they came from the copy kept on this
// device (offline, or the server hasn't answered yet): "Updated 2 hours ago". What the
// server has just sent says nothing.

setupAppTests();

const SIZES = ['desktop', 'phone'] as const;
const HOUR_MS = 60 * 60 * 1000;

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

const wallet = () => screen.findByRole('button', { name: /^Wallet, Cash, RM 100\.00$/ });
const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

/** The clock the app reads, which the test moves on; it still ticks with real time */
function controlClock() {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date());
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

/** Home opened once with a connection, so this device keeps what it showed */
async function seenOnce(server: FakeServer, size: (typeof SIZES)[number]) {
  renderApp(server, '/', { size });
  await wallet();
  // What's kept on the device is written just after it's shown
  await wait(100);
}

describe('how old the numbers on Home are', () => {
  test.each(SIZES)('fresh from the server, nothing is said (%s)', async (size) => {
    const server = withWallet();
    renderApp(server, '/', { size });
    await wallet();
    await wait(100);
    expect(screen.queryByText(/Updated /)).toBeNull();
  });

  test.each(SIZES)(
    'opened offline, it says when the server last confirmed them (%s)',
    async (size) => {
      const server = withWallet();
      const moveOn = controlClock();
      await seenOnce(server, size);

      moveOn(2 * HOUR_MS);
      const back = goOffline(server);
      await reloadApp(server, '/', { size });
      await wallet();
      expect(await screen.findByText('Updated 2 hours ago')).toBeTruthy();

      // Back online, fresh from the server: nothing is said
      back();
      await waitFor(() => expect(screen.queryByText(/Updated /)).toBeNull());
      expect(await wallet()).toBeTruthy();
    },
    15_000,
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
        expect(await screen.findByText('Updated 2 hours ago')).toBeTruthy();
      } finally {
        accounts.release();
      }
      await waitFor(() => expect(screen.queryByText(/Updated /)).toBeNull());
      expect(await wallet()).toBeTruthy();
    },
    15_000,
  );
});
