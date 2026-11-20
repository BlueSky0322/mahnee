import type { InfiniteData } from '@tanstack/react-query';
import type {
  ImportRecord,
  Ledger,
  LedgerChange,
  Profile,
  MonthSummary,
  MonthTrend,
  NewTransaction,
  Transaction,
  TransactionPage,
} from '@shared/api';
import { MAX_CHANGES, MAX_RECENT_IMPORTS, currencyNow, isConverting } from '@shared/api';
import { categoriesOrDefaults } from '@shared/categories';
import { isOnAccount } from '@shared/ledger';
import type { SearchQuery } from '@shared/search';
import { matchesSearch, readSearch, searchParams } from '@shared/search';
import { api } from '../api';
import {
  listCacheIds,
  onCacheCleared,
  onCacheUserKnown,
  readCache,
  readCacheEntry,
  removeCacheEntry,
  whenCacheUserKnown,
  writeCache,
} from '../offline/cache';
import type { Queued } from '../offline/outbox';
import { readOutbox, shownOf } from '../offline/outbox';
import { isOfflineFailure } from '../offline/network';
import { ME_KEY, queryClient } from '../query-client';
import { showError } from '../utils/notify';
import {
  apply,
  applyToPages,
  changedTransaction,
  idOf,
  isTransactionChange,
  oneByOne,
} from './apply';
import type { PageOnDevice } from './history';
import {
  downloadHistory,
  keepServerPage,
  localAccountPage,
  localSearchPage,
  localSince,
  recordSaved,
  startAgain,
} from './history';
import { createSaveQueue } from './save-queue';
import { applyToSummary, applyToTrend } from './summary';

// A person's ledger (their accounts, categories and repeating items, and their
// transactions a page at a time), kept in the query cache so every screen shows the same copy. change() is the
// only way it changes: each change shows straight away, is kept on the device until it's
// saved, and is sent in order with the others (save-queue.ts), offline or not. A refused
// change is put back and explained, with what was made with it or on top of it, and kept
// for the person to try again or discard; once nothing is left to send the ledger is
// fetched again, so it shows what the server has. The screens
// read it through useLedger.ts.
//
// The accounts and categories in the cache are shown as they are, changes still to send
// included. Lists of transactions are kept as the server has them, with each batch
// added once it's saved, and the changes still to send are put on top as they're shown
// (shownPages), so a list loaded a page at a time never has to be put back. A month's
// totals are kept the same way: as the server summed them, with each batch counted in
// once it's saved, and the changes still to send counted on top as they're shown
// (shownSummary); and so are the 12 months up to a month (shownTrend), each change in
// whichever of them it falls in.
//
// A change the server saved whose answer never came back is still waiting here, and a
// fresh copy may hold it already. So a read of the balances or a month's totals names the
// changes waiting that may have been sent (the first MAX_CHANGES, which is as many as one
// request carries), and the server answers which of them it holds (`alreadySaved`, read
// with the figures): those are never counted on top of that copy again.
//
// What's shown from this device's copies rather than fresh from the server is noted with
// when the server last confirmed it (dataAge), so Home can say how old it is.

export const LEDGER_KEY = ['ledger'] as const;
/** Versioned like the other saved copies: one in an older shape is never read */
const CACHE_KEY = 'ledger-v1';

/**
 * What the server has, as far as this page knows: its last copy, with the changes it has
 * saved since. Shown again when a change is refused. Null before anything is loaded.
 */
let confirmed: Ledger | null = null;
/** Ids of the changes still waiting that `confirmed` holds already */
let confirmedHolds = new Set<string>();
/** Batches saved so far: a copy fetched while one was saved may not have it */
let savedCount = 0;
/** A fresh ledger came from the server since this page started (or its cache was emptied) */
let ledgerFetched = false;

/** Every list of transactions: one account's, a search's, or (later) a month's */
export const TRANSACTIONS_KEY = ['transactions'] as const;
export type TransactionsKey = readonly ['transactions', 'account' | 'month' | 'search', string];
/** One account's transactions, newest first */
export const accountTransactionsKey = (accountId: string): TransactionsKey => [
  'transactions',
  'account',
  accountId,
];
/** What a search finds (shared/search.ts), newest first */
export const searchTransactionsKey = (query: SearchQuery): TransactionsKey => [
  'transactions',
  'search',
  new URLSearchParams(searchParams(query)).toString(),
];
/** A page of a search holds this many, the most the server sends at once */
const SEARCH_PAGE_SIZE = 200;

