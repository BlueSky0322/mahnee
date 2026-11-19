import { clockText } from '../../utils/date-input';
import type { Account, Category, Transaction } from '@shared/api';
import type { AccountKind } from '@shared/ledger';
import { DEFAULT_CURRENCY, MAX_TRANSACTION, balanceEffect, fitsOpeningCents } from '@shared/ledger';
import { readTypedSum } from '@shared/keypad';
import { formatAmount, formatMoney } from '../../utils/money';
import { categoryName } from '../common/category-name';
import { transactionTitle } from '../entry/entry-text';
import { scheduledNote } from '../common/scheduled-note';

// An account's kind and balance as people read them, and its opening balance as they
// type it. A card's is what's owed on it, typed and shown as a plain amount but kept
// below zero.

export const KIND_LABELS: Record<AccountKind, string> = {
  cash: 'Cash',
  bank: 'Bank',
  card: 'Card',
  ewallet: 'E-wallet',
};

/** An account as each kind, in a sentence: "Visa is now a bank account" */
export const KIND_AS: Record<AccountKind, string> = {
  cash: 'cash',
  bank: 'a bank account',
  card: 'a card',
  ewallet: 'an e-wallet',
};

/** "RM 1,200.00", "−RM 50.00" overdrawn, or on a card "RM 120.00 owed" */
export function balanceText({ kind, balanceCents, currency }: Account) {
  if (kind === 'card') {
    return balanceCents > 0
      ? `${formatMoney(balanceCents, currency)} in credit`
      : `${formatMoney(-balanceCents, currency)} owed`;
  }
  return `${balanceCents < 0 ? '−' : ''}${formatMoney(balanceCents, currency)}`;
}

/** An opening balance as the form shows it to edit: "120", "120.50", "" for none */
export function openingText(openingCents: number, kind: AccountKind) {
  const cents = kind === 'card' ? -openingCents : openingCents;
  if (cents === 0) return '';
  return cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2);
}

/**
 * The opening balance typed, in cents as kept (below zero for what's owed on a card), or
 * why it can't be one. Empty is nothing; sums like "100+20" or "0.25*4.14" are worked out
 * in whole cents as Add's keypad does, so the same keys always come to the same amount.
 */
export function readOpening(
  text: string,
  kind: AccountKind,
): { cents: number } | { error: string } {
  const read = readTypedSum(text);
  if ('error' in read) {
    return read.error === 'tooMuch'
      ? { error: `Up to ${MAX_TRANSACTION.toLocaleString('en')} either way` }
      : { error: 'Enter an amount, like 120.50' };
  }
  // Never -0, which would show as a change from 0
  const cents = (kind === 'card' ? -read.cents : read.cents) || 0;
  if (!fitsOpeningCents(cents)) {
    return { error: `Up to ${MAX_TRANSACTION.toLocaleString('en')} either way` };
  }
  return { cents };
}

// ---------- Accounts (R-Accounts, R-Desk-Accounts) ----------

/** What a person has and owes, over their running accounts (archived ones count in none) */
export interface AccountTotals {
  /** Everything together: what's in accounts, less what's owed on cards */
  togetherCents: number;
  /** What's in cash, banks and e-wallets; below zero when overdrawn on the whole */
  haveCents: number;
  /** What's owed on cards; below zero when they hold more in credit than they owe */
  owedCents: number;
  /** Whether there's a running account that isn't a card, and a running card */
  others: boolean;
  cards: boolean;
}

/**
 * The totals at the top of Accounts. Whole cents, exact: at most MAX_ACCOUNTS balances,
 * each bounded by shared/ledger.ts, so every sum stays a safe integer.
 */
export function accountTotals(accounts: readonly Account[]): AccountTotals {
  const totals = { togetherCents: 0, haveCents: 0, owedCents: 0, others: false, cards: false };
  for (const a of accounts) {
    if (a.archived) continue;
    totals.togetherCents += a.balanceCents;
    if (a.kind === 'card') {
      totals.owedCents -= a.balanceCents;
      totals.cards = true;
    } else {
      totals.haveCents += a.balanceCents;
      totals.others = true;
    }
  }
  // Never -0
  totals.owedCents ||= 0;
  return totals;
}

/** "RM 1,200.00", or "−RM 50.00" below zero */
export const signedMoneyText = (cents: number, currency: string) =>
  `${cents < 0 ? '−' : ''}${formatMoney(cents, currency)}`;

