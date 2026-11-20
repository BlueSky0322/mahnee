// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clear } from 'idb-keyval';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { FakeServer } from '../testing/app';
import { fakeServer, reloadApp, renderApp, settle, setupAppTests } from '../testing/app';

// Preferences changed without a connection: shown at once and kept on the device for the
// account they were made as, still there after the app is closed and opened again offline,
// and saved once the connection is back, so another device signed in as them sees them.
// One saved while online is kept on the device too, so opening the app offline later never
// shows the setting as it was before.

setupAppTests();

const SIZES = ['phone', 'desktop'] as const;

function goOffline(server: FakeServer) {
  server.health = 'unreachable';
  const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  onTestFinished(() => onLine.mockRestore());
  act(() => void window.dispatchEvent(new Event('offline')));
  return () => {
    server.health = 'up';
    onLine.mockReturnValue(true);
    act(() => void window.dispatchEvent(new Event('online')));
  };
}

/** Adding entries at its own address, once drawn */
async function adding() {
  await screen.findByRole('heading', { name: 'Adding entries', level: 1 });
  return within(await screen.findByRole('region', { name: 'Adding entries' }));
}

const startWith = async () =>
  within((await adding()).getByRole('radiogroup', { name: 'Start with' }))
    .getAllByRole('radio')
    .map((r) => [r.textContent, r.getAttribute('aria-checked')]);

const ON_CATEGORY = [
  ['Amount', 'false'],
  ['Category', 'true'],
];

describe.each(SIZES)('preferences without a connection (%s)', (size) => {
  test('kept through a restart offline, saved once back, and seen on another device', async () => {
    const server = fakeServer();
    renderApp(server, '/?settings=adding', { size });
    const page = await adding();
    const back = goOffline(server);

    await userEvent.setup().click(page.getByRole('radio', { name: 'Category' }));
    expect(await startWith()).toEqual(ON_CATEGORY);
    await settle();
    // Nothing went wrong: it's kept, not put back
    expect(screen.queryByText(/Could not save|Something went wrong/)).toBeNull();
    expect(await startWith()).toEqual(ON_CATEGORY);
    expect(server.me.settings.startWith).toBe('amount');

    // Closed and opened again, still offline
    await reloadApp(server, '/?settings=adding', { size });
    await waitFor(async () => expect(await startWith()).toEqual(ON_CATEGORY));
    expect(server.me.settings.startWith).toBe('amount');

    back();
    await waitFor(() => expect(server.me.settings.startWith).toBe('category'), { timeout: 5000 });
    expect(await startWith()).toEqual(ON_CATEGORY);

    // Another device, with nothing kept, signed in as the same person
    await clear();
    localStorage.clear();
    await reloadApp(server, '/?settings=adding', { size });
    await waitFor(async () => expect(await startWith()).toEqual(ON_CATEGORY));
  }, 20_000);
});

test('a preference saved online shows when the app is next opened offline', async () => {
  const server = fakeServer();
  renderApp(server, '/?settings=adding', { size: 'phone' });
  const page = await adding();
  await userEvent.setup().click(page.getByRole('radio', { name: 'Category' }));
  await waitFor(() => expect(server.me.settings.startWith).toBe('category'));
  await settle();

  goOffline(server);
  await reloadApp(server, '/?settings=adding', { size: 'phone' });
  await waitFor(async () => expect(await startWith()).toEqual(ON_CATEGORY));
});

test('an older profile from the server never replaces a preference still to send', async () => {
  const server = fakeServer();
  renderApp(server, '/?settings=adding', { size: 'phone' });
  const page = await adding();
  const back = goOffline(server);
  await userEvent.setup().click(page.getByRole('radio', { name: 'Category' }));
  await settle();

  // Opened again with the server answering, but the save of the preference held back
  server.health = 'up';
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  server.failNext.profile = 503;
  await reloadApp(server, '/?settings=adding', { size: 'phone' });
  await settle();
  expect(await startWith()).toEqual(ON_CATEGORY);
  back();
  await waitFor(() => expect(server.me.settings.startWith).toBe('category'), { timeout: 5000 });
});
