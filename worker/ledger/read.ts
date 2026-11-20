// Reading a person's ledger: their accounts, each with its balance worked out here and
// never stored, so it can't drift from what makes it up, their categories, and their
// transactions a page at a time.

import type {
  Account,
  Category,
  FetchedRateSource,
  Ledger,
  Recurring,
  SearchPage,
  SearchTotals,
  Transaction,
  TransactionPage,
} from '../../shared/api';
import { categoriesOrDefaults } from '../../shared/categories';
import { categoriesIn, foldCase, readSearch, searchAmount } from '../../shared/search';
import { isRowId } from '../../shared/api';
import type { CategoryKind } from '../../shared/categories';
import type { AccountKind } from '../../shared/ledger';
import { fail, json, notFound } from '../http';
import { savedIdsStatement } from './receipts';

interface AccountRow {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingCents: number;
  balanceCents: number;
  position: number;
  archived: 0 | 1;
  archivedAt: number | null;
  createdAt: number;
}

interface CategoryRow {
  id: string;
  name: string;
  kind: CategoryKind;
  parentId: string | null;
  position: number;
  archived: 0 | 1;
}

/**
 * Every account of `email`, archived ones too, in their order. A balance is the opening
 * balance, plus what came in and less what was spent, summed for every account at once.
 * A transfer is taken from the account it left and added to the one it went to. On a
 * card, spending makes the amount owed (below zero) grow, and paying it off shrinks it.
 */
const accountsStatement = (db: D1Database, email: string) =>
  db
    .prepare(
      `SELECT a.id, a.name, a.kind, a.currency,
              a.opening_cents AS openingCents,
              a.opening_cents + COALESCE(t.net, 0) AS balanceCents,
              a.position, a.archived, a.archived_at AS archivedAt,
              a.created_at AS createdAt
       FROM accounts a
       LEFT JOIN (
         SELECT id, SUM(cents) AS net FROM (
           SELECT account_id AS id,
                  CASE kind WHEN 'income' THEN amount_cents ELSE -amount_cents END AS cents
           FROM transactions WHERE email = ?1
           UNION ALL
           SELECT to_account_id, amount_cents
           FROM transactions WHERE email = ?1 AND kind = 'transfer'
         )
         GROUP BY id
       ) t ON t.id = a.id
       WHERE a.email = ?1
       ORDER BY a.position, a.created_at, a.id`,
    )
    .bind(email);

const categoriesStatement = (db: D1Database, email: string) =>
  db
    .prepare(
      `SELECT id, name, kind, parent_id AS parentId, position, archived
       FROM categories
       WHERE email = ?
       ORDER BY position, id`,
    )
    .bind(email);

const toCategory = (r: CategoryRow): Category => ({ ...r, archived: r.archived === 1 });

type RecurringRow = Omit<Recurring, 'archived' | 'amountVaries' | 'askFirst'> & {
  archived: 0 | 1;
  amountVaries: 0 | 1;
  askFirst: 0 | 1;
};

/** Every repeating item of `email`, stopped ones too, in the order they were set up */
const recurringStatement = (db: D1Database, email: string) =>
  db
    .prepare(
      `SELECT id, kind, account_id AS accountId, to_account_id AS toAccountId,
              amount_cents AS amountCents, category_id AS categoryId, payee, schedule, day,
              start_date AS startDate, next_due AS nextDue, archived,
              amount_varies AS amountVaries, ask_first AS askFirst
       FROM recurring
       WHERE email = ?
       ORDER BY position, id`,
    )
    .bind(email);

/**
 * Every category of `email` saved so far, archived ones too, each in its place among
 * the ones beside it. None until their first change, which saves the defaults.
 */
export async function listCategories(db: D1Database, email: string): Promise<Category[]> {
  const { results } = await categoriesStatement(db, email).all<CategoryRow>();
  return results.map(toCategory);
}

/**
 * A person's whole ledger, in one answer, read in one batch so the balances, the
 * categories, the repeating items (when there are any) and which of `pending` (change ids the app may have had saved, its answer
 * lost) are saved all describe the same moment
 */
export async function readLedger(
  db: D1Database,
  email: string,
  pending: string[] = [],
): Promise<Ledger> {
  const [accounts, categories, recurring, saved] = await db.batch<
    AccountRow | CategoryRow | RecurringRow | { id: string }
  >([
    accountsStatement(db, email),
    categoriesStatement(db, email),
    recurringStatement(db, email),
    ...(pending.length > 0 ? [savedIdsStatement(db, email, pending)] : []),
  ]);
  const repeating = recurring.results as RecurringRow[];
  return {
    accounts: (accounts.results as AccountRow[]).map(
      (r): Account => ({ ...r, archived: r.archived === 1 }),
    ),
    categories: (categories.results as CategoryRow[]).map(toCategory),
    // Only for someone who has any, so the answer is as it always was for everyone else
    ...(repeating.length > 0 && {
      recurring: repeating.map(
        (r): Recurring => ({
          ...r,
          archived: r.archived === 1,
          amountVaries: r.amountVaries === 1,
          askFirst: r.askFirst === 1,
        }),
      ),
    }),
    // Only for a read that named any
    ...(saved != null && { alreadySaved: (saved.results as { id: string }[]).map((r) => r.id) }),
  };
}

