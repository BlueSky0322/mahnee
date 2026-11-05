// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { get } from 'idb-keyval';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LedgerChange } from '@shared/api';
import {
  CLIENT_ID_HEADER,
  EXPECTED_ACCOUNT_HEADER,
  MAX_CHANGES,
  MAX_CHANGES_BYTES,
} from '@shared/api';
import { ApiError, NetworkError } from '../api';
import { signOut } from '../profile/ProfileContext';
import { backgroundSync, load, ok, respond } from '../testing/sw';
import { UNSENT_PREFIXES, clearCache, setCacheUser } from './cache';
import type { Queued } from './outbox';
import {
  OUTBOX_PREFIX,
  SYNC_TAG,
  changesBody,
  isRetryable,
  nextBatch,
  outboxKey,
  readOutbox,
  withOutbox,
  writeOutbox,
} from './outbox';

// The outbox: each person's changes not yet saved, kept on the device. The app and the
// service worker both send from it, so they must agree on where it's kept, how it's
// locked and how it's split into requests.

const rename = (name: string): LedgerChange => ({ op: 'updateAccount', id: 'a'.repeat(16), name });
const queued = (n: number, name = (i: number) => `Name ${i}`): Queued[] =>
  Array.from({ length: n }, (_, i) => ({
    cid: i.toString(16).padStart(16, '0'),
    change: rename(name(i)),
  }));
const bytes = (batch: Queued[]) =>
  new TextEncoder().encode(JSON.stringify(changesBody(batch))).length;

describe('nextBatch', () => {
  test('takes at most MAX_CHANGES, in order', () => {
    const all = queued(MAX_CHANGES + 50);
    expect(nextBatch(all)).toEqual(all.slice(0, MAX_CHANGES));
  });

  test('stops before the request would pass MAX_CHANGES_BYTES', () => {
    // About 1 KB each, so the limit is reached long before MAX_CHANGES
    const all = queued(100, (i) => `${i}`.padEnd(1000, 'x'));
    const batch = nextBatch(all);
    expect(batch.length).toBeGreaterThan(1);
    expect(batch.length).toBeLessThan(100);
    expect(batch).toEqual(all.slice(0, batch.length));
    expect(bytes(batch)).toBeLessThanOrEqual(MAX_CHANGES_BYTES);
    expect(bytes(all.slice(0, batch.length + 1))).toBeGreaterThan(MAX_CHANGES_BYTES);
  });

  test('still sends one change bigger than the limit, on its own', () => {
    const all = queued(3, (i) => (i === 0 ? 'x'.repeat(MAX_CHANGES_BYTES) : 'small'));
    expect(nextBatch(all)).toEqual(all.slice(0, 1));
  });
});

describe('what a failed send means', () => {
  // Each answer from the server is read through the real app and service worker in
  // sw.test.ts; this is what no answer covers
  test('no connection is tried again; a mistake in the app is not a lost connection', () => {
    expect(isRetryable(new NetworkError('No connection'))).toBe(true);
    expect(isRetryable(new TypeError('x is undefined'))).toBe(false);
    expect(isRetryable(new ApiError(503, 'Down'))).toBe(true);
    expect(isRetryable(new ApiError(400, 'Invalid'))).toBe(false);
  });
});

describe('withOutbox', () => {
  test('takes turns per person without Web Locks, even after a failure', async () => {
    const order: string[] = [];
    const step =
      (name: string, ms: number, fail = false) =>
      () =>
        new Promise<void>((resolve, reject) =>
          setTimeout(() => {
            order.push(name);
            if (fail) reject(new Error(name));
            else resolve();
          }, ms),
        );
    vi.useFakeTimers();
    try {
      const first = withOutbox('ryan@example.com', step('first', 30, true));
      const second = withOutbox('ryan@example.com', step('second', 1));
      const other = withOutbox('ann@example.com', step('someone else', 1));
      const failed = expect(first).rejects.toThrow('first');
      await vi.advanceTimersByTimeAsync(40);
      await failed;
      await Promise.all([second, other]);
    } finally {
      vi.useRealTimers();
    }
    // Someone else's didn't wait; the same person's second call did
    expect(order).toEqual(['someone else', 'first', 'second']);
  });
});

