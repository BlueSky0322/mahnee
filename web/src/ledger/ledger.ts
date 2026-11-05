import type { InfiniteData } from '@tanstack/react-query';
import type { Ledger, LedgerChange, Transaction, TransactionPage } from '@shared/api';
import { categoriesOrDefaults } from '@shared/categories';
import { isOnAccount } from '@shared/ledger';
import { api } from '../api';
import { onCacheCleared, onCacheUserKnown, readCache, writeCache } from '../offline/cache';
import { isOfflineFailure } from '../offline/network';
import { queryClient } from '../query-client';
import { showError } from '../utils/notify';
import { apply, applyToPages } from './apply';
import { createSaveQueue } from './save-queue';

// A person's ledger (their accounts and categories, and their transactions a page at a
// time), kept in the query cache so every screen shows the same copy. change() is the
// only way it changes: each change shows straight away, is kept on the device until it's
// saved, and is sent in order with the others (save-queue.ts), offline or not. A refused
// change is put back and explained, with everything made after it, and once nothing is
// left to send the ledger is fetched again, so it shows what the server has. The screens
// read it through useLedger.ts.
//
// The accounts and categories in the cache are shown as they are, changes still to send
// included. Lists of transactions are kept as the server has them, with each batch
// added once it's saved, and the changes still to send are put on top as they're shown
// (shownPages), so a list loaded a page at a time never has to be put back.

export const LEDGER_KEY = ['ledger'] as const;
/** Versioned like the other saved copies: one in an older shape is never read */
const CACHE_KEY = 'ledger-v1';

/**
 * What the server has, as far as this page knows: its last copy, with the changes it has
 * saved since. Shown again when a change is refused. Null before anything is loaded.
 */
let confirmed: Ledger | null = null;
/** Batches saved so far: a copy fetched while one was saved may not have it */
let savedCount = 0;

/** Every list of transactions: one account's, or (later) a month's */
export const TRANSACTIONS_KEY = ['transactions'] as const;
export type TransactionsKey = readonly ['transactions', 'account' | 'month', string];
/** One account's transactions, newest first */
export const accountTransactionsKey = (accountId: string): TransactionsKey => [
  'transactions',
  'account',
  accountId,
];
/** Every account's transactions in a month (2026-11), newest first */
export const monthTransactionsKey = (month: string): TransactionsKey => [
  'transactions',
  'month',
  month,
];
/** The first page of an account's transactions, kept on the device for opening offline */
const pageCacheKey = (accountId: string) => `transactions-v1:${accountId}`;

type Pages = InfiniteData<TransactionPage, string | null>;

/** Which transactions a list holds: an account's has the transfers into it too */
const belongsTo =
  ([, by, value]: TransactionsKey) =>
  (t: Transaction) =>
    by === 'account' ? isOnAccount(t, value) : t.date.startsWith(`${value}-`);

/** Every list of transactions in the cache, as the server has them */
const listsInCache = () =>
  queryClient.getQueriesData<Pages>({ queryKey: TRANSACTIONS_KEY }) as unknown as [
    TransactionsKey,
    Pages | undefined,
  ][];

/** A transaction as the server has it, from whichever list holds it */
function savedTransaction(id: string): Transaction | undefined {
  for (const [, data] of listsInCache()) {
    for (const page of data?.pages ?? []) {
      const found = page.transactions.find((t) => t.id === id);
      if (found != null) return found;
    }
  }
  return undefined;
}

/** A transaction as shown: as the server has it, with the changes still to send made to it */
function shownTransaction(id: string): Transaction | undefined {
  const saved = savedTransaction(id);
  const shown = applyToPages(
    [{ transactions: saved == null ? [] : [saved], nextBefore: null }],
    queue.pending(),
    (t) => t.id === id,
    savedTransaction,
  );
  return shown[0].transactions[0];
}

/**
 * Batches saved lately, numbered: a list fetched while one was saved may be from before
 * it, so what was saved meanwhile goes on top (apply's changes come out the same on a
 * copy that already has them). The last few are enough; a list fetched over longer is
 * fetched again once nothing is left to send.
 */
let savedLog: { n: number; changes: LedgerChange[] }[] = [];
const SAVED_LOG_LENGTH = 50;

const queue = createSaveQueue({
  send: (body) => api.saveChanges(body),
  saved: (changes) => {
    savedCount++;
    if (confirmed != null) confirmed = apply(confirmed, changes, savedTransaction);
    // Saved, so part of every list as the server has it
    for (const [key, data] of listsInCache()) {
      if (data == null) continue;
      queryClient.setQueryData<Pages>(key, {
        ...data,
        pages: applyToPages(data.pages, changes, belongsTo(key), savedTransaction),
      });
    }
    savedLog = [...savedLog, { n: savedCount, changes }].slice(-SAVED_LOG_LENGTH);
  },
  // Made before a reload, or in another tab: shown on top, as the ones made here are
  found: (changes) =>
    queryClient.setQueryData<Ledger>(
      LEDGER_KEY,
      (old) => old && apply(old, changes, savedTransaction),
    ),
  failed: (err) => {
    showError(err, "Couldn't save that change.");
    if (confirmed != null) queryClient.setQueryData(LEDGER_KEY, confirmed);
  },
  idle: () => {
    void reloadLedger();
    void queryClient.invalidateQueries({ queryKey: TRANSACTIONS_KEY });
  },
});

