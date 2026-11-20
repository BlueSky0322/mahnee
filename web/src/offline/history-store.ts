import type { Transaction } from '@shared/api';

// The signed-in person's transaction history kept on this device (ledger/history.ts
// downloads it and keeps it up to date), so Activity and an account's entries work
// offline. Its own IndexedDB database, beside the saved copies (cache.ts): every entry
// and every note of what's held is tagged with the email it was downloaded as, every
// read asks for one email's alone, and everything is deleted when the cache is emptied
// (signing out, someone else signing in).
//
// `entries` holds one row per transaction, by [email, id], indexed by day (Activity's
// days), by the account it's on and the one a transfer went to (an account's entries,
// Activity's account filter) and by category (Activity's category filter); words are
// found by reading the rows those narrow down to, as no index finds text in the middle of
// a payee. `coverage` says, per account, how far back its download has got.

const DB_NAME = 'mahnee-history';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const COVERAGE = 'coverage';

/** An entry as kept: the transaction, with what its indexes read */
interface Row {
  email: string;
  id: string;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  date: string;
  /** Sorts oldest first as the server lists newest first (orderOf) */
  order: string;
  t: Transaction;
}

/** How much of one account's history is on the device */
export interface Coverage {
  email: string;
  accountId: string;
  /** Where the download carries on from (the server's nextBefore); null to start at the top */
  next: string | null;
  /** The oldest day held so far; null before the first page */
  oldest: string | null;
  /** The newest entry held when the device last looked for new ones (orderOf) */
  newest: string | null;
  /** Every entry down to the account's first is held */
  complete: boolean;
  /** Entries downloaded for it, at most MAX_TRANSACTIONS_PER_ACCOUNT */
  rows: number;
}

/**
 * An entry's place, as text that sorts oldest first exactly as the server lists newest
 * first: day, time of day (none before any), when it was saved, id
 */
export const orderOf = (t: Pick<Transaction, 'date' | 'time' | 'createdAt' | 'id'>) =>
  `${t.date}_${t.time ?? ''}_${String(t.createdAt).padStart(15, '0')}_${t.id}`;

/** The place a server's cursor (day_time_saved_id) names; null when it isn't one */
export function orderOfCursor(cursor: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})_([^_]*)_(\d{1,15})_([0-9a-f]{16})$/.exec(cursor);
  return m == null ? null : `${m[1]}_${m[2]}_${m[3].padStart(15, '0')}_${m[4]}`;
}

/** Past every place (orders start with a digit) */
const TOP = '￿';

let opening: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  opening ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      const entries = db.createObjectStore(ENTRIES, { keyPath: ['email', 'id'] });
      entries.createIndex('date', ['email', 'date']);
      entries.createIndex('account', ['email', 'accountId', 'order']);
      entries.createIndex('toAccount', ['email', 'toAccountId', 'order']);
      entries.createIndex('category', ['email', 'categoryId', 'date']);
      db.createObjectStore(COVERAGE, { keyPath: ['email', 'accountId'] });
    };
    req.onsuccess = () => {
      // Another tab upgrading it: let go, and open again when next asked
      req.result.onversionchange = () => {
        req.result.close();
        opening = null;
      };
      resolve(req.result);
    };
    req.onerror = () => reject(req.error ?? new Error('History storage unavailable'));
    req.onblocked = () => reject(new Error('History storage blocked'));
  }).catch((err: unknown) => {
    opening = null;
    throw err;
  });
  return opening;
}

const done = (req: IDBRequest) =>
  new Promise<unknown>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('History storage failed'));
  });

const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('History storage failed'));
    tx.onabort = () => reject(tx.error ?? new Error('History storage stopped'));
  });

/**
 * Runs `work` in one transaction over both stores, made at once (in the same turn as the
 * caller's checks, so nothing is written for an account after its history was emptied).
 * Rejects when storage fails.
 */
async function inTransaction<T>(
  mode: IDBTransactionMode,
  work: (entries: IDBObjectStore, coverage: IDBObjectStore) => Promise<T> | T,
  stillMine: () => boolean = () => true,
): Promise<T> {
  const db = await open();
  if (!stillMine()) throw new HistoryForgotten();
  const tx = db.transaction([ENTRIES, COVERAGE], mode);
  const end = finished(tx);
  const result = await work(tx.objectStore(ENTRIES), tx.objectStore(COVERAGE));
  await end;
  return result;
}

/** The history was emptied (signed out, or someone else) while this was on its way */
export class HistoryForgotten extends Error {}

const rowOf = (email: string, t: Transaction): Row => ({
  email,
  id: t.id,
  accountId: t.accountId,
  toAccountId: t.toAccountId,
  categoryId: t.categoryId,
  date: t.date,
  order: orderOf(t),
  t,
});

/** Rows on `accountId` (from it, or a transfer into it) between two places, `low` included */
async function idsOnAccount(
  entries: IDBObjectStore,
  email: string,
  accountId: string,
  low: string,
  high: string,
): Promise<string[]> {
  const range = IDBKeyRange.bound([email, accountId, low], [email, accountId, high], false, true);
  const [from, to] = await Promise.all([
    done(entries.index('account').getAllKeys(range)),
    done(entries.index('toAccount').getAllKeys(range)),
  ]);
  return [...(from as IDBValidKey[][]), ...(to as IDBValidKey[][])].map((k) => k[1] as string);
}

