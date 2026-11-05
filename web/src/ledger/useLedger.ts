import { useQuery } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import type { Account, Category, Ledger } from '@shared/api';
import type { CategoryTree } from './category-tree';
import { categoryTree } from './category-tree';
import type { QueueState } from './save-queue';
import { LEDGER_KEY, fetchLedger, showKeptCopy, subscribeUnsaved, unsavedState } from './ledger';

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