/** Every account's transactions in a month (2026-11), newest first */
export const monthTransactionsKey = (month: string): TransactionsKey => [
  'transactions',
  'month',
  month,
];
/** Every month's totals */
export const SUMMARY_KEY = ['summary'] as const;
/** A month's totals (2026-11) */
export const summaryKey = (month: string) => ['summary', month] as const;
/**
 * A month's totals, kept on the device for opening offline: v3 since they say which days
 * they were summed over (the person's month start day), so a copy in an older shape is
 * never read
 */
const SUMMARY_CACHE = 'summary-v3:';
const summaryCacheKey = (month: string) => `${SUMMARY_CACHE}${month}`;
/** Every 12 months' totals */
export const TREND_KEY = ['trend'] as const;
/** The totals of the 12 months ending at a month (2026-11) */
export const trendKey = (month: string) => ['trend', month] as const;
/** The same, kept on the device for opening offline */
const TREND_CACHE = 'trend-v3:';
const trendCacheKey = (month: string) => `${TREND_CACHE}${month}`;

/** The person's recent imports (GET /api/imports) */
export const IMPORTS_KEY = ['imports'] as const;
/** The same, kept on the device for opening offline */
const IMPORTS_CACHE_KEY = 'imports-v1';

/** The first page of an account's transactions, kept on the device for opening offline */
const pageCacheKey = (accountId: string) => `transactions-v1:${accountId}`;

type Pages = InfiniteData<TransactionPage, string | null>;

/**
 * Which transactions a list holds: an account's has the transfers into it too; a search's,
 * those it finds, by the categories as they're shown
 */
function belongsTo([, by, value]: TransactionsKey): (t: Transaction) => boolean {
  if (by === 'account') return (t) => isOnAccount(t, value);
  if (by === 'month') return (t) => t.date.startsWith(`${value}-`);
  const query = readSearch(new URLSearchParams(value));
  if ('error' in query) return () => false;
  const categories = queryClient.getQueryData<Ledger>(LEDGER_KEY)?.categories ?? [];
  return (t) => matchesSearch(t, query, categories);
}

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
  return recentlySaved.get(id);
}

/**
 * Transactions this page saved lately, as saved, for one no list on screen holds (a repeating
 * item logged from Home), so deleting it again (Undo) moves the balance at once. At most
 * RECENTLY_SAVED, the oldest let go first.
 */
const recentlySaved = new Map<string, Transaction>();
const RECENTLY_SAVED = 10_000;

