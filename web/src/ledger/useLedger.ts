import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type {
  Account,
  Category,
  ImportRecord,
  Ledger,
  MonthSummary,
  MonthTrend,
  SearchPage,
  Transaction,
} from '@shared/api';
import type { SearchQuery } from '@shared/search';
import type { CategoryTree } from './category-tree';
import type { OnDevice, PageOnDevice } from './history';
import { historyUnavailable, subscribeHistory } from './history';
import { categoryTree } from './category-tree';
import type { Found as SearchFound } from './search-totals';
import { searchTotals } from './search-totals';
import type { QueueState, Refused } from './save-queue';
import {
  IMPORTS_KEY,
  LEDGER_KEY,
  applyToImports,
  fetchImports,
  accountTransactionsKey,
  dataAge,
  fetchLedger,
  fetchSummary,
  fetchTrend,
  fetchTransactionPage,
  searchTransactionsKey,
  pendingChanges,
  pendingWithIds,
  shownPages,
  shownSummary,
  shownTrend,
  showKeptCopy,
  summaryKey,
  trendKey,
  subscribeDataAge,
  subscribeUnsaved,
  unsavedState,
  needsAttention,
} from './ledger';
import { ApiError } from '../api';
import { queryClient } from '../query-client';

// The ledger for the screens that show it (see ledger.ts, which changes it)

export interface Loaded<T> {
  /** Null until loaded */
  data: T | null;
  /** Nothing could be loaded, and nothing was kept on this device */
  failed: boolean;
  /** Asks the server again */
  retry: () => void;
}

/** The ledger, or the part of it `select` picks (kept the same while the ledger is) */
function useLedgerPart<T>(select: (ledger: Ledger) => T): Loaded<T> {
  useEffect(showKeptCopy, []);
  const { data, isError, refetch } = useQuery({
    queryKey: LEDGER_KEY,
    queryFn: ({ signal }) => fetchLedger({ signal }),
    select,
    // A page opening after the first load failed, with nothing kept, says so and offers to
    // try again rather than asking by itself: asking would show it loading, and take the
    // tab bar or sidebar away, until it failed again. Try again, coming back online, a
    // return to the app and a saved change still ask.
    retryOnMount: false,
  });
  return { data: data ?? null, failed: isError && data == null, retry: () => void refetch() };
}

export interface Accounts {
  /** Every account, archived ones too, in the person's order; null until loaded */
  accounts: Account[] | null;
  failed: boolean;
  retry: () => void;
}

const pickAccounts = (ledger: Ledger) => ledger.accounts;

export function useAccounts(): Accounts {
  const { data, ...rest } = useLedgerPart(pickAccounts);
  return { accounts: data, ...rest };
}

export interface Categories {
  /** Every category, archived ones too; null until loaded */
  categories: Category[] | null;
  /** As listed: top level in order, each with its subcategories; null until loaded */
  tree: CategoryTree | null;
  failed: boolean;
  retry: () => void;
}

const pickCategories = (ledger: Ledger) => ({
  categories: ledger.categories,
  tree: categoryTree(ledger.categories),
});

export function useCategories(): Categories {
  const { data, ...rest } = useLedgerPart(pickCategories);
  return { categories: data?.categories ?? null, tree: data?.tree ?? null, ...rest };
}

const pickLedger = (ledger: Ledger) => ledger;

/**
 * The whole ledger as shown, for what works from its balances and repeating items together
 * (forecast.ts): one copy, so a log is never counted in both
 */
export function useWholeLedger(): Loaded<Ledger> {
  return useLedgerPart(pickLedger);
}

const subscribeLedgerShown = (listener: () => void) =>
  queryClient.getQueryCache().subscribe(listener);
const ledgerShown = () => queryClient.getQueryData(LEDGER_KEY) !== undefined;

/**
 * Whether the balances are showing yet, from the server or the device's copy, for what
 * waits on them without showing them itself: it neither asks for them nor shows the copy
 */
export const useLedgerShown = (): boolean =>
  useSyncExternalStore(subscribeLedgerShown, ledgerShown);

