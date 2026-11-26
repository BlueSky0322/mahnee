import { notifications } from '@mantine/notifications';
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
import { categoriesIn, matchesSearch, searchParams } from '@shared/search';
import { ApiError, CLIENT_ID, NetworkError, api } from '../api';
import { cacheUser, onCacheCleared, sessionBlocked } from '../offline/cache';
import type { Coverage, Narrowed } from '../offline/history-store';
import {
  HistoryForgotten,
  HistoryWriteFailed,
  accountEntries,
  changeEntries,
  forgetHistory,
  heldByIds,
  holdsAny,
  keepAccountPage,
  keepEntries,
  letDownloadGo,
  orderOf,
  orderOfCursor,
  readCoverage,
  readEntries,
  restartCoverage,
  restarted,
  takeDownload,
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
// carries on from there. Between downloads it's kept up to date by what this device
// learns anyway: each change saved from here, each page of entries the server sends, and
// a short look at each account's newest entries whenever it downloads.
//
// What other devices change below the newest entries (an edit, a deletion, an entry
// dated last month) shows in no look at the top, and the server keeps no record of what
// it deleted, so each account is checked again in full, from the top, once a week
// (RECHECK_MS), and whenever its amounts are in another home currency than the profile's
// (converted on another device): a pass from the top replaces what's held page by page.
// Meanwhile what's held is shown, said to be being refreshed (OnDevice), and never counted
// as all of it.
//
// One tab downloads at a time (a Web Lock, or a note in the history's database where the
// browser has none). Kept per account (offline/history-store.ts) and deleted with the
// rest of the device's copies.

/** A download asks for the most a page holds (worker/ledger/read.ts MAX_PAGE_SIZE) */
const PAGE = 200;
/** A look for new entries at the top asks for fewer */
const TOP_UP_PAGE = 50;
/** An account holds at most MAX_TRANSACTIONS_PER_ACCOUNT, so at most this many pages */
const MAX_PAGES = Math.ceil(MAX_TRANSACTIONS_PER_ACCOUNT / PAGE) + 1;
/** An account's page holds this many unless asked (worker/ledger/read.ts PAGE_SIZE) */
export const ACCOUNT_PAGE = 50;
/**
 * How long after a look for an account's new entries another is skipped: the ledger is
 * fetched again after every save from here (which the history follows already), and each
 * fetch would otherwise look at every account's newest entries again
 */
export const LOOK_AGAIN_MS = 2 * 60 * 1000;
/** When each account last looked for new entries, by `email:accountId` */
const lookedAt = new Map<string, number>();

/** How long an account's history counts as checked before it's checked again in full */
export const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

/** How much of the days asked for the device holds */
export interface OnDevice {
  /** Every account concerned was checked in full, lately, in the home currency */
  complete: boolean;
  /** Otherwise, the first day checked whole on every account concerned; null for none */
  from: string | null;
  /**
   * Every account concerned holds its entries before `from` too, from an earlier check,
   * being refreshed now; otherwise some aren't on the device yet
   */
  refreshing: boolean;
  /**
   * Every account concerned is held in full, but some weren't checked within RECHECK_MS
   * (offline all that time, say): nothing can refresh them until back online
   */
  expired: boolean;
  /** When the accounts concerned were last checked in full, the longest ago (ms); null if never */
  checkedAt: number | null;
}

/** A page read from the device, saying how much it holds */
export type PageOnDevice<P extends TransactionPage = TransactionPage> = P & {
  onDevice?: OnDevice;
};

// Emptied with the cache (signed out, someone else): what was on its way for the account
// before is never written after
let generation = 0;
const stillMineFor = (email: string, at: number) => () =>
  at === generation && cacheUser() === email && !sessionBlocked();

/** The device couldn't read the history since this page opened (or was emptied) */
let unreadable = false;
/** The device couldn't write to it (full, say): downloads stop for this page */
let unwritable = false;
const listeners = new Set<() => void>();
export const historyUnavailable = () => unreadable;
export const subscribeHistory = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const OUT_OF_SPACE =
  'This device is out of space for your history, so offline it shows what it has kept.';

function storageFailed(err: unknown) {
  if (err instanceof HistoryForgotten) return;
  if (err instanceof HistoryWriteFailed) {
    if (unwritable) return;
    unwritable = true;
    // Once a page: what's held still reads
    notifications.show({ color: 'yellow', message: OUT_OF_SPACE });
    return;
  }
  if (unreadable) return;
  unreadable = true;
  listeners.forEach((listener) => listener());
}

// Writes go one at a time, in the order they were asked for, so a page fetched before a
// change was saved never lands on top of it
let writing: Promise<unknown> = Promise.resolve();
let writes = 0;
function inOrder<T>(work: () => Promise<T>): Promise<T> {
  const next = writing.then(work).finally(() => writes++);
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
  unreadable = false;
  unwritable = false;
  running = null;
  savedLog = [];
  lastSearch = null;
  lookedAt.clear();
  return forgetHistory();
});

