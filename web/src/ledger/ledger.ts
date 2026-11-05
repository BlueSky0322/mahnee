import type { Ledger, LedgerChange } from '@shared/api';
import { categoriesOrDefaults } from '@shared/categories';
import { api } from '../api';
import { onCacheCleared, onCacheUserKnown, readCache, writeCache } from '../offline/cache';
import { isOfflineFailure } from '../offline/network';
import { queryClient } from '../query-client';
import { showError } from '../utils/notify';
import { apply } from './apply';
import { createSaveQueue } from './save-queue';

// A person's ledger (their accounts and categories), kept in the query cache so every screen
// shows the same copy. change() is the only way it changes: each change shows straight
// away, is kept on the device until it's saved, and is sent in order with the others
// (save-queue.ts), offline or not. A refused change is put back and explained, with
// everything made after it, and once nothing is left to send the ledger is fetched
// again, so it shows what the server has. The screens read it through useLedger.ts.

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

const queue = createSaveQueue({
  send: (body) => api.saveChanges(body),
  saved: (changes) => {
    savedCount++;
    if (confirmed != null) confirmed = apply(confirmed, changes);
  },
  // Made before a reload, or in another tab: shown on top, as the ones made here are
  found: (changes) =>
    queryClient.setQueryData<Ledger>(LEDGER_KEY, (old) => old && apply(old, changes)),
  failed: (err) => {
    showError(err, "Couldn't save that change.");
    if (confirmed != null) queryClient.setQueryData(LEDGER_KEY, confirmed);
  },
  idle: () => void reloadLedger(),
});

// Once it's known whose the ledger is, what they left unsent on this device is picked
// up and sent
onCacheUserKnown((email) => void queue.pickUp(email));
// Signing out, or someone else signing in: nothing made before is sent from this page
// (what's kept on the device stays its owner's). What the server last sent stays, since
// the server only ever sends the signed-in person's own.
onCacheCleared(() => queue.forget());

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
  return apply(ledger, queue.pending());
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
 * (shared/ledger.ts, shared/categories.ts); one the server refuses is put back with everything made after it,
 * and its explanation shown.
 */
export function change(...changes: LedgerChange[]) {
  queryClient.setQueryData<Ledger>(LEDGER_KEY, (old) => old && apply(old, changes));
  queue.add(changes);
}
