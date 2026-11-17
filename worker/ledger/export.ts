// Taking everything out: each account's opening balance, each repeating item still running
// and every transaction a person has, as a CSV file to keep or open in a spreadsheet
// (shared/export.ts writes each line), and a count of what it holds.
//
// The file is read from the database a page at a time and sent as it's read, so a long
// history never sits in memory whole. A person has at most MAX_ACCOUNTS accounts, each
// holding at most MAX_TRANSACTIONS_PER_ACCOUNT, and at most MAX_RECURRING repeating items,
// which bounds the file. Nothing in it is
// kept or logged here: it goes straight to the person who asked.

import type { ExportRange, ExportSummary, Recurring } from '../../shared/api';
import type { ExportAccount, ExportNames } from '../../shared/export';
import {
  CSV_BOM,
  EXPORT_COLUMNS,
  csvLine,
  exportCells,
  exportFileName,
  openingCells,
  rangeCells,
  repeatingLines,
} from '../../shared/export';
import { FIRST_DAY } from '../../shared/ledger';
import { isCalendarDay } from '../../shared/recurring';
import { fail } from '../http';
import type { TransactionKind } from '../../shared/ledger';
import { MAX_RECURRING } from '../../shared/recurring';

/** How many transactions are read from the database at a time */
export const EXPORT_PAGE_SIZE = 1000;

interface ExportRow {
  id: string;
  kind: TransactionKind;
  accountId: string;
  toAccountId: string | null;
  amountCents: number;
  categoryId: string | null;
  payee: string | null;
  note: string | null;
  date: string;
  createdAt: number;
}

const RANGE = 'Give from and to as days, from on or before to';

/**
 * The days asked for (?from=2026-01-01&to=2026-12-31, both included), null for everything,
 * or a refusal: both or neither, each a calendar day from 2000, from on or before to
 */
export function readExportRange(params: URLSearchParams): ExportRange | null | Response {
  const from = params.get('from');
  const to = params.get('to');
  if (from == null && to == null) return null;
  if (!isCalendarDay(from) || !isCalendarDay(to) || from < FIRST_DAY || from > to) {
    return fail(RANGE, 400);
  }
  return { from, to };
}

/**
 * GET /api/export/summary: how many transactions the file holds, over which days, and the
 * accounts and categories in it: everything has every one (archived too); a file of some
 * dates, those its transactions use
 */
