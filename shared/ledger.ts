// The ledger's kinds and limits, and the checks both the app and the Worker make on what
// a person types: the app to say what's wrong before saving, the Worker to refuse it.
//
// The limits keep every total exact. An account's balance is its opening balance plus
// at most MAX_TRANSACTIONS_PER_ACCOUNT transactions of at most MAX_TRANSACTION_CENTS
// each, about 1e14 cents; across MAX_ACCOUNTS accounts that is about 5e15, still under
// the 9e15 a number holds as a whole number exactly.

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
 * The most transactions one account can hold, so its balance stays exact. Enforced once
 * transactions can be added.
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
