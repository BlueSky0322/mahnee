// Reading a person's ledger: their accounts, each with its balance worked out here and
// never stored, so it can't drift from what makes it up, their categories, and their
// transactions a page at a time.

import type { Account, Category, Ledger, Transaction, TransactionPage } from '../../shared/api';
import { isRowId } from '../../shared/api';
import type { CategoryKind } from '../../shared/categories';
import type { AccountKind } from '../../shared/ledger';
import { fail, json, notFound } from '../http';

interface AccountRow {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingCents: number;
  balanceCents: number;
  position: number;
  archived: 0 | 1;
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
async function listAccounts(db: D1Database, email: string): Promise<Account[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.kind, a.currency,
              a.opening_cents AS openingCents,
              a.opening_cents + COALESCE(t.net, 0) AS balanceCents,
              a.position, a.archived
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
    .bind(email)
    .all<AccountRow>();
  return results.map((r): Account => ({ ...r, archived: r.archived === 1 }));
}

/**
 * Every category of `email` saved so far, archived ones too, each in its place among
 * the ones beside it. None until their first change, which saves the defaults.
 */
export async function listCategories(db: D1Database, email: string): Promise<Category[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, kind, parent_id AS parentId, position, archived
       FROM categories
       WHERE email = ?
       ORDER BY position, id`,
    )
    .bind(email)
    .all<CategoryRow>();
  return results.map((r): Category => ({ ...r, archived: r.archived === 1 }));
}

/** A person's whole ledger, in one answer */
export async function readLedger(db: D1Database, email: string): Promise<Ledger> {
  const [accounts, categories] = await Promise.all([
    listAccounts(db, email),
    listCategories(db, email),
  ]);
  return { accounts, categories };
}

/** A page of transactions holds this many unless asked for fewer, and never more than the most */
export const PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

const TRANSACTION_COLUMNS = `id, kind, account_id AS accountId, to_account_id AS toAccountId,
  amount_cents AS amountCents,
  category_id AS categoryId, payee, note, date, created_at AS createdAt`;

/**
 * Where the next page starts: the last transaction's day, time saved and id, newest
 * first. Ties on the day and time are broken by id, so no transaction is skipped or
 * shown twice.
 */
const cursorOf = (t: Pick<Transaction, 'date' | 'createdAt' | 'id'>) =>
  `${t.date}_${t.createdAt}_${t.id}`;

const CURSOR_PATTERN = /^(\d{4}-\d{2}-\d{2})_(\d{1,15})_([0-9a-f]{16})$/;
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

  const limitText = params.get('limit');
  const limit = limitText == null ? PAGE_SIZE : Number(limitText);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return fail(`Ask for 1-${MAX_PAGE_SIZE} at a time`, 400);
  }

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

  const before = params.get('before');
  if (before != null) {
    const m = CURSOR_PATTERN.exec(before);
    if (m == null) return fail('Unknown place to carry on from', 400);
    where.push('(date, created_at, id) < (?, ?, ?)');
    values.push(m[1], Number(m[2]), m[3]);
  }

  // One more than asked for says whether there's another page
  const { results } = await db
    .prepare(
      `SELECT ${TRANSACTION_COLUMNS} FROM transactions
       WHERE ${where.join(' AND ')}
       ORDER BY date DESC, created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(...values, limit + 1)
    .all<Transaction>();
  const transactions = results.slice(0, limit);
  const more = results.length > limit;
  return json<TransactionPage>({
    transactions,
    nextBefore: more ? cursorOf(transactions[transactions.length - 1]) : null,
  });
}
