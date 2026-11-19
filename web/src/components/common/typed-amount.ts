import type { Transaction } from '@shared/api';
import { formatAmount, formatMoney } from '../../utils/money';

// An entry typed in another currency than the home one shows what was typed first, "THB
// 120.00" (signed as its list signs it), with what it came to in the home currency beside
// it, quieter: on Activity, the register, an account's page and the entry itself. Totals
// stay in the home currency.

/** What an entry was typed as, signed: "−THB 120.00"; null for one typed in the home currency */
export const typedAmount = (t: Pick<Transaction, 'original'>, sign: string) =>
  t.original == null
    ? null
    : `${sign}${t.original.currency} ${formatAmount(t.original.cents, t.original.currency)}`;

/**
 * An amount as a list reads it out: `shown` ("−15.30") alone, or for one typed in another
 * currency, what was typed and then what it came to ("−THB 120.00, RM 15.30")
 */
export function amountWords(
  t: Pick<Transaction, 'original' | 'amountCents'>,
  shown: string,
  sign: string,
  currency: string,
) {
  const typed = typedAmount(t, sign);
  return typed == null ? shown : `${typed}, ${formatMoney(t.amountCents, currency)}`;
}
