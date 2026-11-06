import type { Category, MonthSummary } from '@shared/api';
import { budgetFigures } from '@shared/budgets';

// A month's budgets as Home shows them: each budgeted top-level spending category with what
// was set for the month, what carried over from the month before, and what's left once
// what was spent in it is taken away, its subcategories' spending included (rolled up by
// the categories as they are now, as derive.ts does). The sum is shared/budgets.ts's, the
// same the server uses for what last month left.

/** One budget as shown */
export interface BudgetLine {
  id: string;
  name: string;
  /** Set for the month */
  amountCents: number;
  /** From last month: its leftover, or below zero what it overspent; 0 with Carry over off */
  carriedCents: number;
  /** The amount and what carried over */
  availableCents: number;
  /** Spent in it this month, subcategories included */
  spentCents: number;
  /** Below zero when over */
  leftCents: number;
}

/**
 * The month's budgets on listed top-level spending categories, in the categories' order.
 * One on a category archived, moved under another, or not known isn't shown.
 */
export function budgetLines(summary: MonthSummary, categories: readonly Category[]): BudgetLine[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const spent = new Map<string, number>();
  for (const { categoryId, cents } of summary.spentByCategory) {
    const category = byId.get(categoryId);
    if (category == null) continue;
    const topId = category.parentId ?? category.id;
    spent.set(topId, (spent.get(topId) ?? 0) + cents);
  }
  const lines: (BudgetLine & { position: number })[] = [];
  for (const budget of summary.budgets ?? []) {
    const category = byId.get(budget.categoryId);
    if (
      category == null ||
      category.archived ||
      category.parentId != null ||
      category.kind !== 'expense'
    ) {
      continue;
    }
    const spentCents = spent.get(category.id) ?? 0;
    lines.push({
      id: category.id,
      name: category.name,
      amountCents: budget.amountCents,
      spentCents,
      ...budgetFigures(budget, spentCents),
      position: category.position,
    });
  }
  return lines
    .sort((a, b) => a.position - b.position || (a.id < b.id ? -1 : 1))
    .map(({ position: _position, ...line }) => line);
}
