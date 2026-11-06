import { fitsBudgetCents } from '@shared/budgets';
import type { CategoryKind } from '@shared/categories';
import { DEFAULT_CURRENCY, MAX_TRANSACTION } from '@shared/ledger';
import { toCents } from '@shared/rates';
import { formatAmount } from '../../utils/money';

// Categories as people read them, and their budgets as people type them

/** Each kind's list, as its heading names it */
export const KIND_LABELS: Record<CategoryKind, string> = {
  expense: 'Spending',
  income: 'Income',
};

const AMOUNT_PATTERN = /^(\d+(\.\d{0,2})?|\.\d{1,2})$/;

/**
 * A monthly budget as typed: its cents, none when nothing is typed, or why it can't be
 * one
 */
export function readBudget(text: string): { cents: number | null } | { error: string } {
  const typed = text.replace(/[,\s]/g, '');
  if (typed === '') return { cents: null };
  if (!AMOUNT_PATTERN.test(typed)) return { error: 'Enter an amount, like 300' };
  const cents = toCents(Number(typed));
  if (cents === 0) return { error: 'Enter an amount above 0' };
  if (!fitsBudgetCents(cents)) return { error: `Up to ${MAX_TRANSACTION.toLocaleString('en')}` };
  return { cents };
}

/** A budget as the form shows it to change: "300.00", "1,200.00" (read back by readBudget) */
export const budgetText = (cents: number) => formatAmount(cents, DEFAULT_CURRENCY);