/** A page of transactions holds this many unless asked for fewer, and never more than the most */
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** A transaction's columns, as the API names them; `t` is what the table is called in the query */
const transactionColumns = (t = 'transactions') =>
  `${t}.id, ${t}.kind, ${t}.account_id AS accountId, ${t}.to_account_id AS toAccountId,
  ${t}.amount_cents AS amountCents, ${t}.category_id AS categoryId, ${t}.payee, ${t}.note,
  ${t}.date, ${t}.time, ${t}.created_at AS createdAt, ${t}.recurring_id AS recurringId,
  ${t}.recurring_due AS recurringDue, ${t}.to_check AS toCheck,
  ${t}.original_currency AS originalCurrency, ${t}.original_cents AS originalCents,
  ${t}.rate, ${t}.rate_source AS rateSource, ${t}.rate_at AS rateAt`;

/** A transaction's row as read with transactionColumns */
type TransactionRow = Omit<Transaction, 'scheduled' | 'original'> & {
  recurringId: string | null;
  recurringDue: string | null;
  toCheck: 0 | 1;
  originalCurrency: string | null;
  originalCents: number | null;
  rate: number | null;
  rateSource: FetchedRateSource | null;
  rateAt: number | null;
};

/**
 * A row as the API answers it: `scheduled` only on an entry from Scheduled, `original`
 * only on one typed in a currency other than the home one
 */
export function toTransaction({
  recurringId,
  recurringDue,
  toCheck,
  originalCurrency,
  originalCents,
  rate,
  rateSource,
  rateAt,
  ...t
}: TransactionRow) {
  const out: Transaction = t;
  if (recurringId != null && recurringDue != null) {
    out.scheduled = { recurringId, due: recurringDue, toCheck: toCheck === 1 };
  }
  if (originalCurrency != null && originalCents != null && rate != null && rateSource != null) {
    out.original = {
      currency: originalCurrency,
      cents: originalCents,
      rate,
      source: rateSource,
      at: rateAt ?? 0,
    };
  }
  return out;
}

/**
 * Where the next page starts: the last transaction's day, its time of day ('' for none,
 * which comes after any time), when it was saved and its id, newest first. Ties on all
 * but the id are broken by id, so no transaction is skipped or shown twice.
 */
const cursorOf = (t: Pick<Transaction, 'date' | 'time' | 'createdAt' | 'id'>) =>
  `${t.date}_${t.time ?? ''}_${t.createdAt}_${t.id}`;

/** A place to carry on from; one written before times (day, saved, id) isn't one */
const CURSOR_PATTERN =
  /^(\d{4}-\d{2}-\d{2})_((?:[01]\d|2[0-3]):[0-5]\d|)_(\d{1,15})_([0-9a-f]{16})$/;

/**
 * The order lists are in: newest day first, then the latest time, those with none after
 * (SQLite puts NULL last when sorting down, as ifnull(time, '') does), so the account's
 * index serves it
 */
const NEWEST_FIRST = (t: string) =>
  `${t}date DESC, ${t}time DESC, ${t}created_at DESC, ${t}id DESC`;

/** What comes after a place to carry on from, in that order */
const AFTER = (t: string) =>
  `(${t}date, ifnull(${t}time, ''), ${t}created_at, ${t}id) < (?, ?, ?, ?)`;

type Cursor = [string, string, number, string];
const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * GET /api/transactions: a page of the person's transactions, newest first, either one
 * account's (?account=; a transfer is on both its accounts) or every account's in a
 * month (?month=2026-11; a transfer once). ?before= is the
 * nextBefore of the page before; ?limit= is how many, PAGE_SIZE unless said. Someone
 * else's account is answered as one that doesn't exist.
 */
