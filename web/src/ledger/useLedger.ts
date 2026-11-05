import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import type { Account, Category, Ledger, Transaction, TransactionPage } from '@shared/api';
import type { CategoryTree } from './category-tree';
import { categoryTree } from './category-tree';
import type { QueueState } from './save-queue';
import {
  LEDGER_KEY,
  accountTransactionsKey,
  fetchLedger,
  fetchTransactionPage,
  pendingChanges,
  shownPages,
  showKeptCopy,
  subscribeUnsaved,
  unsavedState,
} from './ledger';

// The ledger for the screens that show it (see ledger.ts, which changes it)

interface Loaded<T> {
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

/**
 * Changes made on this device the server hasn't saved yet (offline, say), and whether
 * sending them waits on signing in again
 */
export const useUnsaved = (): QueueState => useSyncExternalStore(subscribeUnsaved, unsavedState);

export interface Transactions {
  /** Newest first, changes still to send included; null until the first page loads */
  transactions: Transaction[] | null;
  failed: boolean;
  retry: () => void;
  /** More can be loaded, older than these */
  hasMore: boolean;
  loadMore: () => void;
  loadingMore: boolean;
}

/** An account's transactions, newest first, a page at a time */
export function useAccountTransactions(accountId: string): Transactions {
  const key = accountTransactionsKey(accountId);
  // Worked out again whenever what's still to send changes
  const pending = useSyncExternalStore(subscribeUnsaved, pendingChanges);
  const select = useCallback(
    (data: { pages: TransactionPage[]; pageParams: (string | null)[] }) =>
      shownPages(accountTransactionsKey(accountId), data, pending),
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
    transactions: data ?? null,
    failed: isError && data == null,
    retry: () => void refetch(),
    hasMore: hasNextPage,
    loadMore: () => void fetchNextPage(),
    loadingMore: isFetchingNextPage,
  };
}
