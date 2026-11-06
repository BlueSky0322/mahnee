import type { Account, Category, Recurring } from '@shared/api';
import { DEFAULT_CURRENCY } from '@shared/ledger';
import { fromDateInput } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';

// How repeating items are said on Home: "Due: Rent RM 1,200.00 from Maybank"

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** What an item is called: who's paid (or pays), else its category, else "Transfer" */
export function recurringName(r: Recurring, categories: Category[]) {
  if (r.payee != null) return r.payee;
  const category = categories.find((c) => c.id === r.categoryId);
  return category?.name ?? (r.kind === 'transfer' ? 'Transfer' : 'Unknown category');
}

const accountName = (accounts: Account[], id: string | null) =>
  accounts.find((a) => a.id === id)?.name ?? 'an account';

/**
 * "Due: Rent RM 1,200.00 from Maybank"; income comes "into Maybank", a transfer goes
 * "from Maybank to Visa"
 */
export function dueText(r: Recurring, accounts: Account[], categories: Category[]) {
  const money = formatMoney(r.amountCents, currencyOf(r, accounts));
  const from = accountName(accounts, r.accountId);
  const where =
    r.kind === 'income'
      ? `into ${from}`
      : r.kind === 'transfer'
        ? `from ${from} to ${accountName(accounts, r.toAccountId)}`
        : `from ${from}`;
  return `Due: ${recurringName(r, categories)} ${money} ${where}`;
}

export const currencyOf = (r: Recurring, accounts: Account[]) =>
  accounts.find((a) => a.id === r.accountId)?.currency ?? DEFAULT_CURRENCY;

/** "RM 55.00", with "−" before it when it takes money away, "+" when it brings some */
export const signedMoneyOf = (cents: number, currency = DEFAULT_CURRENCY) =>
  `${cents < 0 ? '−' : cents > 0 ? '+' : ''}${formatMoney(cents, currency)}`;

/** A total that can be below zero: "RM 7,405.00", "−RM 1,100.00" */
export const totalMoney = (cents: number, currency = DEFAULT_CURRENCY) =>
  `${cents < 0 ? '−' : ''}${formatMoney(cents, currency)}`;

/** A day without its year, as the person's language writes it: "9 Nov" */
export function shortDay(text: string) {
  const day = fromDateInput(text);
  return day == null ? text : day.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/** "Monthly on day 20", "Weekly on Mondays" */
export function scheduleText(r: Pick<Recurring, 'schedule' | 'day'>) {
  return r.schedule === 'monthly' ? `Monthly on day ${r.day}` : `Weekly on ${WEEKDAYS[r.day - 1]}s`;
}

export const weekdayName = (day: number) => WEEKDAYS[day - 1];