function rememberSaved(changes: LedgerChange[]) {
  for (const change of oneByOne(changes)) {
    if (!isTransactionChange(change)) continue;
    const id = idOf(change);
    const after = changedTransaction(change, recentlySaved.get(id));
    if (after === undefined) continue;
    recentlySaved.delete(id);
    if (after != null) recentlySaved.set(id, after);
  }
  for (const id of recentlySaved.keys()) {
    if (recentlySaved.size <= RECENTLY_SAVED) break;
    recentlySaved.delete(id);
  }
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

/** `changes` but for those whose ids (`ids`, in step) a copy holds already */
const notHeld = (changes: LedgerChange[], ids: string[], holds: ReadonlySet<string>) =>
  changes.filter((_, i) => !holds.has(ids[i]));

/** The changes still waiting, but for those a copy holds already */
const waitingBut = (holds: ReadonlySet<string>) =>
  queue
    .pendingWithIds()
    .filter((q) => !holds.has(q.cid))
    .map(shownOf);

/**
 * Shows the ledger as the server last had it with what's still waiting on top, once
 * changes shown are no longer waiting (refused)
 */
function showWithoutWithdrawn() {
  if (confirmed == null) return;
  queryClient.setQueryData(
    LEDGER_KEY,
    apply(confirmed, waitingBut(confirmedHolds), savedTransaction),
  );
}

/** Which of the changes waiting may have been sent already, for a read to answer */
const maybeSent = () =>
  queue
    .pendingWithIds()
    .slice(0, MAX_CHANGES)
    .map((q) => q.cid);

/** How long a read waits to learn which changes are waiting before it goes without */
const NAMING_WAIT_MS = 1500;

/**
 * The changes waiting that a read should name: once it's known whose they are, the ones
 * kept on the device (read without the outbox lock, which only sending needs) and the ones
 * made here. A read never waits on that for long: after NAMING_WAIT_MS it names none, and
 * what's found later is asked about again (fetchLedger, and `found` for months' totals).
 */
async function idsToName(): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const known = whenCacheUserKnown()
    .then(readOutbox)
    .then((kept) => {
      const ids = [...kept, ...queue.pendingWithIds()].map((q) => q.cid);
      return [...new Set(ids)].slice(0, MAX_CHANGES);
    })
    .catch(() => maybeSent());
  const late = new Promise<string[]>((resolve) => {
    timer = setTimeout(() => resolve([]), NAMING_WAIT_MS);
  });
  try {
    return await Promise.race([known, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** A copy's own figures, without the list of what it holds */
const figuresOf = ({ alreadySaved: _held, ...ledger }: Ledger): Ledger => ledger;

const queue = createSaveQueue({
  send: (body) => api.saveChanges(body),
  saved: (changes, ids) => {
    savedCount++;
    if (confirmed != null) {
      confirmed = apply(confirmed, notHeld(changes, ids, confirmedHolds), savedTransaction);
    }
    // Counted in each month's totals, before the lists below hold them, so a transaction
    // changed is taken out of the totals as it was
    for (const [key, summary] of queryClient.getQueriesData<MonthSummary>({
      queryKey: SUMMARY_KEY,
    })) {
      if (summary == null) continue;
      // Not those it counted already when it was read
      const counted = notHeld(changes, ids, new Set(summary.alreadySaved));
      queryClient.setQueryData(key, applyToSummary(summary, counted, savedTransaction));
    }
    for (const [key, trend] of queryClient.getQueriesData<MonthTrend>({ queryKey: TREND_KEY })) {
      if (trend == null) continue;
      const counted = notHeld(changes, ids, new Set(trend.alreadySaved));
      queryClient.setQueryData(key, applyToTrend(trend, counted, savedTransaction));
    }
    // Saved, so part of every list as the server has it
    for (const [key, data] of listsInCache()) {
      if (data == null) continue;
      queryClient.setQueryData<Pages>(key, {
        ...data,
        pages: applyToPages(data.pages, changes, belongsTo(key), savedTransaction),
      });
    }
    // Recorded or undone, so part of the list as the server has it
    if (changes.some(isImportChange)) {
      queryClient.setQueryData<ImportRecord[]>(
        IMPORTS_KEY,
        (old) => old && applyToImports(old, changes),
      );
    }
    savedLog = [...savedLog, { n: savedCount, changes }].slice(-SAVED_LOG_LENGTH);
    // And to the history kept on the device for offline
    recordSaved(changes);
    // Last, so the totals and lists above took each one as it was before
    rememberSaved(changes);
  },
  // Made before a reload, or in another tab: shown on top, as the ones made here are.
  // Months' totals read before they were known didn't name them, so they're read again.
  found: (changes) => {
    queryClient.setQueryData<Ledger>(
      LEDGER_KEY,
      (old) => old && apply(old, changes, savedTransaction),
    );
    void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
    void queryClient.invalidateQueries({ queryKey: TREND_KEY });
  },
  // Refused: kept for the person to review (needsAttention), and shown without it and
  // what's held with it
  failed: (err) => {
    showError(err, "Couldn't save that change.");
    showWithoutWithdrawn();
  },
  withdrawn: () => showWithoutWithdrawn(),
  idle: () => {
    void reloadLedger();
    void queryClient.invalidateQueries({ queryKey: IMPORTS_KEY });
    void queryClient.invalidateQueries({ queryKey: TRANSACTIONS_KEY });
    void queryClient.invalidateQueries({ queryKey: SUMMARY_KEY });
    void queryClient.invalidateQueries({ queryKey: TREND_KEY });
  },
});

// Once it's known whose the ledger is, what they left unsent on this device is picked
// up and sent
onCacheUserKnown((email) => void queue.pickUp(email));
// Signing out, or someone else signing in: nothing made before is sent from this page
// (what's kept on the device stays its owner's). What the server last sent stays, since
// the server only ever sends the signed-in person's own.
onCacheCleared(() => {
  queue.forget();
  recentlySaved.clear();
  ledgerFetched = false;
  fromDevice.clear();
  trendsFromDevice.clear();
  clearTimeout(historyTimer);
  ageChanged();
});

/** How long after the balances come fresh the history starts downloading, out of the way */
const HISTORY_DELAY_MS = 5000;
let historyTimer: ReturnType<typeof setTimeout> | undefined;

/**
 * Downloads what's missing of the signed-in person's history to this device (history.ts),
 * for Activity and accounts offline. Resolves once done, or stopped for want of a
 * connection; it carries on from there next time.
 */
export function syncHistory(): Promise<void> {
  const profile = queryClient.getQueryData<Profile>(ME_KEY);
  // Not while amounts are being converted into a new home currency: they're changing
  if (profile == null || isConverting(profile)) return Promise.resolve();
  return downloadHistory(confirmed?.accounts.map((a) => a.id) ?? [], profile.settings.currency);
}

/** The home currency amounts are in now, as the profile says; null while it isn't known */
const homeCurrency = () => {
  const profile = queryClient.getQueryData<Profile>(ME_KEY);
  return profile == null ? null : currencyNow(profile);
};

/**
 * The changes still to send, as last shown: the same list until it changes, for screens
 * to show them on top of what the server has
 */
let pendingNow: LedgerChange[] = [];
let pendingWithIdsNow: Queued[] = [];
queue.subscribe(() => {
  pendingNow = queue.pending();
  pendingWithIdsNow = queue.pendingWithIds();
});
export const pendingChanges = () => pendingNow;
/** The same, each with its id */
export const pendingWithIds = () => pendingWithIdsNow;

/**
 * What's shown from this device's copies rather than fresh from the server: the ledger
 * ('ledger') and months' totals ('summary:2026-11'), each with when the server last
 * confirmed it (null when that wasn't noted)
 */
const fromDevice = new Map<string, number | null>();
const ageListeners = new Set<() => void>();
const ageChanged = () => ageListeners.forEach((listener) => listener());

function shownFromDevice(what: string, at: number | null) {
  fromDevice.set(what, at);
  ageChanged();
}

function shownFresh(what: string) {
  if (fromDevice.delete(what)) ageChanged();
}

export const subscribeDataAge = (listener: () => void) => {
  ageListeners.add(listener);
  return () => ageListeners.delete(listener);
};

/**
 * When the server last confirmed what Home shows for `month`, when any of it (the
 * balances, or that month's totals) came from this device's copy rather than fresh from
 * the server: the oldest such time, 0 when it isn't known, null when all of it is fresh
 */
export function dataAge(month: string): number | null {
  const times = ['ledger', `summary:${month}`]
    .filter((what) => fromDevice.has(what))
    .map((what) => fromDevice.get(what) ?? 0);
  return times.length === 0 ? null : Math.min(...times);
}

/** Months' totals shown from the device are fetched again, now the server answers */
function refreshKeptSummaries() {
  for (const what of fromDevice.keys()) {
    if (what.startsWith('summary:')) {
      void queryClient.invalidateQueries({ queryKey: summaryKey(what.slice('summary:'.length)) });
    }
  }
  for (const month of trendsFromDevice) {
    void queryClient.invalidateQueries({ queryKey: trendKey(month) });
  }
}

/**
 * When the days a month runs over change (the month start day, or the pay it starts on),
 * every month's totals kept on this device and shown are for the old days: the signed-in
 * person's copies are deleted first (another account's stay theirs), then the ones shown
 * are dropped, fetched again where they're showing and when next shown. Resolves once the
 * copies are gone.
 */
export async function forgetMonthTotals(): Promise<void> {
  for (const prefix of [SUMMARY_CACHE, TREND_CACHE]) {
    for (const id of await listCacheIds(prefix)) {
      if ((await readCacheEntry(`${prefix}${id}`)) != null) {
        await removeCacheEntry(`${prefix}${id}`);
      }
    }
  }
  for (const what of [...fromDevice.keys()]) {
    if (what.startsWith('summary:')) shownFresh(what);
  }
  trendsFromDevice.clear();
  void queryClient.resetQueries({ queryKey: SUMMARY_KEY });
  void queryClient.resetQueries({ queryKey: TREND_KEY });
}

/**
 * The 12 months' totals shown from the device, by the month they end at: fetched again
 * once the server answers. Not part of how old Home says its figures are (dataAge).
 */
const trendsFromDevice = new Set<string>();

/** How many changes are waiting to be saved, and whether sending waits on signing in */
export const unsavedState = () => queue.state();
export const subscribeUnsaved = (listener: () => void) => queue.subscribe(listener);
/** Changes the server refused, with those held with them, kept for the person to review */
export const needsAttention = () => queue.needsAttention();
/** Sends refused changes again, shown again meanwhile */
export const tryAgainRefused = (set: string) => void queue.retry(set);
/** Lets refused changes go, from this device too */
export const discardRefused = (set: string) => queue.discard(set);
/** Tries again to keep on this device the changes it couldn't */
export const keepChangesAgain = () => queue.keepAgain();

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
  // The server is asked which of the changes waiting the copy holds already
  let named = await idsToName();
  const savedBefore = savedCount;
  let { ledger, keptAt } = await readLedger(named);
  // What's waiting on the device goes on top, so it's read first
  await queue.ready();
  // Found waiting since, perhaps saved, and not named: asked again, naming them
  if (keptAt === undefined && maybeSent().some((id) => !named.includes(id))) {
    named = maybeSent();
    ({ ledger, keptAt } = await readLedger(named));
  }
  const shown = queryClient.getQueryData<Ledger>(LEDGER_KEY);
  // A change was saved while this was on its way, so this copy may be from before it:
  // what's shown stays, and the copy fetched once nothing is left to send replaces it
  if (signal?.aborted || (savedCount !== savedBefore && shown != null)) {
    return shown ?? figuresOf(ledger);
  }
  const holds = new Set(ledger.alreadySaved);
  confirmed = figuresOf(ledger);
  confirmedHolds = holds;
  if (keptAt === undefined) {
    // Fresh from the server: kept on the device with what it holds, and when
    ledgerFetched = true;
    void writeCache(CACHE_KEY, ledger);
    clearTimeout(historyTimer);
    historyTimer = setTimeout(() => void syncHistory(), HISTORY_DELAY_MS);
    shownFresh('ledger');
    refreshKeptSummaries();
  } else {
    shownFromDevice('ledger', keptAt);
  }
  return apply(confirmed, waitingBut(holds), savedTransaction);
}

/**
 * The ledger as shown, once it has loaded: what's shown already, else what's on its way.
 * For an import whose file is picked before the accounts and categories have loaded.
 */
export const loadedLedger = (): Promise<Ledger> =>
  queryClient.ensureQueryData({
    queryKey: LEDGER_KEY,
    queryFn: ({ signal }) => fetchLedger({ signal }),
  });

/**
 * The ledger from the server, saying which of the `named` changes it holds already
 * (`keptAt` undefined); offline, the copy kept on this device, with when it was kept
 */
async function readLedger(named: string[]): Promise<{ ledger: Ledger; keptAt?: number | null }> {
  try {
    const { accounts, categories, recurring, alreadySaved } = await api.getLedger(named);
    return {
      ledger: {
        accounts,
        categories: categoriesOrDefaults(categories),
        // None set up: the answer leaves them out
        recurring: recurring ?? [],
        alreadySaved,
      },
    };
  } catch (err) {
    if (!isOfflineFailure(err)) throw err;
    const kept = await readCacheEntry<Ledger>(CACHE_KEY);
    if (kept == null) throw err;
    return { ledger: kept.value, keptAt: kept.at };
  }
}

/**
 * A page of a list of transactions from the server, from where `before` says (the first
 * page when null), kept in the history on this device. Offline, read from that history
 * (saying how much of it the device holds), else an account's first page as kept.
 */
export async function fetchTransactionPage(
  key: TransactionsKey,
  before: string | null,
): Promise<PageOnDevice> {
  const [, by, value] = key;
  const savedBefore = savedCount;
  const askedAt = Date.now();
  let page: PageOnDevice;
  try {
    page =
      by === 'search'
        ? await api.search(value, before, SEARCH_PAGE_SIZE)
        : await api.getTransactions(
            by === 'account' ? { account: value, before } : { month: value, before },
          );
    if (by === 'account' && before == null) void writeCache(pageCacheKey(value), page);
  } catch (err) {
    if (!isOfflineFailure(err) || by === 'month') throw err;
    const local = await pageOnDevice(key, before);
    if (local != null) page = local;
    else {
      if (by !== 'account' || before != null) throw err;
      const kept = await readCache<TransactionPage>(pageCacheKey(value));
      if (kept == null) throw err;
      page = kept;
    }
  }
  // Saved while this was on its way, so perhaps not in it
  const missed = savedLog.filter((s) => s.n > savedBefore).flatMap((s) => s.changes);
  const shown = { ...page, ...applyToPages([page], missed, belongsTo(key), savedTransaction)[0] };
  if (page.onDevice == null && by !== 'month') {
    keepServerPage(shown, by === 'account' ? { accountId: value, before } : null, askedAt);
  }
  return shown;
}

/** A page of a list from the history on this device, or null when it holds none of it */
function pageOnDevice(key: TransactionsKey, before: string | null) {
  const [, by, value] = key;
  if (by === 'account') return localAccountPage(value, before, homeCurrency());
  const query = readSearch(new URLSearchParams(value));
  if ('error' in query) return Promise.resolve(null);
  const categories = queryClient.getQueryData<Ledger>(LEDGER_KEY)?.categories ?? [];
  const accounts = confirmed?.accounts.map((a) => a.id) ?? [];
  return localSearchPage(query, categories, accounts, homeCurrency(), before, SEARCH_PAGE_SIZE);
}

/** The most a page of transactions holds (worker/ledger/read.ts MAX_PAGE_SIZE) */
const LARGEST_PAGE = 200;

/**
 * An account's transactions back to `fromDay` (a few older ones too), as shown: what the
 * server has, with what was saved meanwhile and the changes still to send on top. For an
 * import to tell which of a file's rows look already saved. Offline, what this device
 * has: its history, the account's pages loaded or kept, and the changes still to send,
 * with the day before which it may not hold them all (`missingBefore`; null when it does).
 */
export async function transactionsSince(
  accountId: string,
  fromDay: string,
): Promise<{ transactions: Transaction[]; missingBefore: string | null }> {
  let missingBefore: string | null = null;
  const key = accountTransactionsKey(accountId);
  const savedBefore = savedCount;
  let held: Transaction[] = [];
  try {
    let before: string | null = null;
    do {
      const page: TransactionPage = await api.getTransactions({
        account: accountId,
        before,
        limit: LARGEST_PAGE,
      });
      held.push(...page.transactions);
      before = page.nextBefore;
      const last = page.transactions.at(-1);
      if (last != null && last.date < fromDay) break;
    } while (before != null);
    held = applyToPages(
      [{ transactions: held, nextBefore: null }],
      savedLog.filter((s) => s.n > savedBefore).flatMap((s) => s.changes),
      belongsTo(key),
      savedTransaction,
    )[0].transactions;
  } catch (err) {
    if (!isOfflineFailure(err)) throw err;
    const kept = await readCache<TransactionPage>(pageCacheKey(accountId));
    const loaded = queryClient.getQueryData<Pages>(key)?.pages ?? [];
    // The history on this device, as far as it goes
    const local = await localSince(accountId, fromDay);
    const byId = new Map(
      [
        ...(local?.transactions ?? []),
        ...(kept?.transactions ?? []),
        ...loaded.flatMap((p) => p.transactions),
      ].map((t) => [t.id, t]),
    );
    held = [...byId.values()];
    const whole =
      local == null
        ? null
        : local.onDevice.complete || local.onDevice.expired
          ? fromDay
          : local.onDevice.from;
    if (whole == null || whole > fromDay) {
      // Held whole from that day; with no history, from the oldest kept, else today
      missingBefore =
        whole ?? held.reduce<string | null>((o, t) => (o == null || t.date < o ? t.date : o), null);
      missingBefore ??= new Date().toISOString().slice(0, 10);
    }
  }
  const transactions = shownPages(
    key,
    { pages: [{ transactions: held, nextBefore: null }], pageParams: [null] },
    queue.pending(),
  );
  return { transactions, missingBefore };
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
 * A month's totals from the server; offline, the copy kept on this device. One fetched
 * while a batch was saved may be from before it, and summing it in again could count it
 * twice, so what's shown stays until the totals fetched once nothing is left to send.
 */
export async function fetchSummary(month: string): Promise<MonthSummary> {
  // The server is asked which of what's waiting on the device it counts already
  const named = await idsToName();
  const savedBefore = savedCount;
  let summary: MonthSummary;
  try {
    summary = await api.getSummary(month, named);
  } catch (err) {
    if (!isOfflineFailure(err)) throw err;
    const kept = await readCacheEntry<MonthSummary>(summaryCacheKey(month));
    if (kept == null) throw err;
    shownFromDevice(`summary:${month}`, kept.at);
    return kept.value;
  }
  void writeCache(summaryCacheKey(month), summary);
  const shown = queryClient.getQueryData<MonthSummary>(summaryKey(month));
  if (savedCount !== savedBefore && shown != null) return shown;
  shownFresh(`summary:${month}`);
  return summary;
}

/**
 * A month's totals as shown: as the server summed them, with the changes still to send,
 * but for those it counted already
 */
export function shownSummary(summary: MonthSummary, pending: Queued[]) {
  const holds = new Set(summary.alreadySaved);
  const waiting = pending.filter((q) => !holds.has(q.cid)).map(shownOf);
  return applyToSummary(summary, waiting, savedTransaction);
}

/**
 * The 12 months' totals ending at `month` from the server; offline, the copy kept on this
 * device. Like a month's totals, one fetched while a batch was saved leaves what's shown
 * until the totals fetched once nothing is left to send.
 */
export async function fetchTrend(month: string): Promise<MonthTrend> {
  const named = await idsToName();
  const savedBefore = savedCount;
  let trend: MonthTrend;
  try {
    trend = await api.getTrend(month, named);
  } catch (err) {
    if (!isOfflineFailure(err)) throw err;
    const kept = await readCache<MonthTrend>(trendCacheKey(month));
    if (kept == null) throw err;
    trendsFromDevice.add(month);
    return kept;
  }
  void writeCache(trendCacheKey(month), trend);
  const shown = queryClient.getQueryData<MonthTrend>(trendKey(month));
  if (savedCount !== savedBefore && shown != null) return shown;
  trendsFromDevice.delete(month);
  return trend;
}

/**
 * The 12 months' totals as shown: as the server summed them, with the changes still to
 * send, but for those it counted already
 */
export function shownTrend(trend: MonthTrend, pending: Queued[]) {
  const holds = new Set(trend.alreadySaved);
  const waiting = pending.filter((q) => !holds.has(q.cid)).map(shownOf);
  return applyToTrend(trend, waiting, savedTransaction);
}

/**
 * Shows the copy kept on this device while the first fresh one loads, unless something
 * is showing already
 */
export function showKeptCopy() {
  if (queryClient.getQueryData(LEDGER_KEY) !== undefined) return;
  void Promise.all([readCacheEntry<Ledger>(CACHE_KEY), queue.ready()]).then(([kept]) => {
    if (kept == null || ledgerFetched || queryClient.getQueryState(LEDGER_KEY)?.dataUpdatedAt) {
      return;
    }
    // Marked as old, so it's shown but still fetched; what it holds already isn't added again
    const shown = apply(figuresOf(kept.value), waitingBut(new Set(kept.value.alreadySaved)));
    queryClient.setQueryData(LEDGER_KEY, shown, { updatedAt: 0 });
    shownFromDevice('ledger', kept.at);
  });
}

/**
 * Whether a repeating item is due on `due` as shown now: not logged or skipped since the
 * screen asked, so a second tap never records it twice
 */
export const isDueOn = (id: string, due: string) =>
  queryClient.getQueryData<Ledger>(LEDGER_KEY)?.recurring?.find((r) => r.id === id)?.nextDue ===
  due;

/** Fetches the ledger again, if anything is showing it */
export const reloadLedger = () => queryClient.refetchQueries({ queryKey: LEDGER_KEY });

/**
 * Makes changes to the ledger, together: shown straight away, kept on the device, then
 * saved in the background, in order, once there's a connection. Check them first
 * (shared/ledger.ts, shared/categories.ts); one the server refuses is put back with what
 * was made with it or on top of it, its explanation shown, and kept to try again.
 */
export function change(...changes: LedgerChange[]) {
  queryClient.setQueryData<Ledger>(
    LEDGER_KEY,
    (old) => old && apply(old, changes, shownTransaction),
  );
  // Typed in the currency amounts are shown in now, which the server converts from if the
  // home currency has changed by the time they're saved
  const profile = queryClient.getQueryData<Profile>(ME_KEY);
  queue.add(changes, profile == null ? undefined : currencyNow(profile));
}

/**
 * change(), for changes whose amounts were typed in `currency`, another than the one
 * amounts are in now (an entry in THB): sent as typed, and converted by the server at the
 * entry's own day's rate, keeping what was typed. Until then each is shown as `shown`
 * (one each): its amount at the rate this device has, saying what was typed.
 */
export function changeTyped(currency: string, changes: LedgerChange[], shown: LedgerChange[]) {
  queryClient.setQueryData<Ledger>(LEDGER_KEY, (old) => old && apply(old, shown, shownTransaction));
  queue.add(changes, currency, shown);
}

/**
 * Adds deleted entries again (Undo), each with its own id, as they were: one typed in
 * another currency is sent as typed, and shown as it was until it's saved
 */
export function addAgain(...transactions: Transaction[]) {
  for (const { createdAt: _at, original, ...t } of transactions) {
    if (original == null) change({ op: 'addTransaction', transaction: t });
    else {
      changeTyped(
        original.currency,
        [{ op: 'addTransaction', transaction: { ...t, amountCents: original.cents } }],
        [{ op: 'addTransaction', transaction: { ...t, original } as NewTransaction }],
      );
    }
  }
}

/**
 * Once the profile says amounts have been converted into a new home currency: every
 * month's totals kept are dropped, everything shown is fetched again, and the changes kept
 * meanwhile are sent
 */
let wasConverting = false;
queryClient.getQueryCache().subscribe(({ query }) => {
  if ((query.queryKey as readonly unknown[])[0] !== ME_KEY[0]) return;
  const profile = query.state.data as Profile | undefined;
  const converting = profile != null && isConverting(profile);
  if (wasConverting && !converting) {
    void forgetMonthTotals();
    // Every amount changed on the server: the history is downloaded again
    startAgain();
    void queryClient.invalidateQueries({ queryKey: LEDGER_KEY });
    void queryClient.invalidateQueries({ queryKey: TRANSACTIONS_KEY });
    queue.resume();
  }
  wasConverting = converting;
});

const isImportChange = (change: LedgerChange) =>
  change.op === 'addImport' ||
  change.op === 'undoImport' ||
  (change.op === 'updateAccount' && change.importId != null);

/**
 * Recent imports with `changes` made to them: one recorded goes first (dated now until the
 * server's copy comes), one undone goes, one that changed an opening balance says so. Its entries go from balances and lists only once
 * the server has deleted them: this device can't know every entry an import added.
 */
export function applyToImports(imports: ImportRecord[], changes: LedgerChange[]): ImportRecord[] {
  let next = imports;
  for (const change of changes) {
    if (change.op === 'addImport' && !next.some((i) => i.id === change.import.id)) {
      next = [{ ...change.import, createdAt: Date.now() }, ...next];
    } else if (change.op === 'undoImport') {
      next = next.filter((i) => i.id !== change.id);
    } else if (change.op === 'updateAccount' && change.importId != null) {
      // Its opening balance changed with it, so its Undo says that goes back too
      const importId = change.importId;
      next = next.map((i) => (i.id === importId ? { ...i, openingChanged: true } : i));
    }
  }
  return next.slice(0, MAX_RECENT_IMPORTS);
}

/**
 * The person's recent imports from the server, kept on the device; offline, the copy kept
 * there. What was recorded or undone while this was on its way goes on top.
 */
export async function fetchImports(): Promise<ImportRecord[]> {
  const savedBefore = savedCount;
  let imports: ImportRecord[];
  try {
    ({ imports } = await api.getImports());
    void writeCache(IMPORTS_CACHE_KEY, imports);
  } catch (err) {
    if (!isOfflineFailure(err)) throw err;
    const kept = await readCache<ImportRecord[]>(IMPORTS_CACHE_KEY);
    if (kept == null) throw err;
    imports = kept;
  }
  const missed = savedLog.filter((s) => s.n > savedBefore).flatMap((s) => s.changes);
  return applyToImports(imports, missed);
}