/**
 * Keeps a page of an account's entries as the server listed them, newest first: they
 * replace whatever this device held on the account between where the page starts
 * (`before`'s place, or the top) and where it ends (its last entry, or the bottom when
 * none follow), so one deleted elsewhere goes too. With `coverage`, notes how far the
 * download has got, in the same transaction.
 */
export function keepAccountPage(
  email: string,
  accountId: string,
  before: string | null,
  page: { transactions: Transaction[]; nextBefore: string | null },
  coverage: Coverage | null,
  stillMine: () => boolean,
): Promise<void> {
  const high = before == null ? TOP : orderOfCursor(before) ?? TOP;
  const last = page.transactions.at(-1);
  const low = page.nextBefore == null || last == null ? '' : orderOf(last);
  return inTransaction(
    'readwrite',
    async (entries, covered) => {
      const kept = new Set(page.transactions.map((t) => t.id));
      const held = await idsOnAccount(entries, email, accountId, low, high);
      for (const id of held) if (!kept.has(id)) entries.delete([email, id]);
      for (const t of page.transactions) entries.put(rowOf(email, t));
      if (coverage != null) covered.put(coverage);
    },
    stillMine,
  );
}

/** Keeps entries as the server has them, each replacing what was held for it */
export const keepEntries = (
  email: string,
  transactions: Transaction[],
  stillMine: () => boolean,
) =>
  transactions.length === 0
    ? Promise.resolve()
    : inTransaction(
        'readwrite',
        (entries) => {
          for (const t of transactions) entries.put(rowOf(email, t));
        },
        stillMine,
      );

/** Entries held by id: undefined for one not held */
export const heldByIds = (email: string, ids: string[]) =>
  inTransaction('readonly', (entries) =>
    Promise.all(
      ids.map(async (id) => ((await done(entries.get([email, id]))) as Row | undefined)?.t),
    ),
  );

/** Changes held entries: each id to its entry as it is now, or null to delete it */
export const changeEntries = (
  email: string,
  changed: Map<string, Transaction | null>,
  stillMine: () => boolean,
) =>
  inTransaction(
    'readwrite',
    (entries) => {
      for (const [id, t] of changed) {
        if (t == null) entries.delete([email, id]);
        else entries.put(rowOf(email, t));
      }
    },
    stillMine,
  );

/** How far each of `email`'s accounts has been downloaded */
export const readCoverage = (email: string) =>
  inTransaction(
    'readonly',
    async (_, coverage) =>
      (await done(coverage.getAll(IDBKeyRange.bound([email, ''], [email, TOP])))) as Coverage[],
  );

/**
 * Starts `email`'s downloads again from the top (after changes this device can't follow,
 * such as an import undone): what's held stays shown, and is replaced page by page
 */
export const restartCoverage = (email: string, stillMine: () => boolean) =>
  inTransaction(
    'readwrite',
    (_, coverage) => {
      coverage.delete(IDBKeyRange.bound([email, ''], [email, TOP]));
    },
    stillMine,
  );

/** Which entries a read narrows to before the words and the other filters are checked */
export type Narrowed =
  | { by: 'account'; accountId: string }
  | { by: 'categories'; ids: string[]; from: string | null; to: string | null }
  | { by: 'days'; from: string | null; to: string | null };

/** `email`'s entries, narrowed by one index; the caller filters and orders them */
export const readEntries = (email: string, narrowed: Narrowed): Promise<Transaction[]> =>
  inTransaction('readonly', async (entries) => {
    let found: Row[];
    if (narrowed.by === 'account') {
      const range = IDBKeyRange.bound(
        [email, narrowed.accountId, ''],
        [email, narrowed.accountId, TOP],
      );
      const [from, to] = await Promise.all([
        done(entries.index('account').getAll(range)),
        done(entries.index('toAccount').getAll(range)),
      ]);
      found = [...(from as Row[]), ...(to as Row[])];
    } else if (narrowed.by === 'categories') {
      const { from, to } = narrowed;
      const each = await Promise.all(
        narrowed.ids.map((id) =>
          done(
            entries
              .index('category')
              .getAll(IDBKeyRange.bound([email, id, from ?? ''], [email, id, to ?? TOP])),
          ),
        ),
      );
      found = (each as Row[][]).flat();
    } else {
      found = (await done(
        entries
          .index('date')
          .getAll(IDBKeyRange.bound([email, narrowed.from ?? ''], [email, narrowed.to ?? TOP])),
      )) as Row[];
    }
    const seen = new Set<string>();
    return found.filter((r) => !seen.has(r.id) && Boolean(seen.add(r.id))).map((r) => r.t);
  });

/** Whether `email` has any entry held */
export const holdsAny = (email: string) =>
  inTransaction(
    'readonly',
    async (entries) =>
      ((await done(entries.count(IDBKeyRange.bound([email, ''], [email, TOP])))) as number) > 0,
  );

/** How many entries are held, whoever's: for checking that signing out leaves none */
export const heldEntries = () =>
  inTransaction('readonly', async (entries) => (await done(entries.count())) as number);

/** Deletes every account's history from this device */
export const forgetHistory = () =>
  inTransaction('readwrite', (entries, coverage) => {
    entries.clear();
    coverage.clear();
  });