export async function listTransactions(
  db: D1Database,
  email: string,
  params: URLSearchParams,
): Promise<Response> {
  const account = params.get('account');
  const month = params.get('month');
  if ((account == null) === (month == null)) return fail('Ask for an account or a month', 400);

  const limit = readLimit(params);
  if (limit == null) return fail(`Ask for 1-${MAX_PAGE_SIZE} at a time`, 400);

  const where = ['email = ?'];
  const values: (string | number)[] = [email];
  if (account != null) {
    if (!isRowId(account)) return notFound();
    const found = await db
      .prepare('SELECT 1 FROM accounts WHERE email = ? AND id = ?')
      .bind(email, account)
      .first();
    if (found == null) return fail('Account not found', 404);
    where.push('(account_id = ? OR to_account_id = ?)');
    values.push(account, account);
  } else {
    if (month == null || !MONTH_PATTERN.test(month)) return fail('Give a month, like 2026-11', 400);
    where.push('date BETWEEN ? AND ?');
    values.push(`${month}-01`, `${month}-31`);
  }

  const cursor = readCursor(params);
  if (cursor === undefined) return fail('Unknown place to carry on from', 400);
  if (cursor != null) {
    where.push(AFTER(''));
    values.push(...cursor);
  }
  return pageOf(
    db.prepare(
      `SELECT ${transactionColumns()} FROM transactions
       WHERE ${where.join(' AND ')}
       ORDER BY ${NEWEST_FIRST('')}
       LIMIT ?`,
    ),
    values,
    limit,
  );
}

/** How many a page holds, as asked (?limit=), PAGE_SIZE unless said; null when out of range */
function readLimit(params: URLSearchParams): number | null {
  const text = params.get('limit');
  const limit = text == null ? PAGE_SIZE : Number(text);
  return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_PAGE_SIZE ? limit : null;
}

/**
 * Where to carry on from (?before=): its day, time saved and id; null for the start,
 * undefined when it isn't one
 */
function readCursor(params: URLSearchParams): Cursor | null | undefined {
  const before = params.get('before');
  if (before == null) return null;
  const m = CURSOR_PATTERN.exec(before);
  return m == null ? undefined : [m[1], m[2], Number(m[3]), m[4]];
}

/** A page from `query`, which takes `values` and then how many (one more than `limit`) */
async function pageOf(query: D1PreparedStatement, values: (string | number)[], limit: number) {
  // One more than asked for says whether there's another page
  const { results } = await query.bind(...values, limit + 1).all<TransactionRow>();
  const transactions = results.slice(0, limit).map(toTransaction);
  const more = results.length > limit;
  return json<TransactionPage>({
    transactions,
    nextBefore: more ? cursorOf(transactions[transactions.length - 1]) : null,
  });
}

/**
 * GET /api/search: a page of the person's transactions on every account, newest first,
 * found by shared/search.ts's rules (?q= words or an amount, ?account=, ?category= with its
 * subcategories, ?from= and ?to= days, ?kind=, ?scheduled=1 for entries from Scheduled), carrying on from ?before= as
 * /api/transactions does. With it, what matches beyond the page (rest, and the part of it
 * on the page's last day), and on the first page of a search for days how many match
 * outside them (elsewhere), and on every first page whether the person has any entry at all
 * (anywhere). Someone else's account or category is answered as one that
 * doesn't exist.
 *
 * Every figure is one query built from the same conditions as the page, the person's
 * email first, so no filter can be left out of one: the page; rest and restOfLastDay
 * together in one aggregate, only when there is more; elsewhere in one aggregate, only on
 * the first page. Each sum stays exact (SearchPage in shared/api.ts).
 */
