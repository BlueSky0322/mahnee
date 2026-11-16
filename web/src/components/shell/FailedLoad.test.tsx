// @vitest-environment jsdom
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { fakeServer, goToPlace, renderApp, setupAppTests } from '../../testing/app';

// The first load of the accounts failing, with nothing kept on this device: the tab bar or
// sidebar still shows, so the places lead away, and a page opened from it says the accounts
// couldn't be loaded and offers to try again. Opening that page doesn't ask the server
// again by itself, so the places never drop behind "Loading your accounts" and back.

setupAppTests();

/** Requests for the accounts the app has made so far */
const accountReads = () =>
  vi.mocked(fetch).mock.calls.filter(([input]) => {
    const url = input instanceof Request ? input.url : input;
    return new URL(url, 'http://app').pathname === '/api/accounts';
  }).length;

/** The app's timeouts on a clock the test moves on, which still runs with real time */
function controlTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}
const moveOn = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

/** Notes each time the tab bar or sidebar leaves the page, however briefly */
function watchPlaces() {
  const dropped = { times: 0 };
  let shown = document.querySelector('nav[aria-label="Main"]') != null;
  const observer = new MutationObserver(() => {
    const now = document.querySelector('nav[aria-label="Main"]') != null;
    if (shown && !now) dropped.times++;
    shown = now;
  });
  observer.observe(document.body, { childList: true, subtree: true });
  onTestFinished(() => observer.disconnect());
  return dropped;
}

describe('the accounts failing to load the first time', () => {
  test.each(['phone', 'desktop'] as const)(
    'Accounts keeps the places and offers to try again, asking the server no more (%s)',
    async (size) => {
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
      server.pathsDown.add('/api/accounts');
      controlTimers();
      renderApp(server, '/', { size });
      // Home says so, with the places around it
      expect(await screen.findByText("Couldn't load your accounts.")).toBeTruthy();
      await screen.findByRole('navigation', { name: 'Main' });
      // The first read and its one retry
      expect(accountReads()).toBe(2);
      const dropped = watchPlaces();

      await goToPlace('Accounts');
      expect(await screen.findByRole('heading', { name: 'Accounts', level: 1 })).toBeTruthy();
      await moveOn(5000);
      // Still there, saying the same, and not loading again
      const places = screen.getByRole('navigation', { name: 'Main' });
      expect(within(places).getByRole('link', { name: 'Accounts' })).toBeTruthy();
      expect(screen.getByText("Couldn't load your accounts.")).toBeTruthy();
      expect(screen.queryByLabelText('Loading your accounts')).toBeNull();
      expect(dropped.times).toBe(0);
      expect(accountReads()).toBe(2);

      // Try again asks once more, and shows the accounts once the server answers
      server.pathsDown.delete('/api/accounts');
      await userEvent.setup().click(screen.getByRole('button', { name: 'Try again' }));
      expect(await screen.findByRole('link', { name: /^Wallet, Cash, 100\.00$/ })).toBeTruthy();
      expect(screen.getByRole('navigation', { name: 'Main' })).toBeTruthy();
      expect(dropped.times).toBe(0);
      expect(accountReads()).toBe(3);
    },
  );
});
