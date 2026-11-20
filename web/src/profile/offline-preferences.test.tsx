// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { clear, get, set } from 'idb-keyval';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { FakeServer } from '../testing/app';
import { fakeServer, reloadApp, renderApp, settle, setupAppTests } from '../testing/app';
import { LAST_EMAIL_KEY } from '../offline/cache';
import { PROFILE_OUTBOX_PREFIX } from './unsent';

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
  await waitFor(async () => expect(await startWith()).toEqual(ON_CATEGORY));
  // Still shown once the server's older copy and the held save have both answered
  await settle();
  expect(await startWith()).toEqual(ON_CATEGORY);
  back();
  await waitFor(() => expect(server.me.settings.startWith).toBe('category'), { timeout: 5000 });
});

const RYAN = 'ryan@example.com';
const keptPatch = async () =>
  (await get<{ email: string; value: unknown }>(`${PROFILE_OUTBOX_PREFIX}${RYAN}`))?.value;

test('two quick changes of different settings offline both survive a restart', async () => {
  const server = fakeServer();
  renderApp(server, '/?settings=look', { size: 'phone' });
  const look = within(await screen.findByRole('region', { name: 'Look and start' }));
  const back = goOffline(server);
  const user = userEvent.setup();
  // Both at once, without waiting for the first to be kept
  void user.click(look.getByRole('radio', { name: 'Dark' }));
  await user.click(look.getByRole('radio', { name: 'Essentials' }));
  await settle();
  expect(await keptPatch()).toEqual({ settings: { theme: 'dark', homeDensity: 'essentials' } });

  await reloadApp(server, '/?settings=look', { size: 'phone' });
  const again = within(await screen.findByRole('region', { name: 'Look and start' }));
  await waitFor(() =>
    expect(again.getByRole('radio', { name: 'Dark' }).getAttribute('aria-checked')).toBe('true'),
  );
  expect(again.getByRole('radio', { name: 'Essentials' }).getAttribute('aria-checked')).toBe(
    'true',
  );
  back();
  await waitFor(() =>
    expect(server.me.settings).toMatchObject({ theme: 'dark', homeDensity: 'essentials' }),
  );
}, 20_000);

test('a waiting change the server refuses lets that setting go, and saves the others', async () => {
  const server = fakeServer();
  // Kept from an earlier session: one setting the server won't take, one it will
  localStorage.setItem(LAST_EMAIL_KEY, RYAN);
  await set(`${PROFILE_OUTBOX_PREFIX}${RYAN}`, {
    email: RYAN,
    value: { settings: { startWith: 'category', weekStart: 9 } },
  });
  renderApp(server, '/?settings=adding', { size: 'phone' });
  await waitFor(() => expect(server.me.settings.startWith).toBe('category'), { timeout: 5000 });
  expect(server.me.settings.weekStart).not.toBe(9);
  await waitFor(async () => expect(await keptPatch()).toBeUndefined());
  expect(await screen.findByText(/Could not save your settings|Invalid weekStart/)).toBeTruthy();
}, 15_000);

describe('signing out with settings changed offline', () => {
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

  test.each(SIZES)('asks first, naming the settings that would be lost (%s)', async (size) => {
    const server = fakeServer();
    renderApp(server, '/?settings=adding', { size });
    const page = await adding();
    goOffline(server);
    const user = userEvent.setup();
    await user.click(page.getByRole('radio', { name: 'Category' }));
    await settle();
    await reloadApp(server, '/?settings', { size });
    const sentTo = watchLeaving();

    await user.click(await screen.findByRole('button', { name: 'Sign out' }));
    const asking = within(await screen.findByRole('dialog'));
    expect(
      asking.getByText(
        "Your change to Start with hasn't been saved yet. Signing out removes it from this device.",
      ),
    ).toBeTruthy();
    await user.click(asking.getByRole('button', { name: 'Stay signed in' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(sentTo).toEqual([]);
    expect(await keptPatch()).toEqual({ settings: { startWith: 'category' } });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sign out anyway' }),
    );
    await waitFor(() => expect(sentTo).toEqual(['/cdn-cgi/access/logout']));
    expect(await keptPatch()).toBeUndefined();
  });
});

test('a save still on its way when the connection drops never wins over a newer change kept offline', async () => {
  const server = fakeServer();
  renderApp(server, '/?settings=adding', { size: 'phone' });
  const page = await adding();
  // The first save of the profile gets no answer until the connection has dropped
  const answer = vi.mocked(fetch).getMockImplementation()!;
  let dropA: (err: Error) => void = () => {};
  let held = false;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (!held && input === '/api/me' && init?.method === 'PATCH') {
      held = true;
      return new Promise((_, reject) => {
        dropA = reject;
      });
    }
    return answer(input, init);
  });
  const user = userEvent.setup();
  await user.click(page.getByRole('radio', { name: 'Category' }));
  await waitFor(() => expect(held).toBe(true));

  const back = goOffline(server);
  await user.click(page.getByRole('radio', { name: 'Amount' }));
  await settle();
  dropA(new TypeError('Failed to fetch'));
  await settle();
  expect(await keptPatch()).toEqual({ settings: { startWith: 'amount' } });

  back();
  await waitFor(() => expect(server.me.settings.startWith).toBe('amount'), { timeout: 5000 });
  expect(await startWith()).toEqual([
    ['Amount', 'true'],
    ['Category', 'false'],
  ]);
}, 15_000);