/**
 * Changes made on this device the server hasn't saved yet (offline, say), and whether
 * sending them waits on signing in again
 */
export const useUnsaved = (): QueueState => useSyncExternalStore(subscribeUnsaved, unsavedState);

/** Changes the server refused, kept for the person to try again or discard */
export const useNeedsAttention = (): Refused[] =>
  useSyncExternalStore(subscribeUnsaved, needsAttention);

export interface Transactions {
  /** Newest first, changes still to send included; null until the first page loads */
  transactions: Transaction[] | null;
  failed: boolean;
  retry: () => void;
  /** More can be loaded, older than these */
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
  /**
   * Read from the history on this device (offline), and how much of it the device holds;
   * null when from the server
   */
  onDevice: OnDevice | null;
}

/** How much the device holds, from the last page loaded when it came from there */
const onDeviceOf = (pages: PageOnDevice[]) => pages.at(-1)?.onDevice ?? null;

/**
 * Loads the next page. One loaded before the server changed how it names where a page
 * carries on from (entries gained a time) names it the old way, which the server refuses
 * (400): the list is then read again from the top, the rows staying on screen meanwhile,
 * and carries on from there
 */
async function loadNext(
  fetchNextPage: () => Promise<{ isError: boolean; error: unknown }>,
  refetch: () => Promise<{ isError: boolean }>,
) {
  const next = await fetchNextPage();
  if (!next.isError || !(next.error instanceof ApiError) || next.error.status !== 400) return;
  const again = await refetch();
  if (!again.isError) await fetchNextPage();
}

/** An account's transactions, newest first, a page at a time */
export function useAccountTransactions(accountId: string): Transactions {
  const key = accountTransactionsKey(accountId);
  // Worked out again whenever what's still to send changes
  const pending = useSyncExternalStore(subscribeUnsaved, pendingChanges);
  const select = useCallback(
    (data: { pages: PageOnDevice[]; pageParams: (string | null)[] }) => ({
      transactions: shownPages(accountTransactionsKey(accountId), data, pending),
      onDevice: onDeviceOf(data.pages),
    }),
    [accountId, pending],
  );
  const { data, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: key,
      queryFn: ({ pageParam }) => fetchTransactionPage(key, pageParam),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextBefore,
      select,
      // Asked for offline too, so the first page kept on the device shows
      networkMode: 'offlineFirst',
    });
  return {
    transactions: data?.transactions ?? null,
    failed: isError && data == null,
    retry: () => void refetch(),
    hasMore: hasNextPage,
    loadMore: () => void loadNext(fetchNextPage, refetch),
    loadingMore: isFetchingNextPage,
    onDevice: data?.onDevice ?? null,
  };
}

export interface Found extends Transactions {
  /**
   * What's found in all and on each day, counting what isn't loaded yet; null until the
   * first page loads
   */
  totals: SearchFound | null;
  /**
   * Loads what's left to find, page by page, until all of it is loaded or more than `enough`
   * are; answers what's loaded then
   */
  loadAll: (enough: number) => Promise<Transaction[]>;
}

/**
 * What a search finds (shared/search.ts), newest first, a page at a time; not asked while
 * `enabled` is false (the filters can't be checked yet)
 */
