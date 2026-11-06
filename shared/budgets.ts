// Budgets: a monthly amount a person means to spend in a top-level spending category, its
// subcategories counting toward it. An amount set in a month applies from then on, until
// it's changed; earlier months keep what they had. With Carry over, last month's leftover
// is added to this month's amount (or what it overspent taken away), chained month to month
// from the first budgeted month. The Worker works out what each month before left
// (monthBudgets); the app works out what's left now from the spending it shows
// (budgetFigures), so both use the same sum.
//
// Every figure stays exact: an amount is at most MAX_TRANSACTION_CENTS, and a chain runs
// from the first budgeted month (2000 at the earliest) to the month asked, which is never
// after this one (worker/ledger/summary.ts gives a month still to come no budgets): a few
// hundred months, so carried amounts stay under 1e12 cents, and spending under the 5e15 a
// person's totals are bounded by.

import type { Category, MonthBudget } from './api';
import { MAX_TRANSACTION, MAX_TRANSACTION_CENTS, fitsTransactionCents, isMonth } from './ledger';

/** A budget as it's kept: an amount from a month on, or none (null) from that month on */
export interface BudgetRow {
  categoryId: string;
  fromMonth: string;
  amountCents: number | null;
  carryOver: boolean;
}

/** The largest monthly budget, in cents: the same as the largest single amount */
export const MAX_BUDGET_CENTS = MAX_TRANSACTION_CENTS;

/** Why an amount can't be a budget */
export const BUDGET_RANGE = `A budget is more than 0 and up to ${MAX_TRANSACTION.toLocaleString('en')}`;

/** Whether an amount can be a monthly budget: whole cents, above 0, at most MAX_BUDGET_CENTS */
export const fitsBudgetCents = fitsTransactionCents;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `v` is a month a budget can be set from: 2000 or later and not after this one (by
 * tomorrow in UTC, so wherever a person is, their own month is allowed)
 */
export const isBudgetMonth = (v: unknown, now = Date.now()): v is string =>
  isMonth(v) && v <= new Date(now + DAY_MS).toISOString().slice(0, 7);

/**
 * Why `category` (one of the person's) can't have a budget, or null when it can: only a
 * top-level spending category has one; its subcategories count toward it
 */
export function whyNoBudget(category: Pick<Category, 'kind' | 'parentId'>): string | null {
  if (category.parentId != null) return 'A budget goes on a top-level category';
  if (category.kind !== 'expense') return 'A budget goes on a spending category';
  return null;
}

/** The month after `month` (2026-12 after 2026-11) */
export function nextMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * A month's budget against `spentCents` spent in it (its subcategories included): what was
 * carried in (last month's leftover, only with Carry over), what that makes available, and
 * what's left (below zero when over)
 */
export function budgetFigures(
  budget: Pick<MonthBudget, 'amountCents' | 'carryOver' | 'lastMonthLeftCents'>,
  spentCents: number,
): { carriedCents: number; availableCents: number; leftCents: number } {
  const carriedCents = budget.carryOver ? budget.lastMonthLeftCents : 0;
  const availableCents = budget.amountCents + carriedCents;
  return { carriedCents, availableCents, leftCents: availableCents - spentCents };
}

/**
 * The budgets in effect in `month`, from the rows kept (the person's, in any order within
 * a category), listed in the order each category's rows first come. `spent` gives what
 * was spent in a top-level category in an earlier month, subcategories included.
 */
export function monthBudgets(
  month: string,
  rows: readonly BudgetRow[],
  spent: (month: string, categoryId: string) => number,
): MonthBudget[] {
  const byCategory = new Map<string, BudgetRow[]>();
  for (const row of rows) {
    if (row.fromMonth > month) continue;
    const list = byCategory.get(row.categoryId) ?? [];
    list.push(row);
    byCategory.set(row.categoryId, list);
  }
  const budgets: MonthBudget[] = [];
  for (const [categoryId, list] of byCategory) {
    const sorted = [...list].sort((a, b) => (a.fromMonth < b.fromMonth ? -1 : 1));
    // Month by month from the first, each month's leftover carried into the next
    let at = 0;
    let lastMonthLeftCents = 0;
    for (let m = sorted[0].fromMonth; ; m = nextMonth(m)) {
      while (at + 1 < sorted.length && sorted[at + 1].fromMonth <= m) at++;
      const { amountCents, carryOver } = sorted[at];
      if (m === month) {
        if (amountCents != null) {
          budgets.push({ categoryId, amountCents, carryOver, lastMonthLeftCents });
        }
        break;
      }
      lastMonthLeftCents =
        amountCents == null
          ? 0
          : budgetFigures({ amountCents, carryOver, lastMonthLeftCents }, spent(m, categoryId))
              .leftCents;
    }
  }
  return budgets;
}
