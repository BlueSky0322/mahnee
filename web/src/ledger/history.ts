import type {
  Category,
  LedgerChange,
  SearchPage,
  SearchTotals,
  Transaction,
  TransactionPage,
} from '@shared/api';
import { MAX_TRANSACTIONS_PER_ACCOUNT, isOnAccount } from '@shared/ledger';
import type { SearchQuery } from '@shared/search';
import { categoriesIn, matchesSearch } from '@shared/search';
import { ApiError, NetworkError, api } from '../api';
import { cacheUser, onCacheCleared } from '../offline/cache';
import type { Coverage, Narrowed } from '../offline/history-store';
import {
  HistoryForgotten,
  changeEntries,
  forgetHistory,
  heldByIds,
  holdsAny,
  keepAccountPage,
  keepEntries,
  orderOf,
  orderOfCursor,
  readCoverage,
  readEntries,
  restartCoverage,
} from '../offline/history-store';
import {
  applyToPages,
  changedTransaction,
  idOf,
  isTransactionChange,
  newestFirst,
  oneByOne,
} from './apply';

// The signed-in person's whole transaction history on this device, for Activity and an
// account's entries offline (ledger.ts reads it when the server can't be reached). Each
// account is downloaded in the background, newest first, a page at a time, and how far
// it has got is kept with every page, so a download stopped (offline, the app closed)
// carries on from there. Once down, it's kept up to date by what this device learns
// anyway: each change saved from here, each page of entries the server sends, and a short
// look at each account's newest entries whenever it downloads again. Nothing is
// downloaded twice unless the server changed entries this device can't follow (an
// import undone, every amount converted to a new home currency): those start again from
// the top, showing what's held meanwhile.
//
// What's read from it says how much of the days asked for it holds (OnDevice), so a part
// is never shown as if it were all. Kept per account (offline/history-store.ts) and
// deleted with the rest of the device's copies.

/** A download asks for the most a page holds (worker/ledger/read.ts MAX_PAGE_SIZE) */
const PAGE = 200;
/** A look for new entries at the top asks for fewer */
const TOP_UP_PAGE = 50;
/** An account holds at most MAX_TRANSACTIONS_PER_ACCOUNT, so at most this many pages */
const MAX_PAGES = Math.ceil(MAX_TRANSACTIONS_PER_ACCOUNT / PAGE) + 1;
/** An account's page holds this many unless asked (worker/ledger/read.ts PAGE_SIZE) */
const ACCOUNT_PAGE = 50;

/** How much of the days asked for the device holds */
export interface OnDevice {
  /** Every account concerned is held down to its first entry */
  complete: boolean;
  /** Otherwise, the first day held whole on every account concerned; null for none */
  from: string | null;
}

/** A page read from the device, saying how much it holds */
export type PageOnDevice<P extends TransactionPage = TransactionPage> = P & {
  onDevice?: OnDevice;
};

// Emptied with the cache (signed out, someone else): what was on its way for the account
// before is never written after
let generation = 0;
const stillMineFor = (email: string, at: number) => () =>
  at === generation && cacheUser() === email;

/** The device couldn't keep or read the history since this page opened (or was emptied) */
let unavailable = false;
const listeners = new Set<() => void>();
export const historyUnavailable = () => unavailable;
export const subscribeHistory = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

function storageFailed(err: unknown) {
  if (err instanceof HistoryForgotten || unavailable) return;
  unavailable = true;
  listeners.forEach((listener) => listener());
}

// Writes go one at a time, in the order they were asked for, so a page fetched before a
// change was saved never lands on top of it
let writing: Promise<unknown> = Promise.resolve();
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = writing.then(work);
  writing = next.catch(() => undefined);
  return next;
}

// Changes saved lately, numbered: a page fetched while one was saved gets it on top
let savedCount = 0;
let savedLog: { n: number; changes: LedgerChange[] }[] = [];
const SAVED_LOG_LENGTH = 50;
const savedSince = (n: number) => savedLog.filter((s) => s.n > n).flatMap((s) => s.changes);

let running: Promise<void> | null = null;

onCacheCleared(() => {
  generation++;
  unavailable = false;
  running = null;
  savedLog = [];
  void forgetHistory().catch(() => undefined);
});

/** A page of one account's, with what was saved since it was asked for on top */
const patched = (accountId: string, page: TransactionPage, asked: number): TransactionPage =>
  applyToPages([page], savedSince(asked), (t) => isOnAccount(t, accountId))[0];

/**
 * Downloads what's missing of each account's history (`accountIds`, the server's), one
 * at a time; resolves once done, or stopped for want of a connection (carried on next
 * time). One download at a time.
 */
export function downloadHistory(accountIds: string[]): Promise<void> {
  running ??= download(accountIds).finally(() => {
    running = null;
  });
  return running;
}

