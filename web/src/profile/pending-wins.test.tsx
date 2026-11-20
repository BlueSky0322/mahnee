// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react';
import { get, set } from 'idb-keyval';
import { expect, test, vi } from 'vitest';
import { fakeServer, renderApp, settle, setupAppTests } from '../testing/app';
import { LAST_EMAIL_KEY } from '../offline/cache';
import { PROFILE_OUTBOX_PREFIX } from './unsent';

// A preference changed without a connection and still to send is shown over the server's
// older profile, whichever answers first: the device's read of what waits, the server's
// profile, or a save the server holds back.

// Reads of what waits to be sent, held or answered at once as a test says
const outboxReads = vi.hoisted(() => ({
  answer: null as null | ((read: () => Promise<unknown>) => Promise<unknown>),
}));
vi.mock('idb-keyval', async (importOriginal) => {
  const real = await importOriginal<typeof import('idb-keyval')>();
  return {
    ...real,
    get: (key: IDBValidKey, store?: Parameters<typeof real.get>[1]) =>
      outboxReads.answer != null && typeof key === 'string' && key.startsWith('profile-outbox:')
        ? outboxReads.answer(() => real.get(key, store))
        : real.get(key, store),
  };
});

setupAppTests();

const RYAN = 'ryan@example.com';
const WAITING = { email: RYAN, value: { settings: { startWith: 'category' } } };

/** Kept from an earlier session offline: Start with changed to Category, not sent yet */
async function keptOffline() {
  localStorage.setItem(LAST_EMAIL_KEY, RYAN);
  await set(`${PROFILE_OUTBOX_PREFIX}${RYAN}`, WAITING);
}

const keptPatch = async () =>
  (await get<{ value: unknown }>(`${PROFILE_OUTBOX_PREFIX}${RYAN}`))?.value;

const startWith = async () => {
  const page = within(await screen.findByRole('region', { name: 'Adding entries' }));
  return within(page.getByRole('radiogroup', { name: 'Start with' }))
    .getAllByRole('radio')
    .map((r) => [r.textContent, r.getAttribute('aria-checked')]);
};

const ON_CATEGORY = [
  ['Amount', 'false'],
  ['Category', 'true'],
];

/** Holds the next save of the profile until the test lets it answer */
function holdNextSave() {
  const answer = vi.mocked(fetch).getMockImplementation()!;
  let release: () => void = () => {};
  let held = false;
  vi.mocked(fetch).mockImplementation((input, init) => {
    if (!held && input === '/api/me' && init?.method === 'PATCH') {
      held = true;
      return new Promise((resolve) => {
        release = () => resolve(answer(input, init));
      });
    }
    return answer(input, init);
  });
  return { sent: () => held, answer: () => release() };
}

test('a preference read from the device before the server profile is drawn still shows', async () => {
  await keptOffline();
  // The device answers at once, before the app has drawn the server's profile
  outboxReads.answer = () => Promise.resolve(WAITING);
  const server = fakeServer();
  server.failNext.profile = 503;
  try {
    renderApp(server, '/?settings=adding', { size: 'phone' });
    await waitFor(async () => expect(await startWith()).toEqual(ON_CATEGORY));
    await settle();
    expect(await startWith()).toEqual(ON_CATEGORY);
    expect(server.me.settings.startWith).toBe('amount');
  } finally {
    outboxReads.answer = null;
  }

  // Sent once the connection is back, and no longer waiting
  act(() => void window.dispatchEvent(new Event('online')));
  await waitFor(() => expect(server.me.settings.startWith).toBe('category'));
  await waitFor(async () => expect(await keptPatch()).toBeUndefined());
  expect(await startWith()).toEqual(ON_CATEGORY);
});

test('a preference read from the device after the server profile, with the save held, still shows', async () => {
  await keptOffline();
  // The device answers only once the server's profile has
  let readNow: () => void = () => {};
  const deviceRead = new Promise<void>((resolve) => {
    readNow = resolve;
  });
  outboxReads.answer = (read) => deviceRead.then(read);
  const server = fakeServer();
  server.failNext.profile = 503;
  try {
    renderApp(server, '/?settings=adding', { size: 'phone' });
    const save = holdNextSave();
    const askedForProfile = () =>
      vi
        .mocked(fetch)
        .mock.calls.some(([input, init]) => input === '/api/me' && init?.method === 'GET');
    await waitFor(() => expect(askedForProfile()).toBe(true));
    await settle();
    readNow();
    await waitFor(async () => expect(await startWith()).toEqual(ON_CATEGORY));
    await waitFor(() => expect(save.sent()).toBe(true));
    save.answer();
    await settle();
    expect(await startWith()).toEqual(ON_CATEGORY);
  } finally {
    outboxReads.answer = null;
  }
  expect(await keptPatch()).toEqual({ settings: { startWith: 'category' } });
});
