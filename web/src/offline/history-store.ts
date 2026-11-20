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
// a payee. An entry changed or deleted on this device is marked with when (`localAt`; a
// deleted one is kept as `removed` until the server's pages no longer list it), so a page
// fetched before then, by this tab or another, never puts it back as it was. `coverage`
// says, per account, how far its download has got; it only ever moves forward.

const DB_NAME = 'mahnee-history';
const DB_VERSION = 1;
const ENTRIES = 'entries';
const COVERAGE = 'coverage';
/** The note, among the coverage, of which tab is downloading (where Web Locks aren't) */
const DOWNLOADING = '~downloading';
/** How long a tab holds the download without saying it's still at it */
export const DOWNLOAD_HOLD_MS = 60_000;

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
  /** When it was changed on this device (ms), until the server's own copy replaces it */
  localAt?: number;
  /** Deleted on this device */
  removed?: true;
}

/** How much of one account's history is on the device */
export interface Coverage {
  email: string;
  accountId: string;
  /** Where this pass carries on from (the server's nextBefore); null to start at the top */
  next: string | null;
  /** The oldest day this pass has reached; null before its first page */
  oldest: string | null;
  /** The newest entry held when the device last looked for new ones (orderOf) */
  newest: string | null;
  /** This pass has reached the account's first entry: every entry is as the server had it */
  complete: boolean;
  /** An earlier pass reached the first entry: entries below this pass are held, maybe stale */
  held: boolean;
  /** Entries this pass has downloaded, at most MAX_TRANSACTIONS_PER_ACCOUNT */
  rows: number;
  /** When this pass started (ms): a later pass replaces an earlier one's progress */
  pass: number;
  /** When a pass last reached the first entry (ms); null before one has */
  verifiedAt: number | null;
  /** The home currency its amounts are in */
  currency: string;
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

const done = <T>(req: IDBRequest) =>
  new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result as T);
    req.onerror = () => reject(req.error ?? new Error('History storage failed'));
  });

const finished = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('History storage failed'));
    tx.onabort = () => reject(tx.error ?? new Error('History storage stopped'));
  });

/** The history was emptied (signed out, or someone else) while this was on its way */
export class HistoryForgotten extends Error {}

/** Writing to the history failed (full, say): what's held can still be read */
export class HistoryWriteFailed extends Error {
  constructor(public cause: unknown) {
    super('History could not be written');
  }
}

/**
 * Runs `work` in one transaction over both stores, made at once (in the same turn as the
 * caller's checks, so nothing is written for an account after its history was emptied),
 * all of it or none. Rejects when storage fails; a write failing as HistoryWriteFailed.
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
  try {
    const result = await work(tx.objectStore(ENTRIES), tx.objectStore(COVERAGE));
    await end;
    return result;
  } catch (err) {
    try {
      tx.abort();
    } catch {
      // Over already
    }
    end.catch(() => undefined);
    throw mode === 'readwrite' ? new HistoryWriteFailed(err) : err;
  }
}

const rowOf = (email: string, t: Transaction, localAt?: number): Row => ({
  email,
  id: t.id,
  accountId: t.accountId,
  toAccountId: t.toAccountId,
  categoryId: t.categoryId,
  date: t.date,
  order: orderOf(t),
  t,
  ...(localAt != null && { localAt }),
});

/** Whether a held row was changed here after `askedAt`, so a page asked for then is older */
const newerHere = (row: Row | undefined, askedAt: number) =>
  row?.localAt != null && row.localAt > askedAt;

/** Rows on `accountId` (from it, or a transfer into it) between two places, `low` included */
async function rowsOnAccount(
  entries: IDBObjectStore,
  email: string,
  accountId: string,
  low: string,
  high: string,
): Promise<Row[]> {
  const range = IDBKeyRange.bound([email, accountId, low], [email, accountId, high], false, true);
  const [from, to] = await Promise.all([
    done<Row[]>(entries.index('account').getAll(range)),
    done<Row[]>(entries.index('toAccount').getAll(range)),
  ]);
  return [...from, ...to];
}

/** Whether `next` is ahead of `kept`: a later pass, or further on in the same one */
const ahead = (next: Coverage, kept: Coverage | undefined) =>
  kept == null ||
  next.pass > kept.pass ||
  (next.pass === kept.pass && next.rows >= kept.rows && (!kept.complete || next.complete));

