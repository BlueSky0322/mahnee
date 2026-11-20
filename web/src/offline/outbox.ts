import type { ChangesBody, LedgerChange } from '@shared/api';
import { MAX_CHANGES, MAX_CHANGES_BYTES } from '@shared/api';
import { ApiError } from '../api';
import { createStore } from 'idb-keyval';
import { cacheUser, readCacheAs, removeCacheEntry, writeCacheAs } from './cache';
import { isOfflineFailure } from './network';

// Changes not yet saved, kept on the device (IndexedDB) so they survive the app being
// closed, killed or offline: one outbox per person signed in here. The app sends them
// when it can (ledger/save-queue.ts); while it's closed, the service worker's background
// sync (public/sw.js) sends them once the connection is back.
//
// Each change made, each one saved and each one refused is written in one short
// IndexedDB transaction that reads the outbox and writes it back, so two tabs, or a tab
// and the service worker, never write over each other's changes, with or without Web
// Locks. Making a change never waits for a send. Sending takes a lock per person, so the
// app and the service worker don't usually send the same changes at once; when they do
// (no Web Locks), the server counts a change sent twice once (by its id).
//
// A change the server refuses stays, marked with why, with the changes held with it (the
// rest of what was made with it, and what was made on top of it), for the person to try
// again or discard; everything else carries on being sent.

/** A change waiting to be sent, with the id the server knows it by */
export interface Queued {
  cid: string;
  change: LedgerChange;
  /**
   * The currency its amounts were typed in: the home currency when it was made, or another
   * one an entry was typed in; kept from older builds without one
   */
  currency?: string;
  /**
   * The change as this device shows it until it's saved, when that differs from what's
   * sent: an amount typed in another currency, at the rate the device had for it, saying
   * what was typed. Never sent: the server converts at the entry's own day's rate.
   */
  shown?: LedgerChange;
  /**
   * The changes made together (an import, a transfer and its Undo), named by the first's
   * id: sent and held together. Each change is its own from older builds without one.
   */
  group?: string;
  /**
   * The server refused it, or one it's held with: not sent again until the person tries
   * it again. `set` names the first change refused, shared by every change held with it.
   */
  refused?: { reason: string; set: string };
}

/** A change waiting, as it's shown until it's saved */
export const shownOf = (q: Queued): LedgerChange => q.shown ?? q.change;

// The keys, lock, tag and wording below are also used by public/sw.js, which can't import
// them: a change here needs the same change there (outbox.test.ts checks they match)
export const OUTBOX_PREFIX = 'outbox:';
export const LOCK_PREFIX = 'mahnee-outbox:';
export const SYNC_TAG = 'mahnee-outbox';
/** Where a person's outbox is kept: under their email, so another's is never overwritten */
export const outboxKey = (email: string) => `${OUTBOX_PREFIX}${email}`;
/** Why a change was refused, when the server didn't say */
export const REFUSED_REASON = "The server couldn't save this change.";

// Without Web Locks, calls in this page still take turns
const chains = new Map<string, Promise<unknown>>();

/**
 * Runs fn holding a person's lock for sending their outbox; the service worker takes the
 * same one. Keeping a change on the device never takes it.
 */
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
/** The request body's size around its changes, ids and currencies */
const WRAPPER_BYTES = utf8.encode('{"changes":[],"ids":[],"currencies":[]}').length;

/**
 * What's sent for these changes: each with its id and the currency it was typed in, null
 * for one kept from before changes said (sw.js sends the same)
 */
export const changesBody = (batch: Queued[]): ChangesBody => ({
  changes: batch.map((q) => q.change),
  ids: batch.map((q) => q.cid),
  currencies: batch.map((q) => q.currency ?? null),
});

/** The group a change was made in: its own, from builds before groups */
export const groupOf = (q: Queued) => q.group ?? q.cid;