/** "RM 4,247.65 in accounts · RM 331.90 owed", each part only when there's an account for it */
export function totalsLine(totals: AccountTotals, currency: string) {
  const parts: string[] = [];
  if (totals.others) parts.push(`${signedMoneyText(totals.haveCents, currency)} in accounts`);
  if (totals.cards) {
    parts.push(
      totals.owedCents < 0
        ? `${formatMoney(-totals.owedCents, currency)} in credit`
        : `${formatMoney(totals.owedCents, currency)} owed`,
    );
  }
  return parts.join(' · ');
}

/** A group's total, without the currency: "4,247.65", or the cards' "331.90 owed" */
export function groupText(group: 'have' | 'owed', cents: number, currency: string) {
  if (group === 'have') return `${cents < 0 ? '−' : ''}${formatAmount(cents, currency)}`;
  return `${formatAmount(cents, currency)} ${cents < 0 ? 'in credit' : 'owed'}`;
}

/** An account's balance in a list, without the currency; a card's says owed or in credit */
export function listBalance({ kind, balanceCents, currency }: Account): {
  amount: string;
  note: 'owed' | 'in credit' | null;
} {
  if (kind === 'card') {
    return {
      amount: formatAmount(balanceCents, currency),
      note: balanceCents > 0 ? 'in credit' : 'owed',
    };
  }
  return {
    amount: `${balanceCents < 0 ? '−' : ''}${formatAmount(balanceCents, currency)}`,
    note: null,
  };
}

/** The same as one line: "61,600.00", "331.90 owed" */
export const listBalanceText = (account: Account) => {
  const { amount, note } = listBalance(account);
  return note == null ? amount : `${amount} ${note}`;
};

/**
 * Its kind, and for an archived one the day it was archived, in the person's own day:
 * "Bank", "E-wallet · archived Aug 14", another year's "… archived Mar 3, 2025", or
 * "E-wallet · archived" when no day was kept
 */
export function kindLine(account: Account, now = new Date()) {
  const kind = KIND_LABELS[account.kind];
  if (!account.archived) return kind;
  if (account.archivedAt == null) return `${kind} · archived`;
  const at = new Date(account.archivedAt);
  const day = at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(at.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  });
  return `${kind} · archived ${day}`;
}

/** "Bank · started at RM 4,200.00"; a card's "Card · started at RM 120.00 owed" */
export function startedLine(account: Account) {
  const { kind, openingCents, currency } = account;
  const started =
    kind === 'card'
      ? openingCents > 0
        ? `${formatMoney(openingCents, currency)} in credit`
        : `${formatMoney(-openingCents, currency)} owed`
      : signedMoneyText(openingCents, currency);
  return `${KIND_LABELS[kind]} · started at ${started}`;
}

// ---------- An account's entries (R-Account, R-Desk-Accounts) ----------

/**
 * An entry as `accountId`'s own page shows it: titled by the other account for a transfer,
 * else its payee, its note or its category; the category (or "Transfer") under it, with the
 * note when it isn't the title, and "from Scheduled" (or "amount to check") for an entry
 * Scheduled added; and the amount signed by what it did to this account
 */
export function entryRow(
  t: Transaction,
  accountId: string,
  accounts: readonly Account[],
  categories: readonly Category[],
): { title: string; subtitle: string; amount: string; incoming: boolean } {
  const effect = balanceEffect(t, accountId);
  const currency = accounts.find((a) => a.id === accountId)?.currency ?? DEFAULT_CURRENCY;
  const amount = `${effect > 0 ? '+' : '−'}${formatAmount(t.amountCents, currency)}`;
  const incoming = effect > 0;
  const note = t.note?.trim() || null;
  const payee = t.payee?.trim() || null;
  if (t.kind === 'transfer') {
    const detail = note ?? payee;
    return {
      title: transactionTitle(t, accountId, accounts, categories),
      subtitle: `${detail == null ? 'Transfer' : `Transfer · ${detail}`}${scheduledNote(t)}`,
      amount,
      incoming,
    };
  }
  const category = categoryName(categories, t.categoryId);
  const title = payee ?? note ?? category;
  const subtitle = `${payee != null && note != null ? `${category} · ${note}` : category}${scheduledNote(t)}`;
  return {
    title,
    subtitle: t.time != null ? `${subtitle} · ${clockText(t.time)}` : subtitle,
    amount,
    incoming,
  };
}

/**
 * The balance after each entry, newest first: worked back from the balance now through the
 * entries shown, so it holds only for an unfiltered list loaded from the newest
 */
export function balancesAfter(
  balanceCents: number,
  accountId: string,
  transactions: readonly Transaction[],
): number[] {
  let after = balanceCents;
  return transactions.map((t) => {
    const shown = after;
    after -= balanceEffect(t, accountId);
    return shown;
  });
}