/** A page of one account's, with what was saved since it was asked for on top */
const patched = (accountId: string, page: TransactionPage, asked: number): TransactionPage =>
  applyToPages([page], savedSince(asked), (t) => isOnAccount(t, accountId))[0];

/**
 * Downloads what's missing or out of date of each account's history (`accountIds`, the
 * server's, with amounts in `currency`), one account at a time; resolves once done, or
 * stopped for want of a connection (carried on next time), or when another tab is at it.
 */
export function downloadHistory(accountIds: string[], currency: string): Promise<void> {
  const email = cacheUser();
  if (email == null || unwritable) return Promise.resolve();
  running ??= oneTab(email, (stillHeld) =>
    download(email, accountIds, currency, stillHeld),
  ).finally(() => {
    running = null;
  });
  return running;
}

/** Runs `work` while no other tab downloads for `email` */
async function oneTab(email: string, work: (stillHeld: () => Promise<boolean>) => Promise<void>) {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (locks != null) {
    await locks.request(`mahnee-history:${email}`, { ifAvailable: true }, (lock) =>
      lock == null ? undefined : work(() => Promise.resolve(true)),
    );
    return;
  }
  // No Web Locks: a note in the database, said again with each page
  const hold = () => takeDownload(email, CLIENT_ID, Date.now()).catch(() => false);
  if (!(await hold())) return;
  try {
    await work(hold);
  } finally {
    await letDownloadGo(email, CLIENT_ID).catch(() => undefined);
  }
}

async function download(
  email: string,
  accountIds: string[],
  currency: string,
  stillHeld: () => Promise<boolean> = () => Promise.resolve(true),
) {
  const stillMine = stillMineFor(email, generation);
  try {
    const kept = new Map((await readCoverage(email)).map((c) => [c.accountId, c]));
    for (const accountId of accountIds) {
      if (!stillMine()) return;
      const now = Date.now();
      let coverage: Coverage = kept.get(accountId) ?? {
        email,
        accountId,
        next: null,
        oldest: null,
        newest: null,
        complete: false,
        held: false,
        rows: 0,
        pass: now,
        verifiedAt: null,
        currency,
      };
      // Out of date: checked again in full, from the top
      if (coverage.currency !== currency || (coverage.complete && !lately(coverage, now))) {
        coverage = restarted(coverage, now, currency);
      }
      const looked = lookedAt.get(`${email}:${accountId}`);
      // Not if the clock has gone back since, which would hold it off until it caught up
      const lookedLately =
        coverage.complete && looked != null && now >= looked && now - looked < LOOK_AGAIN_MS;
      if ((coverage.complete || coverage.oldest != null) && !lookedLately) {
        coverage = await lookForNew(coverage, stillMine);
        lookedAt.set(`${email}:${accountId}`, Date.now());
      }
      for (let pages = 0; !coverage.complete && pages < MAX_PAGES; pages++) {
        // A turn for the page between pages, so a download of the whole history (after a
        // change of home currency, say) never holds up a tap or typing
        await breathe();
        if (!(await stillHeld())) return;
        coverage = await downloadPage(coverage, stillMine);
      }
    }
  } catch (err) {
    // No connection, or the server failing: carried on from here next time
    if (err instanceof ApiError || err instanceof NetworkError) return;
    storageFailed(err);
  }
}

