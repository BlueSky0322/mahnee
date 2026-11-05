import type { ChangesBody, LedgerChange } from '@shared/api';
import { MAX_CHANGES, MAX_CHANGES_BYTES } from '@shared/api';
import { ApiError } from '../api';
import { readCacheAs, removeCacheEntry, writeCacheAs } from './cache';
import { isOfflineFailure } from './network';
import { reportKept } from './storage-health';

// Changes not yet saved, kept on the device (IndexedDB) so they survive the app being
// closed, killed or offline: one outbox per person signed in here. The app sends them
// when it can (ledger/save-queue.ts); while it's closed, the service worker's background
// sync (public/sw.js) sends them once the connection is back. Both take the same lock
// per person, so a change is never sent twice at once, and the server counts one sent
// again after its answer was lost once (by its id).

/** A change waiting to be sent, with the id the server knows it by */
export interface Queued {
  cid: string;
  change: LedgerChange;
}

// The keys, lock and tag below are also used by public/sw.js, which can't import them: a
// change here needs the same change there (outbox.test.ts checks they match)
export const OUTBOX_PREFIX = 'outbox:';
export const LOCK_PREFIX = 'mahnee-outbox:';
export const SYNC_TAG = 'mahnee-outbox';
/** Where a person's outbox is kept: under their email, so another's is never overwritten */
export const outboxKey = (email: string) => `${OUTBOX_PREFIX}${email}`;

// Without Web Locks, calls in this page still take turns
const chains = new Map<string, Promise<unknown>>();

/** Runs fn holding a person's outbox lock; the service worker takes the same one */
export function withOutbox<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const name = `${LOCK_PREFIX}${email}`;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  // The lock's promise settles as fn's does
  if (locks) return locks.request(name, fn) as Promise<T>;
  const run = (chains.get(name) ?? Promise.resolve()).then(fn, fn);
  // The next in line runs whether this one succeeded or not; its caller hears the failure
  chains.set(
    name,
    run.catch(() => undefined),
  );
  return run;
}

const utf8 = new TextEncoder();
/** The request body's size around its changes and ids */
const WRAPPER_BYTES = utf8.encode('{"changes":[],"ids":[]}').length;

/** What's sent for these changes: each with its id (sw.js sends the same) */
export const changesBody = (batch: Queued[]): ChangesBody => ({
  changes: batch.map((q) => q.change),
  ids: batch.map((q) => q.cid),
});

/**
 * The changes that go in the next request, in order: at most MAX_CHANGES, and no more
 * than MAX_CHANGES_BYTES of JSON, but always at least one (sw.js picks them the same way)
 */
export function nextBatch(queued: Queued[]): Queued[] {
  let bytes = WRAPPER_BYTES;
  let count = 0;
  for (const q of queued.slice(0, MAX_CHANGES)) {
    // The change and its id, and a comma in each list for every change after the first
    bytes +=
      utf8.encode(JSON.stringify(q.change)).length +
      utf8.encode(JSON.stringify(q.cid)).length +
      (count > 0 ? 2 : 0);
    if (count > 0 && bytes > MAX_CHANGES_BYTES) break;
    count++;
  }
  return queued.slice(0, count);
}

/**
 * Kept from whichever build queued it, so read as unknown and kept only if it's still a
 * change; the server checks each one again anyway
 */
const isQueued = (q: unknown): q is Queued =>
  typeof q === 'object' &&
  q != null &&
  typeof (q as Queued).cid === 'string' &&
  typeof (q as Queued).change?.op === 'string';

/** The changes `email` has waiting on this device, in order; none unless they're signed in here */
export async function readOutbox(email: string): Promise<Queued[]> {
  const kept = await readCacheAs<unknown>(email, outboxKey(email));
  return Array.isArray(kept) ? kept.filter(isQueued) : [];
}

/**
 * Keeps a person's unsent changes, resolving with whether the device did; if it can't,
 * the app says so (storage-health)
 */
export async function writeOutbox(email: string, queued: Queued[]): Promise<boolean> {
  if (queued.length === 0) return removeCacheEntry(outboxKey(email));
  const kept = await writeCacheAs(email, outboxKey(email), queued);
  reportKept(kept);
  return kept;
}

/** Asks the service worker to send what's waiting once there's a connection */
export function requestBackgroundSync() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  navigator.serviceWorker.ready
    .then((reg) =>
      (
        reg as ServiceWorkerRegistration & { sync?: { register: (t: string) => Promise<void> } }
      ).sync?.register(SYNC_TAG),
    )
    .catch(() => {
      // Not supported (Safari, Firefox): the app sends them next time it's open
    });
}

/**
 * What a failed send means: the server refused the changes (they're dropped), or it's
 * worth trying again (they're kept)
 */
export const classifySaveFailure = (err: unknown): 'refused' | 'retry' =>
  err instanceof ApiError && !isRetryable(err) ? 'refused' : 'retry';

/**
 * Whether a failed send is worth trying again: no connection, busy (429), something
 * wrong on the server's side (5xx), signed out (401), or made as another account.
 * Anything else is the server refusing the change itself. public/sw.js follows the same
 * rule (sw.test.ts runs both against the same answers).
 */
export const isRetryable = (err: unknown) =>
  isOfflineFailure(err) ||
  isOtherAccount(err) ||
  (err instanceof ApiError && (err.status === 401 || err.status === 429 || err.status >= 500));

/** Cloudflare Access's session ran out: sent again once they've signed in */
export const isSignedOut = (err: unknown) => err instanceof ApiError && err.status === 401;

/**
 * Made as another account than the one signed in now: kept for that account, and not
 * sent again until it's back (public/sw.js keeps it too)
 */
export const isOtherAccount = (err: unknown) =>
  err instanceof ApiError && err.code === 'account_mismatch';