// Once it's known whose the ledger is, what they left unsent on this device is picked
// up and sent
onCacheUserKnown((email) => void queue.pickUp(email));
// Signing out, or someone else signing in: nothing made before is sent from this page
// (what's kept on the device stays its owner's). What the server last sent stays, since
// the server only ever sends the signed-in person's own.
onCacheCleared(() => queue.forget());

/**
 * The changes still to send, as last shown: the same list until it changes, for screens
 * to show them on top of what the server has
 */
let pendingNow: LedgerChange[] = [];
queue.subscribe(() => {
  pendingNow = queue.pending();
});
export const pendingChanges = () => pendingNow;

/** How many changes are waiting to be saved, and whether sending waits on signing in */
export const unsavedState = () => queue.state();
export const subscribeUnsaved = (listener: () => void) => queue.subscribe(listener);

/**
 * Sends what's waiting as soon as it can: back online, back to the app, or the page
 * brought back from the browser's memory, rather than at the next retry. Returns how to
 * stop.
 */
export function sendWhenBack() {
  const resume = () => queue.resume();
  const shown = () => {
    if (document.visibilityState === 'visible') queue.resume();
  };
  const restored = (event: PageTransitionEvent) => {
    if (event.persisted) queue.resume();
  };
  window.addEventListener('online', resume);
  document.addEventListener('visibilitychange', shown);
  window.addEventListener('pageshow', restored);
  return () => {
    window.removeEventListener('online', resume);
    document.removeEventListener('visibilitychange', shown);
    window.removeEventListener('pageshow', restored);
  };
}

/**
 * The ledger from the server, with the changes still being sent shown on top. Offline,
 * the copy kept on this device. Someone who has never saved a change has no categories
 * saved yet: they see the defaults, which their first change saves.
 */
export async function fetchLedger({ signal }: { signal?: AbortSignal } = {}): Promise<Ledger> {
  const savedBefore = savedCount;
  let ledger: Ledger;
  try {
    const { accounts, categories } = await api.getLedger();
    ledger = { accounts, categories: categoriesOrDefaults(categories) };
  } catch (err) {
    if (!isOfflineFailure(err)) throw err;
    const kept = await readCache<Ledger>(CACHE_KEY);
    if (kept == null) throw err;
    ledger = kept;
  }
  // What's waiting on the device goes on top, so it's read first
  await queue.ready();
  const shown = queryClient.getQueryData<Ledger>(LEDGER_KEY);
  // A change was saved while this was on its way, so this copy may be from before it:
  // what's shown stays, and the copy fetched once nothing is left to send replaces it
  if (signal?.aborted || (savedCount !== savedBefore && shown != null)) return shown ?? ledger;
  confirmed = ledger;
  void writeCache(CACHE_KEY, ledger);
  return apply(ledger, queue.pending(), savedTransaction);
}

/**
 * A page of a list of transactions from the server, from where `before` says (the first
 * page when null). An account's first page is kept on the device, and shown from there
 * offline.
 */
export async function fetchTransactionPage(
  key: TransactionsKey,
  before: string | null,
): Promise<TransactionPage> {
  const [, by, value] = key;
  const savedBefore = savedCount;
  let page: TransactionPage;
  try {
    page = await api.getTransactions(
      by === 'account' ? { account: value, before } : { month: value, before },
    );
    if (by === 'account' && before == null) void writeCache(pageCacheKey(value), page);
  } catch (err) {
    if (!isOfflineFailure(err) || by !== 'account' || before != null) throw err;
    const kept = await readCache<TransactionPage>(pageCacheKey(value));
    if (kept == null) throw err;
    page = kept;
  }
  // Saved while this was on its way, so perhaps not in it
  const missed = savedLog.filter((s) => s.n > savedBefore).flatMap((s) => s.changes);
  return applyToPages([page], missed, belongsTo(key), savedTransaction)[0];
}

/**
 * A list's transactions as shown, newest first: as the server has them, with the changes
 * still to send on top. Each once, should two pages both hold one.
 */
export function shownPages(
  key: TransactionsKey,
  data: Pages,
  pending: LedgerChange[],
): Transaction[] {
  const pages = applyToPages(data.pages, pending, belongsTo(key), savedTransaction);
  const seen = new Set<string>();
  return pages
    .flatMap((p) => p.transactions)
    .filter((t) => !seen.has(t.id) && Boolean(seen.add(t.id)));
}

/**
 * Shows the copy kept on this device while the first fresh one loads, unless something
 * is showing already
 */
export function showKeptCopy() {
  if (queryClient.getQueryData(LEDGER_KEY) !== undefined) return;
  void Promise.all([readCache<Ledger>(CACHE_KEY), queue.ready()]).then(([kept]) => {
    if (kept == null || queryClient.getQueryState(LEDGER_KEY)?.dataUpdatedAt) return;
    // Marked as old, so it's shown but still fetched
    queryClient.setQueryData(LEDGER_KEY, apply(kept, queue.pending()), { updatedAt: 0 });
  });
}

/** Fetches the ledger again, if anything is showing it */
export const reloadLedger = () => queryClient.refetchQueries({ queryKey: LEDGER_KEY });

/**
 * Makes changes to the ledger: shown straight away, kept on the device, then saved in
 * the background, in order, once there's a connection. Check them first
 * (shared/ledger.ts, shared/categories.ts); one the server refuses is put back with
 * everything made after it, and its explanation shown.
 */
export function change(...changes: LedgerChange[]) {
  queryClient.setQueryData<Ledger>(
    LEDGER_KEY,
    (old) => old && apply(old, changes, shownTransaction),
  );
  queue.add(changes);
}
