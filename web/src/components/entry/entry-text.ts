import type { Transaction } from '@shared/api';
import { MAX_TRANSACTION, fitsTransactionCents } from '@shared/ledger';
import { toCents } from '@shared/rates';
import { formatMoney } from '../../utils/money';

// A transaction's amount as people type and read it: typed as a plain amount, kept in
// whole cents, and shown with a sign for which way the money went

const AMOUNT_PATTERN = /^(\d+(\.\d{0,2})?|\.\d{1,2})$/;

/** The amount typed, in cents, or why it can't be one */
export function readAmount(text: string): { cents: number } | { error: string } {
  const typed = text.replace(/[,\s]/g, '');
  if (!AMOUNT_PATTERN.test(typed)) return { error: 'Enter an amount, like 8.50' };
  const cents = toCents(Number(typed));
  if (cents === 0) return { error: 'Enter an amount above 0' };
  if (!fitsTransactionCents(cents)) {
    return { error: `Up to ${MAX_TRANSACTION.toLocaleString('en')}` };
  }
  return { cents };
}

/** An amount as the form shows it to edit: "8", "8.50" */
export const amountText = (cents: number) =>
  cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);

/** "−RM 8.00" spent, "+RM 50.00" received */
export function signedMoney({ kind, amountCents }: Transaction, currency: string) {
  return `${kind === 'income' ? '+' : '−'}${formatMoney(amountCents, currency)}`;
}