/** How many groups these changes come from */
export const groupsIn = (batch: Queued[]) => new Set(batch.map(groupOf)).size;

/**
 * The changes that go in the next request, in order: at most MAX_CHANGES, and no more
 * than MAX_CHANGES_BYTES of JSON, but always at least one, from at most `maxGroups`
 * groups (narrowed to find which change the server refuses). sw.js picks them the same way.
 */
export function nextBatch(queued: Queued[], maxGroups = Infinity): Queued[] {
  let bytes = WRAPPER_BYTES;
  let count = 0;
  const groups = new Set<string>();
  for (const q of queued.slice(0, MAX_CHANGES)) {
    if (!groups.has(groupOf(q)) && groups.size >= maxGroups) break;
    // The change, its id and its currency, and a comma in each list for every change after
    // the first
    bytes +=
      utf8.encode(JSON.stringify(q.change)).length +
      utf8.encode(JSON.stringify(q.cid)).length +
      utf8.encode(JSON.stringify(q.currency ?? null)).length +
      (count > 0 ? 3 : 0);
    if (count > 0 && bytes > MAX_CHANGES_BYTES) break;
    groups.add(groupOf(q));
    count++;
  }
  return queued.slice(0, count);
}

/** What a change adds, by id: a later change naming one is made on top of it */
function addedBy(change: LedgerChange): string[] {
  const made = change as unknown as Partial<Record<string, { id?: unknown }>>;
  return ['account', 'category', 'transaction', 'recurring', 'import']
    .map((key) => made[key]?.id)
    .filter((id): id is string => typeof id === 'string');
}

/** What a change to an existing thing changes, by op: one id, or a list of them */
const TARGETS: Partial<Record<LedgerChange['op'], string>> = {
  updateAccount: 'account',
  archiveAccount: 'account',
  updateCategory: 'category',
  archiveCategory: 'category',
  updateTransaction: 'transaction',
  removeTransaction: 'transaction',
  recategoriseTransactions: 'transaction',
  removeTransactions: 'transaction',
  updateRecurring: 'recurring',
  archiveRecurring: 'recurring',
  logRecurring: 'recurring',
  skipRecurring: 'recurring',
  undoImport: 'import',
};

/**
 * The things a change adds or changes, as "kind:id": two changes to the same one must be
 * saved in the order they were made. A budget is its category's, whatever the month, since
 * one from a month replaces what was set from any later month.
 */
function targetsOf(change: LedgerChange): string[] {
  const c = change as unknown as {
    op: string;
    id?: unknown;
    ids?: unknown;
    categoryId?: unknown;
  } & Partial<Record<string, { id?: unknown }>>;
  const found: string[] = [];
  const kind = TARGETS[change.op];
  if (kind != null && typeof c.id === 'string') found.push(`${kind}:${c.id}`);
  if (kind != null && Array.isArray(c.ids)) {
    for (const id of c.ids) if (typeof id === 'string') found.push(`${kind}:${id}`);
  }
  if (c.op === 'setBudget' && typeof c.categoryId === 'string') {
    found.push(`budget:${c.categoryId}`);
  }
  for (const key of ['account', 'category', 'transaction', 'recurring', 'import']) {
    const id = c[key]?.id;
    if (typeof id === 'string') found.push(`${key}:${id}`);
  }
  return found;
}

/** Whether a change names any of these ids anywhere in it */
function names(value: unknown, ids: ReadonlySet<string>): boolean {
  if (typeof value === 'string') return ids.has(value);
  if (Array.isArray(value)) return value.some((v) => names(v, ids));
  if (typeof value === 'object' && value != null) {
    return Object.values(value).some((v) => names(v, ids));
  }
  return false;
}

/**
 * The changes held with ones the server refused, in order: those, the rest of their
 * groups, every change after them that names something they (or another held) add (an
 * entry on an account made in them, say), and every change after them to the same thing
 * (a later edit of the same entry, which would otherwise be overtaken when the refused one
 * is tried again). Changes refused already are left as they are. sw.js holds the same
 * ones (sw.test.ts runs both).
 */
