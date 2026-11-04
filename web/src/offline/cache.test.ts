// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, test } from 'vitest';
import {
  LAST_PAGE_KEY,
  assumeLastUser,
  clearCache,
  dropSignInMark,
  readCache,
  setCacheUser,
  signInAddress,
  writeCache,
} from './cache';

// One device can be used by more than one account: what's kept is only ever read back
// by the account that kept it

beforeEach(async () => {
  await clearCache();
  localStorage.clear();
});

describe('the device cache', () => {
  test("someone else signing in on this device can't read what was kept", async () => {
    await setCacheUser('ann@example.com');
    await writeCache('me-v2', { displayName: 'Ann' });
    expect(await readCache('me-v2')).toEqual({ displayName: 'Ann' });

    await setCacheUser('ben@example.com');
    expect(await readCache('me-v2')).toBeUndefined();
  });

  test('the same person signing in again keeps what was kept', async () => {
    await setCacheUser('ann@example.com');
    await writeCache('me-v2', { displayName: 'Ann' });
    await setCacheUser('ann@example.com');
    expect(await readCache('me-v2')).toEqual({ displayName: 'Ann' });
  });

  test('the page open stays for the first sign-in, but not for a different account', async () => {
    localStorage.setItem(LAST_PAGE_KEY, '?page=accounts');
    await setCacheUser('ann@example.com');
    expect(localStorage.getItem(LAST_PAGE_KEY)).toBe('?page=accounts');

    await setCacheUser('ben@example.com');
    expect(localStorage.getItem(LAST_PAGE_KEY)).toBeNull();
  });

  test('offline, the last person here is assumed', async () => {
    expect(assumeLastUser()).toBeNull();
    await setCacheUser('ann@example.com');
    expect(assumeLastUser()).toBe('ann@example.com');
  });
});

describe('going to sign in and back', () => {
  test('the page is marked on the way, and comes back as it was', () => {
    window.history.replaceState({ from: '?' }, '', '/?page=accounts#cash');
    expect(signInAddress()).toBe('/?page=accounts&sign-in=#cash');

    // Access sends them back to the marked address
    window.history.replaceState({ from: '?' }, '', '/?page=accounts&sign-in=#cash');
    dropSignInMark();
    expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
      '/?page=accounts#cash',
    );
    // Where the app came from in it is kept, for Back
    expect(window.history.state).toEqual({ from: '?' });
    window.history.replaceState(null, '', '/');
  });
});
