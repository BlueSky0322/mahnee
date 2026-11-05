// Taking everything out: every transaction a person has, as a CSV file to keep or open
// in a spreadsheet (shared/export.ts writes each line), and a count of what it holds.
//
// The file is read from the database a page at a time and sent as it's read, so a long
// history never sits in memory whole. A person has at most MAX_ACCOUNTS accounts, each
// holding at most MAX_TRANSACTIONS_PER_ACCOUNT, which bounds the file. Nothing in it is
// kept or logged here: it goes straight to the person who asked.

import type { ExportSummary } from '../../shared/api';
import type { ExportNames } from '../../shared/export';
import { CSV_BOM, EXPORT_COLUMNS, csvLine, exportCells, exportFileName } from '../../shared/export';
import type { TransactionKind } from '../../shared/ledger';

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

/** GET /api/export/summary: how many transactions the file holds, over which days */
export async function readExportSummary(db: D1Database, email: string): Promise<ExportSummary> {
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

/** The person's account and category names now, archived ones too */
async function readNames(db: D1Database, email: string): Promise<ExportNames> {
  const [accounts, categories] = await db.batch<{
    id: string;
    name: string;
    currency: string;
    parentId: string | null;
  }>([
    db.prepare('SELECT id, name, currency FROM accounts WHERE email = ?').bind(email),
    db
      .prepare('SELECT id, name, parent_id AS parentId FROM categories WHERE email = ?')
      .bind(email),
  ]);
  return {
    accounts: new Map(accounts.results.map((a) => [a.id, a])),
    categories: new Map(categories.results.map((c) => [c.id, c])),
  };
}

/**
 * GET /api/export: every transaction of the person's, oldest first (by day, then when it
 * was saved, then id), one line each under a header line. `today` (2026-11-05, in UTC)
 * names the file.
 */
export async function exportTransactions(
  db: D1Database,
  email: string,
  today: string,
): Promise<Response> {
  // Read before answering, so a failure here is an error rather than a cut-off file
  const names = await readNames(db, email);
  const encoder = new TextEncoder();
  // Where the next page carries on: after this day, time saved and id
  let after: [string, number, string] | null = null;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(CSV_BOM + csvLine(EXPORT_COLUMNS)));
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
           WHERE email = ? ${after == null ? '' : 'AND (date, created_at, id) > (?, ?, ?)'}
           ORDER BY date, created_at, id
           LIMIT ?`,
        )
        .bind(email, ...(after ?? []), EXPORT_PAGE_SIZE)
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
      'Content-Disposition': `attachment; filename="${exportFileName(today)}"`,
      // The person's whole financial history: never kept by a browser or anything between
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