/**
 * Keeps a page of an account's entries as the server listed them (asked for at
 * `askedAt`), newest first: they replace whatever this device held on the account between
 * where the page starts (`before`'s place, or the top) and where it ends (its last entry,
 * or the bottom when none follow), so one deleted elsewhere goes too; but for entries
 * changed here since it was asked for. With `coverage`, notes how far the download has
 * got, in the same transaction, unless another tab has got further.
 */
export function keepAccountPage(
  email: string,
  accountId: string,
  before: string | null,
  page: { transactions: Transaction[]; nextBefore: string | null },
  coverage: Coverage | null,
  stillMine: () => boolean,
  askedAt: number,
): Promise<void> {
  const high = before == null ? TOP : orderOfCursor(before) ?? TOP;
  const last = page.transactions.at(-1);
  const low = page.nextBefore == null || last == null ? '' : orderOf(last);
  return inTransaction(
    'readwrite',
    async (entries, covered) => {
      const listed = new Map(page.transactions.map((t) => [t.id, t]));
      const inRange = await rowsOnAccount(entries, email, accountId, low, high);
      for (const row of inRange) {
        if (!listed.has(row.id) && !newerHere(row, askedAt)) entries.delete([email, row.id]);
      }
      await putUnlessNewer(entries, email, page.transactions, askedAt);
      if (coverage != null) {
        const kept = await done<Coverage | undefined>(covered.get([email, accountId]));
        if (ahead(coverage, kept)) covered.put(coverage);
      }
    },
    stillMine,
  );
}

/** Puts each entry as the server has it, but for those changed here since `askedAt` */
async function putUnlessNewer(
  entries: IDBObjectStore,
  email: string,
  transactions: Transaction[],
  askedAt: number,
) {
  const held = await Promise.all(
    transactions.map((t) => done<Row | undefined>(entries.get([email, t.id]))),
  );
  transactions.forEach((t, i) => {
    if (!newerHere(held[i], askedAt)) entries.put(rowOf(email, t));
  });
}

/** Keeps entries as the server had them at `askedAt`, each replacing what was held for it */
export const keepEntries = (
  email: string,
  transactions: Transaction[],
  stillMine: () => boolean,
  askedAt: number,
) =>
  transactions.length === 0
    ? Promise.resolve()
    : inTransaction(
        'readwrite',
        (entries) => putUnlessNewer(entries, email, transactions, askedAt),
        stillMine,
      );

/** Entries held by id: undefined for one not held (or deleted here) */
export const heldByIds = (email: string, ids: string[]) =>
  inTransaction('readonly', (entries) =>
    Promise.all(
      ids.map(async (id) => {
        const row = await done<Row | undefined>(entries.get([email, id]));
        return row?.removed ? undefined : row?.t;
      }),
    ),
  );

/**
 * Changes held entries as saved from this device: each id to its entry as it is now, or
 * null once deleted (kept marked, so an older page doesn't bring it back)
 */
export const changeEntries = (
  email: string,
  changed: Map<string, Transaction | null>,
  stillMine: () => boolean,
) =>
  inTransaction(
    'readwrite',
    async (entries) => {
      const at = Date.now();
      for (const [id, t] of changed) {
        if (t != null) {
          entries.put(rowOf(email, t, at));
          continue;
        }
        const row = await done<Row | undefined>(entries.get([email, id]));
        if (row != null) entries.put({ ...row, localAt: at, removed: true });
      }
    },
    stillMine,
  );

const coverageRange = (email: string) => IDBKeyRange.bound([email, ''], [email, TOP]);

/** How far each of `email`'s accounts has been downloaded */
export const readCoverage = (email: string) =>
  inTransaction('readonly', async (_, coverage) =>
    (await done<Coverage[]>(coverage.getAll(coverageRange(email)))).filter(
      (c) => c.accountId !== DOWNLOADING,
    ),
  );

/**
 * Starts each of `email`'s downloads again from the top (`pass` the time it starts), after
 * changes this device can't follow (an import undone): what's held stays, shown as held
 * but being refreshed, and is replaced page by page
 */
export const restartCoverage = (email: string, stillMine: () => boolean, pass: number) =>
  inTransaction(
    'readwrite',
    async (_, coverage) => {
      for (const c of await done<Coverage[]>(coverage.getAll(coverageRange(email)))) {
        if (c.accountId === DOWNLOADING) continue;
        coverage.put(restarted(c, pass));
      }
    },
    stillMine,
  );

