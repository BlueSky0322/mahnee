import type { Account, LedgerChange } from '@shared/api';
import { api } from '../api';
import { onCacheCleared, readCache, writeCache } from '../offline/cache';
import { isOfflineFailure } from '../offline/network';
import { queryClient } from '../query-client';
import { showError } from '../utils/notify';
import { apply } from './apply';
import { createSaveQueue } from './save-queue';

// A person's ledger (so far, their accounts), kept in the query cache so every screen
// shows the same copy. change() is the only way it changes: each change shows straight
// away, then is sent in order with the others. A refused change is put back and
// explained, with everything made after it, and once nothing is left to send the ledger
// is fetched again, so it shows what the server has. The screens read it through
// useLedger.ts.

export const ACCOUNTS_KEY = ['accounts'] as const;
/** Versioned like the other saved copies: one in an older shape is never read */
const CACHE_KEY = 'accounts-v1';

/**
 * What the server has, as far as this page knows: its last copy, with the changes it has
 * saved since. Shown again when a change is refused. Null before anything is loaded.
 */
let confirmed: Account[] | null = null;
/** Batches saved so far: a copy fetched while one was saved may not have it */
let savedCount = 0;

const queue = createSaveQueue({
  send: (body) => api.saveChanges(body),
  saved: (changes) => {
    savedCount++;
    if (confirmed != null) confirmed = apply(confirmed, changes);
  },
  failed: (err) => {
    showError(err, "Couldn't save that change. Check your connection and try again.");
    if (confirmed != null) queryClient.setQueryData(ACCOUNTS_KEY, confirmed);
  },
  idle: () => void reloadAccounts(),
});

// Signing out, or someone else signing in: nothing made before is sent. What the
// server last sent stays, since the server only ever sends the signed-in person's own.
onCacheCleared(() => queue.forget());

/**
 * The accounts from the server, with the changes still being sent shown on top. Offline,
 * the copy kept on this device.
 */
export async function fetchAccounts({ signal }: { signal?: AbortSignal } = {}): Promise<Account[]> {
  const savedBefore = savedCount;
  let accounts: Account[];
  try {
    ({ accounts } = await api.listAccounts());
  } catch (err) {
    if (!isOfflineFailure(err)) throw err;
    const kept = await readCache<Account[]>(CACHE_KEY);
    if (kept == null) throw err;
    accounts = kept;
  }
  const shown = queryClient.getQueryData<Account[]>(ACCOUNTS_KEY);
  // A change was saved while this was on its way, so this copy may be from before it:
  // what's shown stays, and the copy fetched once nothing is left to send replaces it
  if (signal?.aborted || (savedCount !== savedBefore && shown != null)) return shown ?? accounts;
  confirmed = accounts;
  void writeCache(CACHE_KEY, accounts);
  return apply(accounts, queue.pending());
}

/**
 * Shows the copy kept on this device while the first fresh one loads, unless something
 * is showing already
 */
export function showKeptCopy() {
  if (queryClient.getQueryData(ACCOUNTS_KEY) !== undefined) return;
  void readCache<Account[]>(CACHE_KEY).then((kept) => {
    if (kept == null || queryClient.getQueryState(ACCOUNTS_KEY)?.dataUpdatedAt) return;
    // Marked as old, so it's shown but still fetched
    queryClient.setQueryData(ACCOUNTS_KEY, apply(kept, queue.pending()), { updatedAt: 0 });
  });
}

/** Fetches the accounts again, if anything is showing them */
export const reloadAccounts = () => queryClient.refetchQueries({ queryKey: ACCOUNTS_KEY });

/**
 * Makes changes to the ledger: shown straight away, then saved in the background, in
 * order. Check them first (shared/ledger.ts); one the server refuses is put back with
 * everything made after it, and its explanation shown.
 */
export function change(...changes: LedgerChange[]) {
  queryClient.setQueryData<Account[]>(ACCOUNTS_KEY, (old) => old && apply(old, changes));
  queue.add(changes);
}
