// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import { describe, expect, test, vi } from 'vitest';
import type { FakeServer } from '../testing/app';
import { fakeServer, holdNext, reloadApp, renderApp, setupAppTests } from '../testing/app';
import { queryClient } from '../query-client';

// The first read of the balances names the changes waiting on the device, so the server
// can say which it holds already (double-count.test.tsx). Learning those never holds the
// read up for long, and never leaves it waiting for good when the server won't say who's
// signed in.

setupAppTests();

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
const asked = (path: string) =>
  vi.mocked(fetch).mock.calls.some(([url]) => typeof url === 'string' && url.startsWith(path));

/** Nothing is left loading: no read waits for good */
const nothingLoading = () =>
  vi.waitFor(() => expect(queryClient.isFetching()).toBe(0), { timeout: 4000 });

/** Home seen once with a connection, so this device keeps the profile and the balances */
async function seenOnce(server: FakeServer) {
  renderApp(server);
  await wallet();
  await act(() => new Promise((r) => setTimeout(r, 100)));
}

describe('the first read of the balances', () => {
  test('is asked for while the server is slow to say who is signed in', async () => {
    const server = withWallet();
    const me = holdNext(server, 'GET', '/api/me');
    try {
      renderApp(server);
      await vi.waitFor(() => expect(asked('/api/accounts')).toBe(true), { timeout: 4000 });
      expect(asked('/api/me')).toBe(true);
    } finally {
      me.release();
    }
    expect(await wallet()).toBeTruthy();
  });

  test('signed out with nothing kept here: says so, and nothing waits for good', async () => {
    const server = withWallet();
    server.health = 'signedOut';
    renderApp(server);
    expect(await screen.findByText("You're signed out")).toBeTruthy();
    await nothingLoading();
  });

  test('signed out with the balances kept here: shows them, and nothing waits for good', async () => {
    const server = withWallet();
    await seenOnce(server);
    server.health = 'signedOut';
    await reloadApp(server);
    expect(
      await screen.findByText('Signed out. Sign in again to see what has changed.'),
    ).toBeTruthy();
    expect(await wallet()).toBeTruthy();
    await nothingLoading();
  });
});