async function download(accountIds: string[]) {
  const email = cacheUser();
  if (email == null) return;
  const stillMine = stillMineFor(email, generation);
  try {
    const kept = new Map((await readCoverage(email)).map((c) => [c.accountId, c]));
    for (const accountId of accountIds) {
      if (!stillMine()) return;
      let coverage: Coverage = kept.get(accountId) ?? {
        email,
        accountId,
        next: null,
        oldest: null,
        newest: null,
        complete: false,
        rows: 0,
      };
      if (coverage.complete || coverage.oldest != null) {
        coverage = await lookForNew(coverage, stillMine);
      }
      for (let pages = 0; !coverage.complete && pages < MAX_PAGES; pages++) {
        coverage = await downloadPage(coverage, stillMine);
      }
    }
  } catch (err) {
    // No connection, or the server failing: carried on from here next time
    if (err instanceof ApiError || err instanceof NetworkError) return;
    storageFailed(err);
  }
}

/** The next page down of an account's history, kept with how far it has got */
async function downloadPage(coverage: Coverage, stillMine: () => boolean): Promise<Coverage> {
  const { email, accountId, next: before } = coverage;
  const asked = savedCount;
  const page = await api.getTransactions({ account: accountId, before, limit: PAGE });
  const first = page.transactions[0];
  const last = page.transactions.at(-1);
  const rows = coverage.rows + page.transactions.length;
  const after: Coverage = {
    ...coverage,
    next: page.nextBefore,
    oldest: last?.date ?? coverage.oldest,
    newest: coverage.newest ?? (first == null ? null : orderOf(first)),
    complete: page.nextBefore == null || rows >= MAX_TRANSACTIONS_PER_ACCOUNT,
    rows,
  };
  await inOrder(() =>
    keepAccountPage(email, accountId, before, patched(accountId, page, asked), after, stillMine),
  );
  return after;
}

/**
 * The account's newest entries, down to the newest held when it last looked: added or
 * changed elsewhere since (a scheduled entry posted overnight, another device)
 */
async function lookForNew(coverage: Coverage, stillMine: () => boolean): Promise<Coverage> {
  const { email, accountId } = coverage;
  let before: string | null = null;
  let newest: string | null = null;
  for (let pages = 0; pages < MAX_PAGES; pages++) {
    const asked = savedCount;
    const page = await api.getTransactions({ account: accountId, before, limit: TOP_UP_PAGE });
    const first = page.transactions[0];
    if (newest == null && first != null) newest = orderOf(first);
    const last = page.transactions.at(-1);
    const reached =
      page.nextBefore == null || last == null || orderOf(last) <= (coverage.newest ?? '');
    const after = reached ? { ...coverage, newest: newest ?? coverage.newest } : null;
    const from = before;
    await inOrder(() =>
      keepAccountPage(email, accountId, from, patched(accountId, page, asked), after, stillMine),
    );
    if (after != null) return after;
    before = page.nextBefore;
  }
  return coverage;
}

/**
 * Changes saved from this device, made to the history as the server made them. One the
 * device can't follow (an import undone deletes entries it doesn't name) starts every
 * account's download again from the top.
 */
export function recordSaved(changes: LedgerChange[]) {
  savedCount++;
  savedLog = [...savedLog, { n: savedCount, changes }].slice(-SAVED_LOG_LENGTH);
  const email = cacheUser();
  if (email == null) return;
  const stillMine = stillMineFor(email, generation);
  const each = oneByOne(changes).filter(isTransactionChange);
  if (each.length > 0) {
    inOrder(async () => {
      const ids = [...new Set(each.map(idOf))];
      const held = await heldByIds(email, ids);
      const now = new Map<string, Transaction | null | undefined>(
        ids.map((id, i) => [id, held[i]]),
      );
      const changed = new Map<string, Transaction | null>();
      for (const change of each) {
        const id = idOf(change);
        const after = changedTransaction(change, now.get(id) ?? undefined);
        if (after === undefined) continue;
        now.set(id, after);
        changed.set(id, after);
      }
      await changeEntries(email, changed, stillMine);
    }).catch(storageFailed);
  }
  if (changes.some((c) => c.op === 'undoImport')) startAgain();
}

/** Every account's download starts again from the top, what's held staying shown */
export function startAgain() {
  const email = cacheUser();
  if (email == null) return;
  const stillMine = stillMineFor(email, generation);
  inOrder(() => restartCoverage(email, stillMine)).catch(storageFailed);
}

/**
 * Keeps a page the server sent: an account's replaces what was held between where it
 * starts and ends; a search's entries replace those held
 */
export function keepServerPage(
  page: TransactionPage,
  as: { accountId: string; before: string | null } | null,
) {
  const email = cacheUser();
  if (email == null) return;
  const stillMine = stillMineFor(email, generation);
  inOrder(() =>
    as == null
      ? keepEntries(email, page.transactions, stillMine)
      : keepAccountPage(email, as.accountId, as.before, page, null, stillMine),
  ).catch(storageFailed);
}

