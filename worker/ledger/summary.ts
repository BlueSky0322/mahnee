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
//
// A month's budgets come with it (shared/budgets.ts): the budgets kept on the person's
// top-level spending categories, and, to work out what each month before left, their
// spending by month and top-level category since the first budget, subcategories rolled up
// by their parent as it is now. Read in the same batch as the totals, and only for a month
// up to tomorrow's in UTC (the latest a budget can be set from): a month still to come
// has no budgets. So the chain runs from the first budget (2000 at the earliest) to this
// month at most, about 330 months in 2027, and the spending read is at most one row per
// such month and category.

import type { CategoryTotal, MonthSummary } from '../../shared/api';
import type { BudgetRow } from '../../shared/budgets';
import { isBudgetMonth, monthBudgets } from '../../shared/budgets';
import { isMonth } from '../../shared/ledger';
import { fail, json } from '../http';
import { savedIdsStatement } from './receipts';

/** A budget as read: carry over as 0 or 1 */
type KeptBudget = Omit<BudgetRow, 'carryOver'> & { carryOver: 0 | 1 };

/** What was spent in a top-level category (subcategories included) in a month */
interface SpentRow {
  month: string;
  categoryId: string;
  cents: number;
}

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
  pending: string[] = [],
): Promise<Response> {
  const month = params.get('month');
  if (!isMonth(month)) return fail('Give a month from 2000, like 2026-11', 400);

  // Budgets only for a month one can be set in or before (up to tomorrow's month in UTC):
  // a month still to come has none, so the chain never walks past this month
  const withBudgets = isBudgetMonth(month);
  // In one batch with which of `pending` are saved, and the budgets, so all of it describes
  // the same moment
  const answers = await db.batch<TotalRow | KeptBudget | SpentRow | { id: string }>([
    db
      .prepare(
        `SELECT kind, category_id AS categoryId, SUM(amount_cents) AS cents
       FROM transactions
       WHERE email = ? AND date BETWEEN ? AND ? AND kind IN ('expense', 'income')
       GROUP BY kind, category_id
       ORDER BY cents DESC, category_id`,
      )
      .bind(email, `${month}-01`, `${month}-31`),
    ...(withBudgets ? budgetStatements(db, email, month) : []),
    ...(pending.length > 0 ? [savedIdsStatement(db, email, pending)] : []),
  ]);
  const totals = answers[0];
  const [budgetRows, budgetSpending] = withBudgets ? [answers[1], answers[2]] : [];
  const saved = pending.length > 0 ? answers[answers.length - 1] : undefined;
  const results = totals.results as TotalRow[];
  const spentBefore = new Map(
    ((budgetSpending?.results ?? []) as SpentRow[]).map((r) => [
      `${r.month} ${r.categoryId}`,
      r.cents,
    ]),
  );
  const budgets = monthBudgets(
    month,
    ((budgetRows?.results ?? []) as KeptBudget[]).map((r) => ({
      ...r,
      carryOver: r.carryOver === 1,
    })),
    (m, categoryId) => spentBefore.get(`${m} ${categoryId}`) ?? 0,
  );

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
    // Only when there are any
    ...(budgets.length > 0 && { budgets }),
    // Only for a read that named any
    ...(saved != null && { alreadySaved: (saved.results as { id: string }[]).map((r) => r.id) }),
  });
}

/**
 * The month's budgets as kept, and their spending before it: the budgets that can apply up
 * to `month` on categories at the top level now, in the categories' order; and what was
 * spent in each month from the first budget on (none without one) up to the one before,
 * each subcategory's under its parent
 */
function budgetStatements(db: D1Database, email: string, month: string) {
  return [
    db
      .prepare(
        `SELECT b.category_id AS categoryId, b.from_month AS fromMonth,
                b.amount_cents AS amountCents, b.carry_over = 1 AS carryOver
         FROM budgets b
         JOIN categories c ON c.email = b.email AND c.id = b.category_id
         WHERE b.email = ?1 AND b.from_month <= ?2 AND c.parent_id IS NULL AND c.kind = 'expense'
         ORDER BY c.position, c.id, b.from_month`,
      )
      .bind(email, month),
    db
      .prepare(
        `SELECT substr(t.date, 1, 7) AS month, COALESCE(c.parent_id, c.id) AS categoryId,
                SUM(t.amount_cents) AS cents
         FROM transactions t
         JOIN categories c ON c.email = t.email AND c.id = t.category_id
         WHERE t.email = ?1 AND t.kind = 'expense'
           AND t.date >= (SELECT MIN(from_month) FROM budgets WHERE email = ?1) || '-01'
           AND t.date < ?2 || '-01'
           AND COALESCE(c.parent_id, c.id) IN (SELECT category_id FROM budgets WHERE email = ?1)
         GROUP BY month, COALESCE(c.parent_id, c.id)`,
      )
      .bind(email, month),
  ];
}