export async function searchTransactions(
  db: D1Database,
  email: string,
  params: URLSearchParams,
): Promise<Response> {
  const query = readSearch(params);
  if ('error' in query) return fail(query.error, 400);
  const limit = readLimit(params);
  if (limit == null) return fail(`Ask for 1-${MAX_PAGE_SIZE} at a time`, 400);
  const cursor = readCursor(params);
  if (cursor === undefined) return fail('Unknown place to carry on from', 400);

  // What every figure asks: the person's, then the filters but for the days
  const where = ['t.email = ?'];
  const values: (string | number)[] = [email];
  if (query.account != null) {
    const found =
      isRowId(query.account) &&
      (await db
        .prepare('SELECT 1 FROM accounts WHERE email = ? AND id = ?')
        .bind(email, query.account)
        .first());
    if (!found) return fail('Account not found', 404);
    where.push('(t.account_id = ? OR t.to_account_id = ?)');
    values.push(query.account, query.account);
  }
  if (query.category != null) {
    const categories = categoriesOrDefaults(await listCategories(db, email));
    if (!categories.some((c) => c.id === query.category)) {
      return fail('Category not found', 404);
    }
    const ids = [...categoriesIn(categories, query.category)];
    where.push(`t.category_id IN (${ids.map(() => '?').join(', ')})`);
    values.push(...ids);
  }
  if (query.scheduled === true) where.push('t.recurring_id IS NOT NULL');
  if (query.kinds != null) {
    where.push(`t.kind IN (${query.kinds.map(() => '?').join(', ')})`);
    values.push(...query.kinds);
  }
  if (query.q !== '') {
    // Found anywhere in the text, every character as itself, with A to Z in either case:
    // SQLite's lower() folds only those, as foldCase does. (Not a LIKE pattern: D1 refuses
    // one over 50 bytes, and a search can be MAX_SEARCH_TEXT characters.)
    const words = foldCase(query.q);
    const found = ['t.payee', 't.note', 'c.name', 'p.name'].map(
      (column) => `instr(lower(${column}), ?) > 0`,
    );
    values.push(words, words, words, words);
    const cents = searchAmount(query.q);
    if (cents != null) {
      found.push('t.amount_cents = ?');
      values.push(cents);
    }
    where.push(`(${found.join(' OR ')})`);
  }
  // The days, on their own, so elsewhere can ask for the others
  const days: string[] = [];
  const dayValues: string[] = [];
  if (query.from != null) {
    days.push('t.date >= ?');
    dayValues.push(query.from);
  }
  if (query.to != null) {
    days.push('t.date <= ?');
    dayValues.push(query.to);
  }

  const from = `FROM transactions t
       LEFT JOIN categories c ON c.email = t.email AND c.id = t.category_id
       LEFT JOIN categories p ON p.email = c.email AND p.id = c.parent_id`;
  const after = (at: Cursor) => ({ sql: AFTER('t.'), values: at });
  const pageWhere = [...where, ...days];
  const pageValues = [...values, ...dayValues];
  if (cursor != null) {
    const past = after(cursor);
    pageWhere.push(past.sql);
    pageValues.push(...past.values);
  }
  const page = db
    .prepare(
      `SELECT ${transactionColumns('t')} ${from}
       WHERE ${pageWhere.join(' AND ')}
       ORDER BY ${NEWEST_FIRST('t.')}
       LIMIT ?`,
    )
    .bind(...pageValues, limit + 1);
  const askElsewhere = cursor == null && days.length > 0;
  const elsewhere = db
    .prepare(
      `SELECT COUNT(*) AS n ${from}
       WHERE ${where.join(' AND ')} AND NOT (${days.join(' AND ') || '1'})`,
    )
    .bind(...values, ...dayValues);
  // On the first page, whether the person has any entry at all (Activity's "nothing yet")
  const first = cursor == null;
  const any = db.prepare('SELECT 1 AS n FROM transactions WHERE email = ? LIMIT 1').bind(email);
  const [found, ...more] = await db.batch<TransactionRow | { n: number }>([
    page,
    ...(first ? [any] : []),
    ...(askElsewhere ? [elsewhere] : []),
  ]);
  const anyAtAll = first ? more.shift() : undefined;
  const outside = askElsewhere ? more.shift() : undefined;
  const results = found.results as TransactionRow[];
  const transactions = results.slice(0, limit).map(toTransaction);
  const last = results.length > limit ? transactions[transactions.length - 1] : null;

  const none: SearchTotals = { entries: 0, spentCents: 0, receivedCents: 0 };
  let rest = none;
  let restOfLastDay: SearchPage['restOfLastDay'] = null;
  if (last != null) {
    const past = after([last.date, last.time ?? '', last.createdAt, last.id]);
    const sums = await db
      .prepare(
        `SELECT COUNT(*) AS entries,
                COALESCE(SUM(CASE WHEN t.kind = 'expense' THEN t.amount_cents END), 0)
                  AS spentCents,
                COALESCE(SUM(CASE WHEN t.kind = 'income' THEN t.amount_cents END), 0)
                  AS receivedCents,
                COUNT(CASE WHEN t.date = ? THEN 1 END) AS dayEntries,
                COALESCE(SUM(CASE WHEN t.date = ? AND t.kind = 'expense'
                  THEN t.amount_cents END), 0) AS daySpentCents,
                COALESCE(SUM(CASE WHEN t.date = ? AND t.kind = 'income'
                  THEN t.amount_cents END), 0) AS dayReceivedCents
         ${from}
         WHERE ${[...where, ...days, past.sql].join(' AND ')}`,
      )
      .bind(last.date, last.date, last.date, ...values, ...dayValues, ...past.values)
      .first<
        SearchTotals & { dayEntries: number; daySpentCents: number; dayReceivedCents: number }
      >();
    if (sums != null) {
      rest = {
        entries: sums.entries,
        spentCents: sums.spentCents,
        receivedCents: sums.receivedCents,
      };
      restOfLastDay = {
        date: last.date,
        entries: sums.dayEntries,
        spentCents: sums.daySpentCents,
        receivedCents: sums.dayReceivedCents,
      };
    }
  }
  return json<SearchPage>({
    transactions,
    nextBefore: last != null ? cursorOf(last) : null,
    rest,
    restOfLastDay,
    ...(askElsewhere && { elsewhere: (outside?.results[0] as { n: number } | undefined)?.n ?? 0 }),
    ...(first && { anywhere: (anyAtAll?.results.length ?? 0) > 0 }),
  });
}