/** The day after `day` (2026-09-04 → 2026-09-05) */
function dayAfter(day: string) {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

/**
 * How much of `accountIds`' history is held, or null when none of it has started: the
 * device has nothing to show from
 */
async function onDeviceFor(email: string, accountIds: string[]): Promise<OnDevice | null> {
  const kept = new Map((await readCoverage(email)).map((c) => [c.accountId, c]));
  if (!accountIds.some((id) => kept.has(id))) return null;
  let complete = true;
  let from: string | null = '';
  for (const id of accountIds) {
    const c = kept.get(id);
    if (c?.complete === true) continue;
    complete = false;
    const whole = c?.oldest == null ? null : dayAfter(c.oldest);
    if (whole == null) from = null;
    else if (from != null && whole > from) from = whole;
  }
  return { complete, from: complete ? null : from };
}

/** Whether `onDevice` holds every day from `from` on */
export const holdsFrom = (onDevice: OnDevice, from: string | null) =>
  onDevice.complete || (onDevice.from != null && from != null && from >= onDevice.from);

const cursorOf = (t: Transaction) => `${t.date}_${t.time ?? ''}_${t.createdAt}_${t.id}`;

/** Those after `before` (a server's cursor), newest first; all of them for none */
function after(rows: Transaction[], before: string | null) {
  const sorted = [...rows].sort(newestFirst);
  const at = before == null ? null : orderOfCursor(before);
  return at == null ? sorted : sorted.filter((t) => orderOf(t) < at);
}

const none = (): SearchTotals => ({ entries: 0, spentCents: 0, receivedCents: 0 });
function sum(rows: Transaction[]): SearchTotals {
  const total = none();
  for (const t of rows) {
    total.entries++;
    if (t.kind === 'expense') total.spentCents += t.amountCents;
    if (t.kind === 'income') total.receivedCents += t.amountCents;
  }
  return total;
}

/** Which index narrows a search best */
function narrowing(query: SearchQuery, categories: readonly Category[]): Narrowed {
  if (query.account != null) return { by: 'account', accountId: query.account };
  if (query.category != null) {
    return {
      by: 'categories',
      ids: [...categoriesIn(categories, query.category)],
      from: query.from,
      to: query.to,
    };
  }
  return { by: 'days', from: query.from, to: query.to };
}

/**
 * A page of what a search finds, from the device, as the server would answer it (newest
 * first, `limit` at a time from `before`, with what matches beyond); null when the
 * device holds nothing of the accounts concerned, or can't be read
 */
export async function localSearchPage(
  query: SearchQuery,
  categories: readonly Category[],
  accountIds: string[],
  before: string | null,
  limit: number,
): Promise<PageOnDevice<SearchPage> | null> {
  const email = cacheUser();
  if (email == null || unavailable) return null;
  try {
    const onDevice = await onDeviceFor(email, query.account != null ? [query.account] : accountIds);
    if (onDevice == null) return null;
    const read = (q: SearchQuery) =>
      readEntries(email, narrowing(q, categories)).then((rows) =>
        rows.filter((t) => matchesSearch(t, q, categories)),
      );
    const found = after(await read(query), before);
    const page = found.slice(0, limit);
    const beyond = found.slice(limit);
    const last = beyond.length > 0 ? page.at(-1)! : null;
    const first = before == null;
    const days = query.from != null || query.to != null;
    let elsewhere: number | undefined;
    if (first && days) {
      const without = await read({ ...query, from: null, to: null });
      elsewhere = without.filter((t) => !matchesSearch(t, query, categories)).length;
    }
    return {
      transactions: page,
      nextBefore: last == null ? null : cursorOf(last),
      rest: sum(beyond),
      restOfLastDay:
        last == null
          ? null
          : { date: last.date, ...sum(beyond.filter((t) => t.date === last.date)) },
      ...(elsewhere != null && { elsewhere }),
      // A download not done may hold none yet: never said to be nothing at all
      ...(first && { anywhere: !onDevice.complete || (await holdsAny(email)) }),
      onDevice,
    };
  } catch (err) {
    storageFailed(err);
    return null;
  }
}

/**
 * A page of one account's entries from the device, as the server would answer it; null
 * when its download hasn't started, or the device can't be read
 */
export async function localAccountPage(
  accountId: string,
  before: string | null,
): Promise<PageOnDevice | null> {
  const email = cacheUser();
  if (email == null || unavailable) return null;
  try {
    const onDevice = await onDeviceFor(email, [accountId]);
    if (onDevice == null) return null;
    const found = after(await readEntries(email, { by: 'account', accountId }), before);
    const page = found.slice(0, ACCOUNT_PAGE);
    return {
      transactions: page,
      nextBefore: found.length > ACCOUNT_PAGE ? cursorOf(page.at(-1)!) : null,
      onDevice,
    };
  } catch (err) {
    storageFailed(err);
    return null;
  }
}

/** One account's entries held on the device from `fromDay`, or null when none are */
export async function localSince(accountId: string, fromDay: string) {
  const email = cacheUser();
  if (email == null || unavailable) return null;
  try {
    if ((await onDeviceFor(email, [accountId])) == null) return null;
    const rows = await readEntries(email, { by: 'account', accountId });
    return rows.filter((t) => t.date >= fromDay);
  } catch (err) {
    storageFailed(err);
    return null;
  }
}
