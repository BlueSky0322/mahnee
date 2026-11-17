// A month at a glance: what a person spent and received in it, across every account,
// summed here in the database rather than by sending every transaction to the app. A month
// is the person's own (shared/period.ts): from the day their month starts on, read from
// their settings on every read, to the day before the next starts, named for the month
// holding most of its days; the answer says which days it summed (firstDay, lastDay).
//
// Only spending and income count. A transfer moves money between the person's own
// accounts, so it is never spending or income, and is left out by name.
//
// Every total stays exact: a person has at most MAX_ACCOUNTS accounts, each holding at
// most MAX_TRANSACTIONS_PER_ACCOUNT transactions of at most MAX_TRANSACTION_CENTS, so a
// month's spending or income is at most 50 x 100,000 x 1e9 = 5e15 cents, under the 9e15
// a number holds as a whole number exactly. Each list has at most one row per category,
// so at most MAX_CATEGORIES, each with how many transactions make it (at most 5e6) and,
// for a category with only one, its payee.
//
// With them, for Home's calendar and Tidy up: spending by day, one grouped sum over the
// month, so at most 31 rows; and how many spending transactions from the first day of the
// month before to the month's last are in Other (OTHER_EXPENSE_ID) or a category under it,
// one count over that window, with those categories' ids (at most MAX_CATEGORIES).
//
// A month's budgets come with it (shared/budgets.ts): the budgets kept on the person's
// top-level spending categories, and, to work out what each month before left, their
// spending by month (the person's, grouped by periodMonthSql) and top-level category since
// the first budget, subcategories rolled up by their parent as it is now. Read in the same
// batch as the totals, and only for a month up to the one holding tomorrow in UTC (the
// latest a budget can be set from): a month still to come
// has no budgets. So the chain runs from the first budget (2000 at the earliest) to this
// month at most, about 330 months in 2027, and the spending read is at most one row per
// such month and category.

import type { CategoryTotal, DayTotal, MonthSummary } from '../../shared/api';
import type { BudgetRow } from '../../shared/budgets';
import { isBudgetMonth, monthBudgets } from '../../shared/budgets';
import { OTHER_EXPENSE_ID, tidyUpFrom } from '../../shared/categories';
import { isPeriodMonth, periodOf } from '../../shared/period';
import { fail, json } from '../http';
import { readMonthStart } from './month-start';
import { periodMonthSql } from './period-sql';
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
  entries: number;
  /** Only for a category with one transaction, when it names one */
  payee: string | null;
}

/** Tidy up as read: a category under Other (no count), or the count (no category) */
interface TidyRow {
  categoryId: string | null;
  entries: number | null;
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
  if (!isPeriodMonth(month)) return fail('Give a month from 2000, like 2026-11', 400);

  const start = await readMonthStart(db, email);
  const { firstDay, lastDay } = periodOf(month, start);
  // Budgets only for a month one can be set in or before (up to the month holding tomorrow
  // in UTC): a month still to come has none, so the chain never walks past this month
  const withBudgets = isBudgetMonth(month, Date.now(), start);
  // In one batch with which of `pending` are saved, and the budgets, so all of it describes
  // the same moment
  const from = tidyUpFrom(month, start);
  const answers = await db.batch<
    TotalRow | DayTotal | TidyRow | KeptBudget | SpentRow | { id: string }
  >([
    db
      .prepare(
        `SELECT kind, category_id AS categoryId, SUM(amount_cents) AS cents,
                COUNT(*) AS entries, CASE WHEN COUNT(*) = 1 THEN MAX(payee) END AS payee
       FROM transactions
       WHERE email = ? AND date BETWEEN ? AND ? AND kind IN ('expense', 'income')
       GROUP BY kind, category_id
       ORDER BY cents DESC, category_id`,
      )
      .bind(email, firstDay, lastDay),
    db
      .prepare(
        `SELECT date, SUM(amount_cents) AS cents
         FROM transactions
         WHERE email = ? AND date BETWEEN ? AND ? AND kind = 'expense'
         GROUP BY date
         ORDER BY date`,
      )
      .bind(email, firstDay, lastDay),
    // Other's subcategories now, and the count, each row one or the other
    db
      .prepare(
        `SELECT id AS categoryId, NULL AS entries
         FROM categories WHERE email = ?1 AND parent_id = ?2
         UNION ALL
         SELECT NULL, COUNT(*)
         FROM transactions
         WHERE email = ?1 AND kind = 'expense' AND date BETWEEN ?3 AND ?4
           AND (category_id = ?2 OR category_id IN
                 (SELECT id FROM categories WHERE email = ?1 AND parent_id = ?2))`,
      )
      .bind(email, OTHER_EXPENSE_ID, from, lastDay),
    ...(withBudgets ? budgetStatements(db, email, month, start) : []),
    ...(pending.length > 0 ? [savedIdsStatement(db, email, pending)] : []),
  ]);
  const [totals, byDay, tidy] = answers;
  const [budgetRows, budgetSpending] = withBudgets ? [answers[3], answers[4]] : [];
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
    results
      .filter((r) => r.kind === kind)
      .map(({ categoryId, cents, entries, payee }) => ({
        categoryId,
        cents,
        entries,
        ...(payee != null && { payee }),
      }));
  const tidyRows = tidy.results as TidyRow[];
  const sum = (totals: CategoryTotal[]) => totals.reduce((all, t) => all + t.cents, 0);
  const spentByCategory = byKind('expense');
  const incomeByCategory = byKind('income');
  const spentCents = sum(spentByCategory);
  const incomeCents = sum(incomeByCategory);
  return json<MonthSummary>({
    month,
    firstDay,
    lastDay,
    incomeCents,
    spentCents,
    leftCents: incomeCents - spentCents,
    spentByCategory,
    incomeByCategory,
    spentByDay: byDay.results as DayTotal[],
    tidyUp: {
      from,
      entries: tidyRows.find((r) => r.categoryId == null)?.entries ?? 0,
      categoryIds: [
        OTHER_EXPENSE_ID,
        ...tidyRows
          .flatMap((r) => (r.categoryId == null ? [] : [r.categoryId]))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      ],
    },
    // Only when there are any
    ...(budgets.length > 0 && { budgets }),
    // Only for a read that named any
    ...(saved != null && { alreadySaved: (saved.results as { id: string }[]).map((r) => r.id) }),
  });
}

/**
 * The month's budgets as kept, and their spending before it: the budgets that can apply up
 * to `month` on categories at the top level now, in the categories' order; and what was
 * spent in each month (each period, for a month starting on `start`) from the first budget
 * on (none without one) up to the one before, each subcategory's under its parent. A
 * period named for a month can start in the month before, so spending is read from the
 * first of the month before the first budget's; any earlier period read is never asked for.
 */
function budgetStatements(db: D1Database, email: string, month: string, start: number) {
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
        `SELECT ${periodMonthSql('t.date', '?3')} AS month,
                COALESCE(c.parent_id, c.id) AS categoryId, SUM(t.amount_cents) AS cents
         FROM transactions t
         JOIN categories c ON c.email = t.email AND c.id = t.category_id
         WHERE t.email = ?1 AND t.kind = 'expense'
           AND t.date >= date((SELECT MIN(from_month) FROM budgets WHERE email = ?1) || '-01',
                              '-1 month')
           AND t.date < ?2
           AND COALESCE(c.parent_id, c.id) IN (SELECT category_id FROM budgets WHERE email = ?1)
         GROUP BY month, COALESCE(c.parent_id, c.id)`,
      )
      .bind(email, periodOf(month, start).firstDay, start),
  ];
}
