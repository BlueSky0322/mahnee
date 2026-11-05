import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import type { Account } from '@shared/api';
import { ACCOUNTS_KEY, fetchAccounts, showKeptCopy } from './ledger';

// The ledger for the screens that show it (see ledger.ts, which changes it)

export interface Accounts {
  /** Every account, archived ones too, in the person's order; null until loaded */
  accounts: Account[] | null;
  /** Nothing could be loaded, and nothing was kept on this device */
  failed: boolean;
  /** Asks the server again */
  retry: () => void;
}

export function useAccounts(): Accounts {
  useEffect(showKeptCopy, []);
  const { data, isError, refetch } = useQuery({
    queryKey: ACCOUNTS_KEY,
    queryFn: ({ signal }) => fetchAccounts({ signal }),
  });
  return {
    accounts: data ?? null,
    failed: isError && data == null,
    retry: () => void refetch(),
  };
}
