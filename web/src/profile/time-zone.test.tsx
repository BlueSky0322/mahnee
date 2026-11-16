// @vitest-environment jsdom
import { screen, waitFor } from '@testing-library/react';
import { set } from 'idb-keyval';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { LAST_EMAIL_KEY, OPENED_FROM_DEVICE } from '../offline/cache';
import {
  type FakeServer,
  fakeServer,
  reloadApp,
  renderApp,
  settle,
  setupAppTests,
} from '../testing/app';

// The server needs the person's own day (for scheduled entries added at their midnight,
// and reminders at their time), and only the device knows its time zone: the app sends
// it with the settings each time it starts, whenever it isn't the one saved. It sends it
// only once the server has said who's signed in, never from the copy kept on the device.

setupAppTests();

const WAIT = { timeout: 3000 };

/** The device says it's in `zone` */
function deviceIn(zone: string | undefined) {
  const real = Object.getOwnPropertyDescriptor(Intl.DateTimeFormat.prototype, 'resolvedOptions')!
    .value as (this: Intl.DateTimeFormat) => Intl.ResolvedDateTimeFormatOptions;
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (
    this: Intl.DateTimeFormat,
  ) {
    return { ...real.call(this), timeZone: zone as string };
  });
}
afterEach(() => vi.restoreAllMocks());

/** Every profile save the app has sent, as sent */
const profileSaves = () =>
  vi
    .mocked(fetch)
    .mock.calls.filter(([url, init]) => url === '/api/me' && init?.method === 'PATCH')
    .map(([, init]) => JSON.parse(init?.body as string) as unknown);

/** The app open on Home, with everything it set going at start finished */
async function started() {
  await screen.findByRole('button', { name: 'Add account' }, WAIT);
  await settle();
}

/** The page as the service worker sends it from its copy, with Ryan's profile kept */
async function openedFromDevice(server: FakeServer, kept: unknown = server.me) {
  localStorage.setItem(LAST_EMAIL_KEY, server.me.email);
  await set('me-v2', { email: server.me.email, value: kept });
  const meta = document.createElement('meta');
  meta.name = OPENED_FROM_DEVICE;
  meta.content = 'true';
  document.head.append(meta);
  return () => meta.remove();
}

describe("the device's time zone", () => {
  test('is saved at start when the account has none', async () => {
    deviceIn('Asia/Kathmandu');
    const server = fakeServer();
    server.me.settings.timeZone = null;
    renderApp(server);
    await waitFor(() => expect(server.me.settings.timeZone).toBe('Asia/Kathmandu'), WAIT);
    await started();
    expect(profileSaves()).toEqual([{ settings: { timeZone: 'Asia/Kathmandu' } }]);
  });

  test('replaces the saved one when the device is somewhere else now', async () => {
    deviceIn('Europe/London');
    const server = fakeServer();
    server.me.settings.timeZone = 'Asia/Kuala_Lumpur';
    renderApp(server, '/', { size: 'phone' });
    await waitFor(() => expect(server.me.settings.timeZone).toBe('Europe/London'), WAIT);
  });

  test('is not sent again when it is the one saved', async () => {
    deviceIn('Asia/Kuala_Lumpur');
    const server = fakeServer();
    server.me.settings.timeZone = 'Asia/Kuala_Lumpur';
    renderApp(server);
    await started();
    expect(profileSaves()).toEqual([]);
  });

  test('is not sent when the device does not say', async () => {
    deviceIn(undefined);
    const server = fakeServer();
    server.me.settings.timeZone = null;
    renderApp(server);
    await started();
    expect(profileSaves()).toEqual([]);
    expect(server.me.settings.timeZone).toBeNull();
  });

  test.each([
    ['fails', 500],
    ['refuses it', 400],
  ])(
    'when the server %s, says nothing to the person, sends it once, and tries at the next start',
    async (_what, status) => {
      deviceIn('Asia/Kathmandu');
      const server = fakeServer();
      server.me.settings.timeZone = null;
      server.failNext.profile = status;
      renderApp(server);
      await started();
      expect(profileSaves()).toHaveLength(1);
      expect(server.me.settings.timeZone).toBeNull();
      expect(screen.queryByText(/could not save/i)).toBeNull();

      await reloadApp(server);
      await waitFor(() => expect(server.me.settings.timeZone).toBe('Asia/Kathmandu'), WAIT);
    },
  );

  test('is not sent from the copy kept on the device while the server is down', async () => {
    deviceIn('Asia/Kathmandu');
    const server = fakeServer();
    server.me.settings.timeZone = null;
    server.health = 'down';
    const done = await openedFromDevice(server);
    try {
      renderApp(server);
      expect((await screen.findAllByText('Signed in as Ryan', {}, WAIT)).length).toBeGreaterThan(0);
      await settle();
      expect(profileSaves()).toEqual([]);
    } finally {
      done();
    }
  });

  test('a profile kept on the device before these settings still opens the app', async () => {
    deviceIn('Asia/Kathmandu');
    const server = fakeServer();
    server.me.settings.timeZone = null;
    server.health = 'down';
    const done = await openedFromDevice(server, {
      email: server.me.email,
      displayName: 'Kept Ryan',
      settings: { theme: 'dark', accent: 'teal', ratePreference: 'wise' },
    });
    try {
      renderApp(server);
      expect(
        (await screen.findAllByText('Signed in as Kept Ryan', {}, WAIT)).length,
      ).toBeGreaterThan(0);
      await settle();
      expect(profileSaves()).toEqual([]);
      // Back online, the server's profile replaces it and the zone goes
      server.health = 'up';
    } finally {
      done();
    }
    await reloadApp(server);
    await waitFor(() => expect(server.me.settings.timeZone).toBe('Asia/Kathmandu'), WAIT);
  });
});