export function heldWith(queued: Queued[], refused: ReadonlySet<string>): Set<string> {
  const held = new Set<string>();
  const groups = new Set<string>();
  const added = new Set<string>();
  const touched = new Set<string>();
  for (const q of queued) {
    if (q.refused != null) continue;
    const targets = targetsOf(q.change);
    if (
      refused.has(q.cid) ||
      groups.has(groupOf(q)) ||
      names(q.change, added) ||
      targets.some((t) => touched.has(t))
    ) {
      held.add(q.cid);
      groups.add(groupOf(q));
      addedBy(q.change).forEach((id) => added.add(id));
      targets.forEach((t) => touched.add(t));
    }
  }
  return held;
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

/** The device's storage couldn't be read or written: not the same as nothing kept */
export class OutboxUnavailable extends Error {}

/** The changes `email` has waiting on this device, in order; none unless they're signed in here */
export async function readOutbox(email: string): Promise<Queued[]> {
  const kept = await readCacheAs<unknown>(email, outboxKey(email));
  return Array.isArray(kept) ? kept.filter(isQueued) : [];
}

// The same store idb-keyval keeps everything else in (and sw.js opens), for reading and
// writing the outbox in one transaction
let store: ReturnType<typeof createStore> | null = null;
const outboxStore = () => (store ??= createStore('keyval-store', 'keyval'));

/**
 * Reads `email`'s outbox and writes back what `edit` makes of it, in one transaction:
 * nothing written meanwhile, by another tab or the service worker, is lost. Resolves with
 * what's kept now; throws OutboxUnavailable when the device can't read or write it, and
 * when someone else is signed in here now.
 */
export const editOutbox = (email: string, edit: (kept: Queued[]) => Queued[]) =>
  inOutbox(email, edit);

/**
 * What `email` has kept, read in its own transaction: throws OutboxUnavailable when it
 * can't be read, so a failed read is never taken for an empty outbox
 */
export const readOwnOutbox = (email: string) => inOutbox(email, null);

async function inOutbox(
  email: string,
  edit: ((kept: Queued[]) => Queued[]) | null,
): Promise<Queued[]> {
  if (cacheUser() !== email) throw new OutboxUnavailable('Someone else is signed in here');
  const key = outboxKey(email);
  const failed = (err: unknown) => new OutboxUnavailable(String(err));
  try {
    return await outboxStore()(
      edit == null ? 'readonly' : 'readwrite',
      (s) =>
        new Promise<Queued[]>((resolve, reject) => {
          const read = s.get(key);
          read.onsuccess = () => {
            try {
              const entry = read.result as { email?: unknown; value?: unknown } | undefined;
              const all: unknown[] =
                entry?.email === email && Array.isArray(entry.value) ? entry.value : [];
              const before = all.filter(isQueued);
              if (edit == null) return resolve(before);
              const after = edit(before);
              // Entries this build doesn't know (from a newer one, say) stay as they are
              const kept = [...after, ...all.filter((q) => !isQueued(q))];
              if (kept.length > 0) s.put({ email, value: kept }, key);
              else s.delete(key);
              s.transaction.oncomplete = () => resolve(after);
              s.transaction.onabort = s.transaction.onerror = () =>
                reject(failed(s.transaction.error));
            } catch (err) {
              s.transaction.abort();
              reject(failed(err));
            }
          };
          read.onerror = () => reject(failed(read.error));
        }),
    );
  } catch (err) {
    throw err instanceof OutboxUnavailable ? err : failed(err);
  }
}

/** Adds changes after what's kept, each once (one kept already stays where it is) */
export const appendToOutbox = (email: string, changes: Queued[]) =>
  editOutbox(email, (kept) => {
    const there = new Set(kept.map((q) => q.cid));
    return [...kept, ...changes.filter((q) => !there.has(q.cid))];
  });

/** Takes changes the server has saved off the outbox, and nothing else */
export const removeFromOutbox = (email: string, cids: ReadonlySet<string>) =>
  editOutbox(email, (kept) => kept.filter((q) => !cids.has(q.cid)));

/** Marks changes as refused, keeping each where it was (one not kept yet is added) */
export const markRefused = (email: string, refused: Queued[]) =>
  editOutbox(email, (kept) => {
    const marked = new Map(refused.map((q) => [q.cid, q]));
    const there = new Set(kept.map((q) => q.cid));
    return [
      ...kept.map((q) => marked.get(q.cid) ?? q),
      ...refused.filter((q) => !there.has(q.cid)),
    ];
  });

/** Sends a refused set again: unmarked, where they were */
export const retryRefused = (email: string, set: string) =>
  editOutbox(email, (kept) => kept.map((q) => (q.refused?.set === set ? unrefused(q) : q)));

/** A change as it was before it was refused */
export const unrefused = ({ refused: _refused, ...q }: Queued): Queued => q;

/** Lets a refused set go, for good */
export const discardRefused = (email: string, set: string) =>
  editOutbox(email, (kept) => kept.filter((q) => q.refused?.set !== set));

/**
 * Replaces a person's whole outbox, resolving with whether the device kept it. For
 * setting one up as an older build left it; the app adds and removes changes one by one.
 */
export async function writeOutbox(email: string, queued: Queued[]): Promise<boolean> {
  if (queued.length === 0) return removeCacheEntry(outboxKey(email));
  return writeCacheAs(email, outboxKey(email), queued);
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
 * What a failed send means: the server refused the changes (kept for the person to
 * review), or it's worth trying again (sent again by itself)
 */
export const classifySaveFailure = (err: unknown): 'refused' | 'retry' =>
  err instanceof ApiError && !isRetryable(err) ? 'refused' : 'retry';

/**
 * Answers that say nothing about the change: signed out (401), took too long (408, tried
 * less often after TIMEOUT_TRIES in a row), too early for something in between (425),
 * busy (429). A 413 with the server's reason is one change over the size it takes: refused.
 */
const RETRY_STATUSES = new Set([401, 408, 425, 429]);

/** The server took too long to read a request (408) */
export const isTimedOut = (err: unknown) => err instanceof ApiError && err.status === 408;

/**
 * How many times in a row a request may take too long (waiting 3, 6, 12 and 24 seconds
 * between) before it's tried only every few minutes; its changes keep waiting
 */
export const TIMEOUT_TRIES = 5;

/**
 * Whether a failed send is worth trying again: no connection, busy, something wrong on the
 * server's side (5xx), signed out, made as another account, or an answer that isn't the
 * app's own server saying why (a page from Cloudflare Access, a proxy or a deploy in
 * between, with no JSON reason). Only the server's own refusal, a 4xx with its reason in
 * JSON, is the server refusing the change itself. public/sw.js follows the same rule
 * (sw.test.ts runs both against the same answers).
 */
export const isRetryable = (err: unknown) =>
  isOfflineFailure(err) ||
  isOtherAccount(err) ||
  (err instanceof ApiError &&
    (RETRY_STATUSES.has(err.status) || err.status >= 500 || err.explanation == null));

/** Cloudflare Access's session ran out: sent again once they've signed in */
export const isSignedOut = (err: unknown) => err instanceof ApiError && err.status === 401;

/**
 * Made as another account than the one signed in now: kept for that account, and not
 * sent again until it's back (public/sw.js keeps it too)
 */
export const isOtherAccount = (err: unknown) =>
  err instanceof ApiError && err.code === 'account_mismatch';

/** Why the server refused a change, in its own words where it gave them */
export const refusalReason = (err: unknown) =>
  (err instanceof ApiError ? err.explanation : null) || REFUSED_REASON;
