import type { Account } from '@shared/api';
import type { AccountKind } from '@shared/ledger';
import { MAX_TRANSACTION, fitsOpeningCents } from '@shared/ledger';
import { toCents } from '@shared/rates';
import { evaluateSum } from '../../utils/math';
import { formatMoney } from '../../utils/money';

// An account's kind and balance as people read them, and its opening balance as they
// type it. A card's is what's owed on it, typed and shown as a plain amount but kept
// below zero.

export const KIND_LABELS: Record<AccountKind, string> = {
  cash: 'Cash',
  bank: 'Bank',
  card: 'Card',
  ewallet: 'E-wallet',
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
 * why it can't be one. Empty is nothing; sums like "100+20" are worked out.
 */
export function readOpening(
  text: string,
  kind: AccountKind,
): { cents: number } | { error: string } {
  const typed = text.replace(/[,\s]/g, '');
  if (typed === '') return { cents: 0 };
  const value = evaluateSum(typed);
  if (value == null) return { error: 'Enter an amount, like 120.50' };
  // Never -0, which would show as a change from 0
  const cents = (kind === 'card' ? -toCents(value) : toCents(value)) || 0;
  if (!fitsOpeningCents(cents)) {
    return { error: `Up to ${MAX_TRANSACTION.toLocaleString('en')} either way` };
  }
  return { cents };
}
