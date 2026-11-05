// A month at a glance: what a person spent and received in it, across every account,
// summed here in the database rather than by sending every transaction to the app.
//
// Only spending and income count. A transfer moves money between the person's own
// accounts, so it is never spending or income, and is left out by name.
//
// Every total stays exact: a person has at most MAX_ACCOUNTS accounts, each holding at
// most MAX_TRANSACTIONS_PER_ACCOUNT transactions of at most MAX_TRANSACTION_CENTS, so a
// month's spending or income is at most 50 x 100,000 x 1e9 = 5e15 cents, under the 9e15
// a number holds as a whole number exactly. Each list has at most one row per category,
// so at most MAX_CATEGORIES.

import type { CategoryTotal, MonthSummary } from '../../shared/api';
import { isMonth } from '../../shared/ledger';
import { fail, json } from '../http';

interface TotalRow {
  kind: 'expense' | 'income';
  categoryId: string;
  cents: number;
}

/**
 * GET /api/summary?month=2026-11: the person's spending and income in that month, in
 * total and by category, each category under its own id (a subcategory's isn't added to
 * its parent's; the app rolls them up for showing)
 */
export async function readSummary(
  db: D1Database,
  email: string,
  params: URLSearchParams,
): Promise<Response> {
  const month = params.get('month');
  if (!isMonth(month)) return fail('Give a month from 2000, like 2026-11', 400);

  const { results } = await db
    .prepare(
      `SELECT kind, category_id AS categoryId, SUM(amount_cents) AS cents
       FROM transactions
       WHERE email = ? AND date BETWEEN ? AND ? AND kind IN ('expense', 'income')
       GROUP BY kind, category_id
       ORDER BY cents DESC, category_id`,
    )
    .bind(email, `${month}-01`, `${month}-31`)
    .all<TotalRow>();

  const byKind = (kind: TotalRow['kind']): CategoryTotal[] =>
    results.filter((r) => r.kind === kind).map(({ categoryId, cents }) => ({ categoryId, cents }));
  const sum = (totals: CategoryTotal[]) => totals.reduce((all, t) => all + t.cents, 0);
  const spentByCategory = byKind('expense');
  const incomeByCategory = byKind('income');
  const spentCents = sum(spentByCategory);
  const incomeCents = sum(incomeByCategory);
  return json<MonthSummary>({
    month,
    incomeCents,
    spentCents,
    leftCents: incomeCents - spentCents,
    spentByCategory,
    incomeByCategory,
  });
}