export function useSearch(query: SearchQuery, { enabled = true } = {}): Found {
  const key = searchTransactionsKey(query);
  const pending = useSyncExternalStore(subscribeUnsaved, pendingChanges);
  const value = key[2];
  const select = useCallback(
    (data: { pages: PageOnDevice[]; pageParams: (string | null)[] }) => {
      const transactions = shownPages(['transactions', 'search', value], data, pending);
      return {
        transactions,
        totals: searchTotals(transactions, data.pages as SearchPage[]),
        onDevice: onDeviceOf(data.pages),
      };
    },
    [value, pending],
  );
  const { data, isError, refetch, hasNextPage, fetchNextPage, isFetchingNextPage } =
    useInfiniteQuery({
      queryKey: key,
      queryFn: ({ pageParam }) => fetchTransactionPage(key, pageParam),
      initialPageParam: null as string | null,
      getNextPageParam: (last) => last.nextBefore,
      select,
      enabled,
      // Asked for offline too, so what's found in the history on this device shows
      networkMode: 'offlineFirst',
    });
  const loadAll = async (enough: number) => {
    let found = data?.transactions ?? [];
    let more = hasNextPage;
    while (more && found.length <= enough) {
      const next = await fetchNextPage();
      if (next.isError) break;
      found = next.data?.transactions ?? found;
      more = next.hasNextPage;
    }
    return found;
  };
  return {
    transactions: data?.transactions ?? null,
    totals: data?.totals ?? null,
    failed: isError && data == null,
    retry: () => void refetch(),
    hasMore: hasNextPage,
    loadMore: () => void loadNext(fetchNextPage, refetch),
    loadingMore: isFetchingNextPage,
    onDevice: data?.onDevice ?? null,
    loadAll,
  };
}

export interface Summary {
  /** The month's totals, changes still to send included; null until loaded */
  summary: MonthSummary | null;
  failed: boolean;
  retry: () => void;
}

/** What was spent and received in a month (2026-11), in total and by category */
export function useMonthSummary(month: string): Summary {
  const pending = useSyncExternalStore(subscribeUnsaved, pendingWithIds);
  const select = useCallback((data: MonthSummary) => shownSummary(data, pending), [pending]);
  const { data, isError, refetch } = useQuery({
    queryKey: summaryKey(month),
    queryFn: () => fetchSummary(month),
    select,
    // Asked for offline too, so the copy kept on the device shows
    networkMode: 'offlineFirst',
  });
  return { summary: data ?? null, failed: isError && data == null, retry: () => void refetch() };
}

export interface Trend {
  /** The 12 months ending at the month, changes still to send included; null until loaded */
  trend: MonthTrend | null;
  failed: boolean;
  retry: () => void;
}

/**
 * What was spent and received in each of the 12 months ending at `month` (2026-11), by
 * category: one read for all 12
 */
export function useMonthTrend(month: string): Trend {
  const pending = useSyncExternalStore(subscribeUnsaved, pendingWithIds);
  const select = useCallback((data: MonthTrend) => shownTrend(data, pending), [pending]);
  const { data, isError, refetch } = useQuery({
    queryKey: trendKey(month),
    queryFn: () => fetchTrend(month),
    select,
    // Asked for offline too, so the copy kept on the device shows
    networkMode: 'offlineFirst',
  });
  return { trend: data ?? null, failed: isError && data == null, retry: () => void refetch() };
}

/**
 * When the server last confirmed what Home shows for `month` (the balances and that
 * month's totals), while any of it came from this device's copy rather than fresh from the
 * server: 0 when that time isn't known; null while all of it is fresh
 */
export function useDataAge(month: string): number | null {
  const age = useCallback(() => dataAge(month), [month]);
  return useSyncExternalStore(subscribeDataAge, age);
}

export interface Imports {
  /** Recent imports, newest first, those recorded or undone here included; null until loaded */
  imports: ImportRecord[] | null;
  failed: boolean;
  retry: () => void;
}

/** The person's recent imports, as every device lists them (ledger.ts records and undoes them) */
export function useImports(): Imports {
  const pending = useSyncExternalStore(subscribeUnsaved, pendingChanges);
  const select = useCallback((data: ImportRecord[]) => applyToImports(data, pending), [pending]);
  const { data, isError, refetch } = useQuery({
    queryKey: IMPORTS_KEY,
    queryFn: fetchImports,
    select,
    // Asked for offline too, so the copy kept on the device shows
    networkMode: 'offlineFirst',
  });
  return { imports: data ?? null, failed: isError && data == null, retry: () => void refetch() };
}

/**
 * Whether this device couldn't keep or read the history it downloads, so what needs it
 * offline needs a connection instead
 */
export const useHistoryUnavailable = (): boolean =>
  useSyncExternalStore(subscribeHistory, historyUnavailable);
