// The ledger's kinds and limits, and the checks both the app and the Worker make on what
// a person types: the app to say what's wrong before saving, the Worker to refuse it.
//
// The limits keep every total exact. An account's balance is its opening balance plus
// at most MAX_TRANSACTIONS_PER_ACCOUNT transactions of at most MAX_TRANSACTION_CENTS
// each, about 1e14 cents; across MAX_ACCOUNTS accounts that is about 5e15, still under
// the 9e15 a number holds as a whole number exactly.

import type { Account, Category, Transaction } from './api';
import type { CategoryKind } from './categories';

/** What an account is: notes and coins, a bank account, a credit card, or an e-wallet */
export const ACCOUNT_KINDS = ['cash', 'bank', 'card', 'ewallet'] as const;
export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const isAccountKind = (v: unknown): v is AccountKind =>
  (ACCOUNT_KINDS as readonly unknown[]).includes(v);

/** The currency new accounts are kept in; each account stores its own */
export const DEFAULT_CURRENCY = 'MYR';

/** The most accounts one person can have, archived ones included */
export const MAX_ACCOUNTS = 50;

/** The longest an account's name can be, once trimmed */
export const MAX_ACCOUNT_NAME = 40;

/** The largest single amount, in currency units: one transaction, or an opening balance */
export const MAX_TRANSACTION = 10_000_000;
export const MAX_TRANSACTION_CENTS = MAX_TRANSACTION * 100;

/**
 * The most transactions one account can hold, so its balance stays exact: every one on
 * it counts, whichever way the money went
 */
export const MAX_TRANSACTIONS_PER_ACCOUNT = 100_000;

/** An account's name as typed, trimmed; null when it's missing, empty or too long */
export function readAccountName(value: unknown): string | null {
  const name = typeof value === 'string' ? value.trim() : '';
  return name.length > 0 && name.length <= MAX_ACCOUNT_NAME ? name : null;
}

/**
 * Whether an opening balance is whole cents within MAX_TRANSACTION either way: below
 * zero for an overdrawn account or what's owed on a card
 */
export const fitsOpeningCents = (v: unknown): v is number =>
  typeof v === 'number' &&
  Number.isSafeInteger(v) &&
  v >= -MAX_TRANSACTION_CENTS &&
  v <= MAX_TRANSACTION_CENTS;

// ---------- Transactions ----------

/**
 * What a transaction is: money spent from an account, money that came into one, or money
 * moved between two of the person's own accounts (a transfer: never spending or income)
 */
export const TRANSACTION_KINDS = ['expense', 'income', 'transfer'] as const;
export type TransactionKind = (typeof TRANSACTION_KINDS)[number];

export const isTransactionKind = (v: unknown): v is TransactionKind =>
  (TRANSACTION_KINDS as readonly unknown[]).includes(v);

/** The longest a payee (who was paid, or who paid) can be, once trimmed */
export const MAX_PAYEE = 80;

/** The longest a note on a transaction can be, once trimmed */
export const MAX_NOTE = 500;

/** Whether an amount is whole cents, more than nothing and at most MAX_TRANSACTION */
export const fitsTransactionCents = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0 && v <= MAX_TRANSACTION_CENTS;

/** The earliest day a transaction can be on */
export const FIRST_DAY = '2000-01-01';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `v` is a day a transaction can be on, as 2026-11-05: a real calendar day, from
 * 2000, and not after tomorrow in UTC, so wherever a person is, their own today is allowed
 */
export function isDay(v: unknown, now = Date.now()): v is string {
  if (typeof v !== 'string') return false;
  const m = DAY_PATTERN.exec(v);
  if (m == null) return false;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (at.toISOString().slice(0, 10) !== v) return false;
  return v >= FIRST_DAY && v <= new Date(now + DAY_MS).toISOString().slice(0, 10);
}

const MONTH_PATTERN = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** Whether `v` is a month, as 2026-11, from the first a transaction can be in */
export const isMonth = (v: unknown): v is string =>
  typeof v === 'string' && MONTH_PATTERN.test(v) && v >= FIRST_DAY.slice(0, 7);

/**
 * Optional text as typed (a payee or note), trimmed: null when it's missing or empty, and
 * undefined when it isn't text or is longer than `max`
 */
export function readOptionalText(value: unknown, max: number): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (text.length > max) return undefined;
  return text === '' ? null : text;
}

/** The kind of category a transaction of `kind` goes in; none for a transfer */
export const categoryKindFor = (kind: TransactionKind): CategoryKind | null =>
  kind === 'transfer' ? null : kind;

/**
 * Why a transaction of `kind` can't go in `category` (one of the person's), or null when
 * it can: it has to be listed, and spending goes in spending categories, income in income
 * ones
 */
export function whyNotInCategory(
  category: Pick<Category, 'name' | 'kind' | 'archived'>,
  kind: TransactionKind,
): string | null {
  if (category.kind !== categoryKindFor(kind)) {
    return kind === 'income'
      ? 'Income goes in an income category'
      : 'Spending goes in a spending category';
  }
  if (category.archived) return `${category.name} is archived`;
  return null;
}

/** Why a transaction can't be put on `account` (one of the person's), or null when it can */
export const whyNotOnAccount = (account: Pick<Account, 'name' | 'archived'>): string | null =>
  account.archived ? `${account.name} is archived` : null;

/** Why money can't move from one account to another, or null when it can: they must differ */
export const whyNotBetween = (fromId: string, toId: string): string | null =>
  fromId === toId ? 'Move it between two different accounts' : null;

/** Whether a transaction is on an account: the one it's from, or the one a transfer goes to */
export const isOnAccount = (
  t: Pick<Transaction, 'accountId' | 'toAccountId'>,
  accountId: string,
): boolean => t.accountId === accountId || t.toAccountId === accountId;

/**
 * How much a transaction moves an account's balance, in cents: income adds, spending
 * takes away, and a transfer takes from the account it's from and adds to the one it
 * goes to (paying a card from the bank lowers what's owed on it). Nothing for an account
 * it isn't on.
 */
export function balanceEffect(
  t: Pick<Transaction, 'kind' | 'accountId' | 'toAccountId' | 'amountCents'>,
  accountId: string,
): number {
  if (t.kind === 'transfer' && t.toAccountId === accountId) return t.amountCents;
  if (t.accountId !== accountId) return 0;
  return t.kind === 'income' ? t.amountCents : -t.amountCents;
}