/** Lets the page take its turn: the browser's scheduler where it has one, else a timer */
function breathe(): Promise<void> {
  const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Whether an account's history was checked in full lately */
const lately = (c: Coverage, now: number) =>
  c.verifiedAt != null && now - c.verifiedAt < RECHECK_MS && now >= c.verifiedAt;

/** The next page down of an account's history, kept with how far it has got */
async function downloadPage(coverage: Coverage, stillMine: () => boolean): Promise<Coverage> {
  const { email, accountId, next: before } = coverage;
  const asked = savedCount;
  const askedAt = Date.now();
  const page = await api.getTransactions({ account: accountId, before, limit: PAGE });
  const first = page.transactions[0];
  const last = page.transactions.at(-1);
  const rows = coverage.rows + page.transactions.length;
  const complete = page.nextBefore == null || rows >= MAX_TRANSACTIONS_PER_ACCOUNT;
  const after: Coverage = {
    ...coverage,
    next: page.nextBefore,
    oldest: last?.date ?? coverage.oldest,
    // The top of a pass from the top is the newest entry held
    newest: before == null ? (first == null ? null : orderOf(first)) : coverage.newest,
    complete,
    held: complete ? false : coverage.held,
    rows,
    verifiedAt: complete ? Date.now() : coverage.verifiedAt,
  };
  await inOrder(() =>
    keepAccountPage(
      email,
      accountId,
      before,
      patched(accountId, page, asked),
      after,
      stillMine,
      askedAt,
    ),
  );
  if (before == null && stillMine()) lookedAt.set(`${email}:${accountId}`, askedAt);
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
    const askedAt = Date.now();
    const page = await api.getTransactions({ account: accountId, before, limit: TOP_UP_PAGE });
    const first = page.transactions[0];
    if (newest == null && first != null) newest = orderOf(first);
    const last = page.transactions.at(-1);
    const reached =
      page.nextBefore == null || last == null || orderOf(last) <= (coverage.newest ?? '');
    const after = reached ? { ...coverage, newest: newest ?? coverage.newest } : null;
    const from = before;
    await inOrder(() =>
      keepAccountPage(
        email,
        accountId,
        from,
        patched(accountId, page, asked),
        after,
        stillMine,
        askedAt,
      ),
    );
    if (after != null) return after;
    before = page.nextBefore;
  }
  return coverage;
}

/**
 * Changes saved from this device, made to the history as the server made them (an entry
 * added is placed as when it was saved, and takes the server's own place once a page
 * lists it). One the device can't follow (an import undone deletes entries it doesn't
 * name) starts every account's download again from the top.
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
  lookedAt.clear();
  const email = cacheUser();
  if (email == null) return;
  const stillMine = stillMineFor(email, generation);
  inOrder(() => restartCoverage(email, stillMine, Date.now())).catch(storageFailed);
}

/**
 * Keeps a page the server sent (asked for at `askedAt`): an account's replaces what was
 * held between where it starts and ends; a search's entries replace those held
 */
export function keepServerPage(
  page: TransactionPage,
  as: { accountId: string; before: string | null } | null,
  askedAt: number,
) {
  const email = cacheUser();
  if (email == null || unwritable) return;
  const stillMine = stillMineFor(email, generation);
  inOrder(() =>
    as == null
      ? keepEntries(email, page.transactions, stillMine, askedAt)
      : keepAccountPage(email, as.accountId, as.before, page, null, stillMine, askedAt),
  ).catch(storageFailed);
}

