import type { Account, Category, Transaction } from '@shared/api';
import { MAX_TRANSACTION, balanceEffect, fitsTransactionCents } from '@shared/ledger';
import { toCents } from '@shared/rates';
import { formatMoney } from '../../utils/money';
import { categoryName } from '../common/category-name';

// A transaction as people type and read it: the amount typed as a plain amount, kept in
// whole cents, and shown with a sign for which way the money went on an account; and
// what it was, by its category or, for a transfer, the other account

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

/**
 * How it changed `accountId`: "−RM 8.00" spent from it or moved out, "+RM 50.00" received
 * or moved in
 */
export function signedMoney(t: Transaction, accountId: string, currency: string) {
  return `${balanceEffect(t, accountId) > 0 ? '+' : '−'}${formatMoney(t.amountCents, currency)}`;
}

/** The name an account goes by, or a stand-in while it isn't known */
const accountName = (accounts: readonly Account[], id: string | null) =>
  accounts.find((a) => a.id === id)?.name ?? 'another account';

/**
 * What it was, as `accountId`'s page shows it: "Food › Coffee", or for a transfer the
 * other account, "To Visa" (paying the card) or "From Maybank" (a top-up)
 */
export function transactionTitle(
  t: Transaction,
  accountId: string,
  accounts: readonly Account[],
  categories: readonly Category[],
) {
  if (t.kind !== 'transfer') return categoryName(categories, t.categoryId);
  return t.accountId === accountId
    ? `To ${accountName(accounts, t.toAccountId)}`
    : `From ${accountName(accounts, t.accountId)}`;
}

/** What it was, wherever it's from: "Food", or a transfer's "Maybank to TNG" */
export function transactionSummary(
  t: Transaction,
  accounts: readonly Account[],
  categories: readonly Category[],
) {
  if (t.kind !== 'transfer') return categoryName(categories, t.categoryId);
  return `${accountName(accounts, t.accountId)} to ${accountName(accounts, t.toAccountId)}`;
}
