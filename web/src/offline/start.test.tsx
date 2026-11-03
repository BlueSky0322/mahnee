// @vitest-environment jsdom
import { act, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { get, set } from 'idb-keyval';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import type { Profile } from '@shared/api';
import { DEVICE_START_WAIT_MS } from '../profile/ProfileContext';
import { LAST_EMAIL_KEY, OPENED_FROM_DEVICE, OPENED_SIGNED_OUT, SIGN_IN_PARAM } from './cache';
import { type FakeServer, fakeServer, holdNext, renderApp, setupAppTests } from '../testing/app';

// Starting the app when the server can't answer in time. The service worker opens it
// from the copy it keeps, and says so (shell.test.ts); the app then shows the last
// account's saved profile after a moment, rather than waiting on the server. Opened from
// the network, it waits for the server to say who's signed in, as ever.

setupAppTests();

const RYAN = 'ryan@example.com';

/** What the app kept on this device the last time Ryan used it, as it keeps them */
async function keptFromLastTime(server: FakeServer) {
  localStorage.setItem(LAST_EMAIL_KEY, RYAN);
  await set('me-v2', { email: RYAN, value: { ...server.me, displayName: 'Kept Ryan' } });
}

/** The page as the service worker sends it from its copy */
function openedFromDevice() {
  const meta = document.createElement('meta');
  meta.name = OPENED_FROM_DEVICE;
  meta.content = 'true';
  document.head.append(meta);
  return () => meta.remove();
}

/** The server takes its time saying who's signed in */
const slow = (server: FakeServer) => [holdNext(server, 'GET', '/api/me')];

/**
 * Lets held answers go and takes the device-start marker away once the test is done,
 * before the shared clean-up waits for every request to be answered
 */
function finish(held: { release: () => void }[], done = () => {}) {
  held.forEach((h) => h.release());
  done();
}

const wait = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));

/**
 * The app's timeouts on a clock the test moves on, which still runs with real time so the
 * page and the device's storage carry on as usual. Moved on once the app has asked the
 * server who's signed in, which is when it starts waiting.
 */
function controlTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'], shouldAdvanceTime: true });
  onTestFinished(() => {
    vi.useRealTimers();
  });
}
const askedWhoIsSignedIn = () =>
  vi.waitFor(() =>
    expect(vi.mocked(fetch).mock.calls.some(([url]) => url === '/api/me')).toBe(true),
  );
const moveOn = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));

describe('starting with the server out of reach', () => {
  test('opened from the device, the last account’s saved profile shows after a moment', async () => {
    const server = fakeServer();
    await keptFromLastTime(server);
    const done = openedFromDevice();
    const held = slow(server);
    controlTimers();
    try {
      renderApp(server);
      await askedWhoIsSignedIn();
      // Not before the moment is up
      await moveOn(DEVICE_START_WAIT_MS - 500);
      expect(screen.queryByText('Signed in as Kept Ryan')).toBeNull();
      await moveOn(500);
      expect((await screen.findAllByText('Signed in as Kept Ryan')).length).toBeGreaterThan(0);
    } finally {
      finish(held, done);
    }
  });

  test('opened from the network, nothing kept shows until the server says who is signed in', async () => {
    const server = fakeServer();
    await keptFromLastTime(server);
    const held = slow(server);
    controlTimers();
    try {
      renderApp(server);
      await askedWhoIsSignedIn();
      // Well past the moment a start from the device would wait
      await moveOn(DEVICE_START_WAIT_MS * 2);
      expect(screen.queryByText('Signed in as Kept Ryan')).toBeNull();
    } finally {
      finish(held);
    }
    // Signed in as the server says
    expect(await screen.findByText('Signed in as Ryan')).toBeTruthy();
    // The kept copy, read once the server said who it is, lands before the next test
    await wait(100);
  });

  test('opened from the device with the server failing, the saved profile shows', async () => {
    const server = fakeServer();
    await keptFromLastTime(server);
    server.health = 'down';
    const done = openedFromDevice();
    try {
      renderApp(server);
      // Signed in as Ryan, from his saved profile
      expect((await screen.findAllByText('Signed in as Kept Ryan')).length).toBeGreaterThan(0);
      expect(await screen.findByText(RYAN)).toBeTruthy();
      expect(screen.queryByText("Couldn't reach Mahnee")).toBeNull();
    } finally {
      done();
    }
  });

  test('someone else signed in meanwhile: what Ryan kept goes, and the app starts afresh', async () => {
    const server = fakeServer();
    await keptFromLastTime(server);
    // Something else Ryan kept, which nothing of Ann's would replace
    await set('kept-v1', { email: RYAN, value: {} });
    // Ann signed in on Ryan's device; the server says so once it answers
    server.me = { ...server.me, email: 'ann@example.com', displayName: 'Ann' } satisfies Profile;
    const done = openedFromDevice();
    const held = slow(server);
    const [me] = held;
    const reload = vi.fn();
    // The page's address as it is, but reloading is only noted: jsdom can't
    const real = window.location;
    vi.stubGlobal(
      'location',
      new Proxy({}, { get: (_, key) => (key === 'reload' ? reload : Reflect.get(real, key)) }),
    );
    controlTimers();
    try {
      renderApp(server);
      await askedWhoIsSignedIn();
      await moveOn(DEVICE_START_WAIT_MS);
      await screen.findAllByText('Signed in as Kept Ryan');

      me.release();
      await vi.waitFor(() => expect(reload).toHaveBeenCalled());
      // Everything Ryan kept is gone, not only what Ann's profile replaced
      expect(await get('kept-v1')).toBeUndefined();
      expect(localStorage.getItem(LAST_EMAIL_KEY)).toBe('ann@example.com');
    } finally {
      finish(held, done);
    }
  });
});

