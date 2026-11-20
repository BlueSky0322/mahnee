import type { Transaction } from '@shared/api';
import { fromDateInput } from '../../utils/date-input';
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

/** Where a rate came from, as it's said */
export const SOURCE_NAMES = { wise: 'Wise', frankfurter: 'the ECB' } as const;

/** A calendar day (2026-11-12) as "Nov 12", the same day wherever the person is */
export const shortDay = (day: string) =>
  fromDateInput(day)?.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) ?? day;

/**
 * The day a rate is from, as "Nov 12": an earlier day's rate names its calendar `day`,
 * said as it is (its time, noon UTC, is already the next day from UTC+12); a live rate is
 * timed when it was fetched, said as the person's own day then
 */
export const rateDate = (at: number, day?: string) =>
  day != null
    ? shortDay(day)
    : new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * The rate an entry was converted at, and the day it's really from: "1 VND = 0.00018 MYR,
 * rate of Nov 12, from Wise"; null for one typed in the home currency
 */
export function rateLine(t: Pick<Transaction, 'original'>, home: string) {
  const o = t.original;
  if (o == null) return null;
  return `1 ${o.currency} = ${Number(o.rate.toPrecision(6))} ${home}, rate of ${rateDate(o.at, o.day)}, from ${SOURCE_NAMES[o.source]}`;
}

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