// The service worker sends the outbox while the app is closed. It can't import the app's
// keys, lock and sync tag, so it keeps its own copies. Here it runs against what the app
// itself kept, to show the two still find each other's work.
describe('the service worker and the app', () => {
  /** Web Locks that note the name of each lock taken */
  const noteLocks = (taken: string[]) => ({
    request: (name: string, fn: () => Promise<unknown>) => {
      taken.push(name);
      return fn();
    },
  });

  beforeEach(() => setCacheUser('ryan@example.com'));
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearCache();
  });

  test('the service worker sends what the app kept, as whoever the app says is signed in', async () => {
    await writeOutbox('ryan@example.com', queued(2));
    const { outcome, fetch, batches } = await backgroundSync(ok);
    expect(outcome).toBe('done');
    expect(fetch.mock.calls.map(([path]) => path)).toEqual(['/api/changes']);
    expect(JSON.parse(fetch.mock.calls[0][1].body as string)).toEqual(changesBody(queued(2)));
    expect(batches).toEqual([queued(2).map((q) => q.change)]);
    // As the account the app kept it for, under the header the API reads, saying it's
    // the service worker sending
    expect(fetch.mock.calls[0][1].headers).toMatchObject({
      [CLIENT_ID_HEADER]: 'background-sync',
      [EXPECTED_ACCOUNT_HEADER]: 'ryan@example.com',
    });
    // Crossed off where the app looks
    expect(await readOutbox('ryan@example.com')).toEqual([]);
  });

  test('both take the same lock for a person', async () => {
    const taken: string[] = [];
    const locks = noteLocks(taken);
    await writeOutbox('ryan@example.com', queued(1));
    const handlers = load({ fetch: () => respond(ok) }, { navigator: { locks } });
    let done: Promise<unknown> = Promise.resolve();
    handlers.sync({ tag: SYNC_TAG, waitUntil: (work: Promise<unknown>) => (done = work) });
    await done;
    expect(await readOutbox('ryan@example.com')).toEqual([]);
    const swLock = taken.splice(0);
    expect(swLock).toHaveLength(1);

    vi.stubGlobal('navigator', { locks });
    await withOutbox('ryan@example.com', () => Promise.resolve());
    expect(taken).toEqual(swLock);
  });

  test('while the app holds the lock, the service worker waits, then finds them sent', async () => {
    await writeOutbox('ryan@example.com', queued(1));
    // Web Locks as the browser grants them: one holder at a time, in turn
    let held = Promise.resolve();
    const locks = {
      request: (_: string, fn: () => Promise<unknown>) => {
        const run = held.then(fn);
        held = run.then(
          () => undefined,
          () => undefined,
        );
        return run;
      },
    };
    vi.stubGlobal('navigator', { ...navigator, locks });
    // The app sending, and crossing them off, while the service worker wakes
    const appSending = withOutbox('ryan@example.com', async () => {
      await new Promise((r) => setTimeout(r, 20));
      await writeOutbox('ryan@example.com', []);
    });
    const sw = backgroundSync(ok, { navigator: { locks } });
    await appSending;
    const { fetch } = await sw;
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('work not yet sent', () => {
  test('is kept under the keys the app saves it under', () => {
    expect(UNSENT_PREFIXES).toEqual([OUTBOX_PREFIX]);
  });

  test("someone else signing in keeps it, theirs alone; signing out lets go of one's own only", async () => {
    vi.stubGlobal('location', { ...window.location, href: '/' });
    await setCacheUser('ann@example.com');
    await writeOutbox('ann@example.com', queued(1));

    // Ryan signs in on Ann's device and makes a change
    await setCacheUser('ryan@example.com');
    await writeOutbox('ryan@example.com', queued(2));
    // Ann's is kept for her, as it was: Ryan can't read it, and nothing sends it as him
    expect(await get(outboxKey('ann@example.com'))).toEqual({
      email: 'ann@example.com',
      value: queued(1),
    });
    expect(await readOutbox('ann@example.com')).toEqual([]);
    const sw = await backgroundSync(ok);
    expect(sw.batches).toEqual([queued(2).map((q) => q.change)]);
    expect(sw.fetch.mock.calls[0][1].headers).toMatchObject({
      [EXPECTED_ACCOUNT_HEADER]: 'ryan@example.com',
    });

    // Ryan makes another change and signs out: his goes, Ann's stays for her
    await writeOutbox('ryan@example.com', queued(1));
    await signOut();
    expect(await get(outboxKey('ryan@example.com'))).toBeUndefined();
    await setCacheUser('ann@example.com');
    expect(await readOutbox('ann@example.com')).toEqual(queued(1));
    vi.unstubAllGlobals();
    await clearCache();
  });
});