/** The day after `day` (2026-09-04 → 2026-09-05) */
function dayAfter(day: string) {
  const at = new Date(`${day}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + 1);
  return at.toISOString().slice(0, 10);
}

/**
 * How much of `accountIds`' history is held, with amounts in `currency`, or null when
 * none of it has started: the device has nothing to show from. Null too while the currency
 * amounts are in isn't known (no profile yet): a history kept in another one would be read
 * as current.
 */
async function onDeviceFor(
  email: string,
  accountIds: string[],
  currency: string | null,
): Promise<OnDevice | null> {
  if (currency == null) return null;
  const kept = new Map((await readCoverage(email)).map((c) => [c.accountId, c]));
  if (!accountIds.some((id) => kept.has(id))) return null;
  const now = Date.now();
  let complete = true;
  let expired = true;
  let refreshing = true;
  let from: string | null = '';
  let checkedAt: number | null = Infinity;
  for (const id of accountIds) {
    const c = kept.get(id);
    const sameMoney = c != null && c.currency === currency;
    const checked = c?.verifiedAt ?? null;
    checkedAt = checked == null || checkedAt == null ? null : Math.min(checkedAt, checked);
    if (c != null && sameMoney && c.complete) {
      if (!lately(c, now)) complete = false;
      continue;
    }
    complete = false;
    expired = false;
    if (c == null || !(c.held || c.complete)) refreshing = false;
    // Checked this pass, in this currency: the days after its oldest
    const whole = sameMoney && !c.complete && c.oldest != null ? dayAfter(c.oldest) : null;
    if (whole == null) from = null;
    else if (from != null && whole > from) from = whole;
  }
  if (checkedAt === Infinity) checkedAt = null;
  if (complete) return { complete, from: null, refreshing: false, expired: false, checkedAt };
  if (expired) return { complete, from: null, refreshing: false, expired, checkedAt };
  return { complete, from, refreshing, expired: false, checkedAt };
}

/** Whether `onDevice` holds every day from `from` on, checked */
export const holdsFrom = (onDevice: OnDevice, from: string | null) =>
  onDevice.complete || (onDevice.from != null && from != null && from >= onDevice.from);

const cursorOf = (t: Transaction) => `${t.date}_${t.time ?? ''}_${t.createdAt}_${t.id}`;

/** Those after `before` (a server's cursor), newest first; all of them for none */
function after(sorted: Transaction[], before: string | null) {
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
 * What the last search found, newest first, for its next pages ("Load more") without
 * reading it all again: kept while nothing was written since its first page
 */
let lastSearch: { key: string; writes: number; found: Transaction[] } | null = null;

/**
 * A page of what a search finds, from the device, as the server would answer it (newest
 * first, `limit` at a time from `before`, optionally with what matches beyond); null when the
 * device holds nothing of the accounts concerned, or can't be read
 */
export async function localSearchPage(
  query: SearchQuery,
  categories: readonly Category[],
  accountIds: string[],
  currency: string | null,
  before: string | null,
  limit: number,
  rowsOnly = false,
): Promise<PageOnDevice<SearchPage> | PageOnDevice | null> {
  const email = cacheUser();
  if (email == null || unreadable) return null;
  const stillMine = stillMineFor(email, generation);
  try {
    const concerned = query.account != null ? [query.account] : accountIds;
    const onDevice = await onDeviceFor(email, concerned, currency);
    if (onDevice == null) return null;
    const read = async (q: SearchQuery) =>
      (await readEntries(email, narrowing(q, categories)))
        .filter((t) => matchesSearch(t, q, categories))
        .sort(newestFirst);
    const key = `${email}?${new URLSearchParams(searchParams(query)).toString()}`;
    let all: Transaction[];
    if (before != null && lastSearch?.key === key && lastSearch.writes === writes) {
      all = lastSearch.found;
    } else {
      all = await read(query);
      if (!stillMine()) return null;
      lastSearch = { key, writes, found: all };
    }
    const found = after(all, before);
    const page = found.slice(0, limit);
    const last = found.length > limit ? page.at(-1)! : null;
    const rows = {
      transactions: page,
      nextBefore: last == null ? null : cursorOf(last),
      onDevice,
    };
    if (rowsOnly) return stillMine() ? rows : null;
    const beyond = found.slice(limit);
    const first = before == null;
    // How many match on other days: said only where nothing is found here, so read only then
    let elsewhere: number | undefined;
    if (first && (query.from != null || query.to != null)) {
      elsewhere =
        all.length > 0
          ? 0
          : (await read({ ...query, from: null, to: null })).filter(
              (t) => !matchesSearch(t, query, categories),
            ).length;
    }
    const anywhere = first ? !onDevice.complete || (await holdsAny(email)) : undefined;
    if (!stillMine()) return null;
    return {
      ...rows,
      rest: sum(beyond),
      restOfLastDay:
        last == null
          ? null
          : { date: last.date, ...sum(beyond.filter((t) => t.date === last.date)) },
      ...(elsewhere != null && { elsewhere }),
      // A download not done may hold none yet: never said to be nothing at all
      ...(anywhere != null && { anywhere }),
    };
  } catch (err) {
    if (stillMine()) storageFailed(err);
    return null;
  }
}

/**
 * A page of one account's entries from the device, as the server would answer it, read
 * straight from where `before` says; null when its download hasn't started, or the
 * device can't be read
 */
export async function localAccountPage(
  accountId: string,
  before: string | null,
  currency: string | null,
): Promise<PageOnDevice | null> {
  const email = cacheUser();
  if (email == null || unreadable) return null;
  const stillMine = stillMineFor(email, generation);
  try {
    const onDevice = await onDeviceFor(email, [accountId], currency);
    if (onDevice == null) return null;
    const found = await accountEntries(email, accountId, before, ACCOUNT_PAGE + 1);
    if (!stillMine()) return null;
    const page = found.slice(0, ACCOUNT_PAGE);
    return {
      transactions: page,
      nextBefore: found.length > ACCOUNT_PAGE ? cursorOf(page.at(-1)!) : null,
      onDevice,
    };
  } catch (err) {
    if (stillMine()) storageFailed(err);
    return null;
  }
}

/**
 * One account's entries held on the device from `fromDay`, with how much of its history
 * is held, in `currency`; null when none is
 */
export async function localSince(accountId: string, fromDay: string, currency: string | null) {
  const email = cacheUser();
  if (email == null || unreadable) return null;
  const stillMine = stillMineFor(email, generation);
  try {
    const onDevice = await onDeviceFor(email, [accountId], currency);
    if (onDevice == null) return null;
    const rows = await readEntries(email, { by: 'account', accountId });
    return stillMine() ? { transactions: rows.filter((t) => t.date >= fromDay), onDevice } : null;
  } catch (err) {
    if (stillMine()) storageFailed(err);
    return null;
  }
}