/** A coverage started again from the top, what it held still held */
export const restarted = (c: Coverage, pass: number, currency = c.currency): Coverage => ({
  ...c,
  next: null,
  oldest: null,
  complete: false,
  held: c.held || c.complete,
  rows: 0,
  pass,
  currency,
});

/**
 * Takes the download for `tab`, or keeps it taken, unless another tab has it and said so
 * within DOWNLOAD_HOLD_MS. Resolves with whether `tab` has it.
 */
export const takeDownload = (email: string, tab: string, now: number) =>
  inTransaction('readwrite', async (_, coverage) => {
    const held = await done<{ tab: string; until: number } | undefined>(
      coverage.get([email, DOWNLOADING]),
    );
    if (held != null && held.tab !== tab && held.until > now) return false;
    coverage.put({ email, accountId: DOWNLOADING, tab, until: now + DOWNLOAD_HOLD_MS });
    return true;
  });

/** Lets the download go, if `tab` has it */
export const letDownloadGo = (email: string, tab: string) =>
  inTransaction('readwrite', async (_, coverage) => {
    const held = await done<{ tab: string } | undefined>(coverage.get([email, DOWNLOADING]));
    if (held?.tab === tab) coverage.delete([email, DOWNLOADING]);
  });

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
      found = await rowsOnAccount(entries, email, narrowed.accountId, '', TOP);
    } else if (narrowed.by === 'categories') {
      const { from, to } = narrowed;
      const each = await Promise.all(
        narrowed.ids.map((id) =>
          done<Row[]>(
            entries
              .index('category')
              .getAll(IDBKeyRange.bound([email, id, from ?? ''], [email, id, to ?? TOP])),
          ),
        ),
      );
      found = each.flat();
    } else {
      found = await done<Row[]>(
        entries
          .index('date')
          .getAll(IDBKeyRange.bound([email, narrowed.from ?? ''], [email, narrowed.to ?? TOP])),
      );
    }
    const seen = new Set<string>();
    return found
      .filter((r) => !r.removed && !seen.has(r.id) && Boolean(seen.add(r.id)))
      .map((r) => r.t);
  });

/** Up to `count` rows from one index, newest first, below `high`, skipping deleted ones */
function newestRows(index: IDBIndex, range: IDBKeyRange, count: number): Promise<Row[]> {
  return new Promise((resolve, reject) => {
    const rows: Row[] = [];
    const req = index.openCursor(range, 'prev');
    req.onerror = () => reject(req.error ?? new Error('History storage failed'));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor == null || rows.length >= count) return resolve(rows);
      const row = cursor.value as Row;
      if (!row.removed) rows.push(row);
      cursor.continue();
    };
  });
}

/**
 * One account's entries, newest first, below `before`'s place (the top when null): at
 * most `count`, read straight from the account's indexes, however many it holds
 */
export const accountEntries = (
  email: string,
  accountId: string,
  before: string | null,
  count: number,
): Promise<Transaction[]> =>
  inTransaction('readonly', async (entries) => {
    const high = before == null ? TOP : orderOfCursor(before) ?? TOP;
    const range = IDBKeyRange.bound([email, accountId, ''], [email, accountId, high], false, true);
    const [from, to] = await Promise.all([
      newestRows(entries.index('account'), range, count),
      newestRows(entries.index('toAccount'), range, count),
    ]);
    return [...from, ...to]
      .sort((a, b) => (a.order < b.order ? 1 : a.order > b.order ? -1 : 0))
      .slice(0, count)
      .map((r) => r.t);
  });

/** Whether `email` has any entry held */
export const holdsAny = (email: string) =>
  inTransaction(
    'readonly',
    async (entries) =>
      (await done<number>(entries.count(IDBKeyRange.bound([email, ''], [email, TOP])))) > 0,
  );

/** How many entries are held, whoever's: for checking that signing out leaves none */
export const heldEntries = () =>
  inTransaction('readonly', (entries) => done<number>(entries.count()));

/** Deletes every account's history from this device */
export const forgetHistory = () =>
  inTransaction('readwrite', (entries, coverage) => {
    entries.clear();
    coverage.clear();
  });