// Cloudflare Access's session runs out: the page asks to sign in again before anything of
// the app loads. The service worker opens the kept page instead, marked so (shell.test.ts),
// and the last account's saved profile shows, with the way to sign in when there's a
// connection to.
describe('starting once Access asks to sign in again', () => {
  /** The page as the service worker opens it when Access asked to sign in */
  function openedSignedOut() {
    const meta = document.createElement('meta');
    meta.name = OPENED_FROM_DEVICE;
    meta.content = OPENED_SIGNED_OUT;
    document.head.append(meta);
    return () => meta.remove();
  }

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
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    return sentTo;
  }

  test('the last account’s saved profile shows, and Sign in goes to Access, back to the page', async () => {
    const server = fakeServer();
    await keptFromLastTime(server);
    // Access answers instead of the server, which the app can't read
    server.health = 'unreachable';
    const done = openedSignedOut();
    const sentTo = watchLeaving();
    try {
      renderApp(server, '/?page=accounts');
      expect(await screen.findByText(RYAN)).toBeTruthy();
      expect(
        await screen.findByText('Signed out. Sign in again to see what has changed.'),
      ).toBeTruthy();
      expect(screen.queryByText("You're signed out")).toBeNull();

      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      // Marked, so the service worker lets Access answer rather than opening its copy
      expect(sentTo).toEqual([`/?page=accounts&${SIGN_IN_PARAM}=`]);
    } finally {
      done();
    }
  });

  test('a session run out while the page was open shows the saved profile the same way', async () => {
    const server = fakeServer();
    await keptFromLastTime(server);
    server.health = 'signedOut';
    renderApp(server);
    expect((await screen.findAllByText('Signed in as Kept Ryan')).length).toBeGreaterThan(0);
    expect(
      await screen.findByText('Signed out. Sign in again to see what has changed.'),
    ).toBeTruthy();
  });

  test('with nothing kept here, it says signed out, and Sign in goes to Access', async () => {
    const server = fakeServer();
    server.health = 'unreachable';
    const done = openedSignedOut();
    const sentTo = watchLeaving();
    try {
      renderApp(server);
      expect(await screen.findByText("You're signed out")).toBeTruthy();
      expect(screen.queryByText("Couldn't reach Mahnee")).toBeNull();
      await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
      // Not a reload, which the service worker would answer with its copy again
      expect(sentTo).toEqual([`/?${SIGN_IN_PARAM}=`]);
    } finally {
      done();
    }
  });

  test('offline, it says offline, as signing in has to wait for a connection', async () => {
    const server = fakeServer();
    await keptFromLastTime(server);
    server.health = 'unreachable';
    const done = openedSignedOut();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    try {
      renderApp(server);
      expect(await screen.findByText(RYAN)).toBeTruthy();
      expect(
        await screen.findByText("Offline. You're seeing what this device last loaded."),
      ).toBeTruthy();
      expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    } finally {
      onLine.mockRestore();
      done();
    }
  });
});