export async function readExportSummary(
  db: D1Database,
  email: string,
  range: ExportRange | null = null,
): Promise<ExportSummary> {
  if (range == null) {
    const row = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM transactions WHERE email = ?1) AS transactions,
                (SELECT MIN(date) FROM transactions WHERE email = ?1) AS firstDate,
                (SELECT MAX(date) FROM transactions WHERE email = ?1) AS lastDate,
                (SELECT COUNT(*) FROM accounts WHERE email = ?1) AS accounts,
                (SELECT COUNT(*) FROM categories WHERE email = ?1) AS categories`,
      )
      .bind(email)
      .first<ExportSummary>();
    return row!;
  }
  const row = await db
    .prepare(
      `WITH t AS (SELECT * FROM transactions WHERE email = ?1 AND date BETWEEN ?2 AND ?3)
       SELECT (SELECT COUNT(*) FROM t) AS transactions,
              (SELECT MIN(date) FROM t) AS firstDate,
              (SELECT MAX(date) FROM t) AS lastDate,
              (SELECT COUNT(*) FROM (SELECT account_id FROM t
                                     UNION SELECT to_account_id FROM t
                                     WHERE to_account_id IS NOT NULL)) AS accounts,
              (SELECT COUNT(DISTINCT category_id) FROM t) AS categories`,
    )
    .bind(email, range.from, range.to)
    .first<ExportSummary>();
  return row!;
}

type RunningRow = Omit<Recurring, 'startDate' | 'archived'>;

/**
 * The person's accounts, in their order, and their category names, as they are now,
 * archived ones too; and their repeating items still running, in the order set up
 */
async function readNames(
  db: D1Database,
  email: string,
): Promise<ExportNames & { inOrder: ExportAccount[]; running: Omit<Recurring, 'startDate'>[] }> {
  const [accounts, categories, running] = await db.batch<
    ExportAccount & { name: string; parentId: string | null } & RunningRow
  >([
    db
      .prepare(
        `SELECT id, name, currency, opening_cents AS openingCents, created_at AS createdAt
         FROM accounts WHERE email = ?
         ORDER BY position, created_at, id`,
      )
      .bind(email),
    db
      .prepare('SELECT id, name, parent_id AS parentId FROM categories WHERE email = ?')
      .bind(email),
    // At most MAX_RECURRING a person, so at most that many lines
    db
      .prepare(
        `SELECT id, kind, account_id AS accountId, to_account_id AS toAccountId,
                amount_cents AS amountCents, category_id AS categoryId, payee, schedule, day,
                next_due AS nextDue
         FROM recurring
         WHERE email = ? AND archived = 0
         ORDER BY position, id
         LIMIT ?`,
      )
      .bind(email, MAX_RECURRING),
  ]);
  return {
    running: (running.results as RunningRow[]).map((r) => ({ ...r, archived: false })),
    inOrder: accounts.results,
    accounts: new Map(accounts.results.map((a) => [a.id, a])),
    categories: new Map(categories.results.map((c) => [c.id, c])),
  };
}

/**
 * GET /api/export: under a header line, each account's opening balance in the person's
 * order, then each repeating item still running, in the order set up, then every
 * transaction of theirs, oldest first (by day, then when it was saved,
 * then id), one line each. `today` (2026-11-05, in UTC)
 * names the file. With `range`, a line saying it holds those days only, then only their
 * transactions: no opening balances or repeating items, as it can't restore balances.
 */
export async function exportTransactions(
  db: D1Database,
  email: string,
  today: string,
  range: ExportRange | null = null,
): Promise<Response> {
  // Read before answering, so a failure here is an error rather than a cut-off file
  const names = await readNames(db, email);
  const encoder = new TextEncoder();
  // Where the next page carries on: after this day, time saved and id
  let after: [string, number, string] | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const start =
        range == null
          ? names.inOrder.map((a) => csvLine(openingCells(a))).join('') +
            repeatingLines(names.running, names)
          : csvLine(rangeCells(range));
      controller.enqueue(encoder.encode(CSV_BOM + csvLine(EXPORT_COLUMNS) + start));
    },
    // Asked for each time the person's download has taken what came before. A failure
    // part way stops the download with an error, so it can't pass for the whole file.
    async pull(controller) {
      const { results } = await db
        .prepare(
          `SELECT id, kind, account_id AS accountId, to_account_id AS toAccountId,
                  amount_cents AS amountCents, category_id AS categoryId, payee, note, date,
                  created_at AS createdAt
           FROM transactions
           WHERE email = ? ${range == null ? '' : 'AND date BETWEEN ? AND ?'}
             ${after == null ? '' : 'AND (date, created_at, id) > (?, ?, ?)'}
           ORDER BY date, created_at, id
           LIMIT ?`,
        )
        .bind(
          email,
          ...(range == null ? [] : [range.from, range.to]),
          ...(after ?? []),
          EXPORT_PAGE_SIZE,
        )
        .all<ExportRow>();
      if (results.length > 0) {
        controller.enqueue(
          encoder.encode(results.map((t) => csvLine(exportCells(t, names))).join('')),
        );
        const last = results[results.length - 1];
        after = [last.date, last.createdAt, last.id];
      }
      if (results.length < EXPORT_PAGE_SIZE) controller.close();
    },
  });

  return new Response(body, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${exportFileName(today, range)}"`,
      // The person's whole financial history: never kept by a browser or anything between
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
