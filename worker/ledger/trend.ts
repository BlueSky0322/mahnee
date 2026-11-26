// Spending over time: what a person spent and received in each of the 12 months ending at
// a month (shared/trend.ts), across every account, so the month card can show each
// category's last 12 months. One grouped sum over a fixed window, never a read per month.
// Each month uses the person's own first and last day (shared/period.ts).
//
// Each month is summed as GET /api/summary sums one (summary.ts): spending and income only,
// never a transfer, each category under its own id with how many transactions make it
// and a lone one's payee, largest first (without the month's own days or Tidy up); the app rolls
// subcategories up into their parent as it does for the month itself, so the month shown
// is exactly the card's figures.
//
// Bounded: the window is the 12 months ending at a checked month (from the first's first day
// to the last's last), and there is at most one row per month, kind and category, so
// at most 12 x 2 x MAX_CATEGORIES rows. Every total stays exact: everything a person can
// have, every month together, is at most MAX_ACCOUNTS x MAX_TRANSACTIONS_PER_ACCOUNT x
// MAX_TRANSACTION_CENTS = 5e15 cents, under the 9e15 a number holds as a whole number.

import type { CategoryTotal, MonthTotals, MonthTrend } from '../../shared/api';
import { isPeriodMonth, periodOf } from '../../shared/period';
import { trendMonths } from '../../shared/trend';
import { fail, json } from '../http';
import { readMonthStart } from './month-start';
import { savedIdsStatement } from './receipts';

interface TrendRow {
  month: string;
  kind: 'expense' | 'income';
  categoryId: string;
  cents: number;
  entries: number;
  /** Only for a category with one transaction in the month, when it names one */
  payee: string | null;
}

/** GET /api/summary/trend?month=2026-11: the 12 months ending at November 2026 */
export async function readTrend(
  db: D1Database,
  email: string,
  params: URLSearchParams,
  pending: string[] = [],
): Promise<Response> {
  const month = params.get('month');
  if (!isPeriodMonth(month)) return fail('Give a month from 2000, like 2026-11', 400);
  const start = await readMonthStart(db, email);
  const months = trendMonths(month).map((m) => periodOf(m, start));

  // In one batch with which of `pending` are saved, so both describe the same moment
  const answers = await db.batch<TrendRow | { id: string }>([
    db
      .prepare(
        `WITH periods(month, first_day, last_day) AS (VALUES ${months.map(() => '(?, ?, ?)').join(', ')})
         SELECT p.month, t.kind, t.category_id AS categoryId, SUM(t.amount_cents) AS cents,
                COUNT(*) AS entries, CASE WHEN COUNT(*) = 1 THEN MAX(t.payee) END AS payee
         FROM periods p CROSS JOIN transactions t
         WHERE t.email = ? AND t.date BETWEEN p.first_day AND p.last_day
           AND t.kind IN ('expense', 'income')
         GROUP BY p.month, t.kind, t.category_id
         ORDER BY p.month, cents DESC, t.category_id`,
      )
      .bind(...months.flatMap((p) => [p.month, p.firstDay, p.lastDay]), email),
    ...(pending.length > 0 ? [savedIdsStatement(db, email, pending)] : []),
  ]);
  const rows = answers[0].results as TrendRow[];
  const saved = pending.length > 0 ? answers[1] : undefined;

  const sum = (totals: CategoryTotal[]) => totals.reduce((all, t) => all + t.cents, 0);
  const byKind = (m: string, kind: TrendRow['kind']): CategoryTotal[] =>
    rows
      .filter((r) => r.month === m && r.kind === kind)
      .map(({ categoryId, cents, entries, payee }) => ({
        categoryId,
        cents,
        entries,
        ...(payee != null && { payee }),
      }));
  return json<MonthTrend>({
    month,
    months: months.map(({ month: m, firstDay, lastDay }): MonthTotals => {
      const spentByCategory = byKind(m, 'expense');
      const incomeByCategory = byKind(m, 'income');
      const [spentCents, incomeCents] = [sum(spentByCategory), sum(incomeByCategory)];
      return {
        month: m,
        firstDay,
        lastDay,
        incomeCents,
        spentCents,
        leftCents: incomeCents - spentCents,
        spentByCategory,
        incomeByCategory,
      };
    }),
    // Only for a read that named any
    ...(saved != null && { alreadySaved: (saved.results as { id: string }[]).map((r) => r.id) }),
  });
}
