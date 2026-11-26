// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { get, set } from 'idb-keyval';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { clearCache, setCacheUser } from '../offline/cache';
import { keepUnsent, PROFILE_OUTBOX_PREFIX, readPending, readUnsent, settleUnsent } from './unsent';

const EMAIL = 'ann@example.com';
const KEY = PROFILE_OUTBOX_PREFIX + EMAIL;

beforeEach(async () => {
  await clearCache();
  localStorage.clear();
  await setCacheUser(EMAIL);
});
afterEach(() => vi.restoreAllMocks());

test('preference edits from two tabs merge in the shared device store', async () => {
  // Each tab has its own module state and talks to the same IndexedDB.
  vi.resetModules();
  const second = await import('./unsent');
  await (await import('../offline/cache')).setCacheUser(EMAIL);

  await Promise.all([
    keepUnsent(EMAIL, { settings: { theme: 'dark' } }),
    second.keepUnsent(EMAIL, { settings: { homeDensity: 'essentials' } }),
  ]);

  expect(await readUnsent(EMAIL)).toEqual({
    settings: { theme: 'dark', homeDensity: 'essentials' },
  });
});

test('an unreadable pending patch cannot be replaced by a new preference', async () => {
  const legacy = { email: EMAIL, value: { settings: { theme: 'dark' } } };
  await set(KEY, legacy);
  const read = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(() => {
    throw new DOMException('Storage read failed', 'UnknownError');
  });
  const kept = await keepUnsent(EMAIL, { settings: { homeDensity: 'essentials' } }).catch(
    () => false,
  );
  read.mockRestore();

  expect(await get(KEY)).toEqual(legacy);
  expect(kept).toBe(false);
});

test('an older reply cannot remove a newer edit with the same value', async () => {
  await set(KEY, { email: EMAIL, value: { settings: { theme: 'dark', startWith: 'category' } } });
  const sent = (await readPending(EMAIL))!;
  await keepUnsent(EMAIL, { settings: { theme: 'light' } });
  await keepUnsent(EMAIL, { settings: { theme: 'dark' } });

  await settleUnsent(EMAIL, sent);
  expect(await readUnsent(EMAIL)).toEqual({ settings: { theme: 'dark' } });
});

test('a late reply after changing accounts leaves the original account’s preferences intact', async () => {
  const sent = await keepUnsent(EMAIL, { displayName: 'Ann' });
  await setCacheUser('ben@example.com');

  await expect(settleUnsent(EMAIL, sent)).rejects.toThrow();
  await setCacheUser(EMAIL);
  expect(await readUnsent(EMAIL)).toEqual({ displayName: 'Ann' });
});
