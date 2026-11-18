import type { Account, Category, Ledger, Recurring } from '@shared/api';
import { DEFAULT_CURRENCY } from '@shared/ledger';
import { nextAfter } from '@shared/recurring';
import { formatAmount, formatMoney } from '../../utils/money';
import { shortDate } from '../home/home-text';

// How Plan › Scheduled says its items (R-Bills, R-Desk-Bills, R-Bill-Edit; digest 3.8, 4.5):
// each item's name, its day ("1st" on a phone, "1st of the month" on a computer; a weekly
// one "Mondays" / "Every Monday"), where it's from (or "amount changes"), its next date and
// amount signed by which way it goes; what the edit sheet says of the next one; and the
// note for a card that's owed with no payment scheduled.

const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/** 1st, 2nd, 3rd, 4th ... 11th, 12th, 13th ... 21st, 22nd, 23rd ... 31st */
export function ordinal(n: number) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** "Monthly on the 3rd", "Weekly on Mondays": the Repeats choice */
export const repeatsLabel = (r: Pick<Recurring, 'schedule' | 'day'>) =>
  r.schedule === 'monthly'
    ? `Monthly on the ${ordinal(r.day)}`
    : `Weekly on ${WEEKDAYS[r.day - 1]}s`;

/** Every Repeats choice: each day of the month, then each day of the week */
export const REPEATS: { schedule: Recurring['schedule']; day: number }[] = [
  ...Array.from({ length: 31 }, (_, i) => ({ schedule: 'monthly' as const, day: i + 1 })),
  ...Array.from({ length: 7 }, (_, i) => ({ schedule: 'weekly' as const, day: i + 1 })),
];

const accountName = (accounts: readonly Account[], id: string | null) =>
  accounts.find((a) => a.id === id)?.name ?? 'an account';
const categoryOf = (categories: readonly Category[], id: string | null) =>
  categories.find((c) => c.id === id)?.name ?? 'Unknown category';

/**
 * An item's name: who's paid, else its category; income by its category ("Salary", and on
 * a computer "Salary, Initech"); a transfer "Top-up to Wallet"
 */
export function itemTitle(
  r: Recurring,
  accounts: readonly Account[],
  categories: readonly Category[],
  desktop: boolean,
) {
  if (r.kind === 'transfer')
    return `${r.payee ?? 'Transfer'} to ${accountName(accounts, r.toAccountId)}`;
  if (r.kind === 'income') {
    const category = categoryOf(categories, r.categoryId);
    return desktop && r.payee != null ? `${category}, ${r.payee}` : category;
  }
  return r.payee ?? categoryOf(categories, r.categoryId);
}

/** When it falls: "1st", "Mondays"; on a computer "1st of the month", "Every Monday" */
export const whenText = (r: Pick<Recurring, 'schedule' | 'day'>, desktop: boolean) =>
  r.schedule === 'monthly'
    ? `${ordinal(r.day)}${desktop ? ' of the month' : ''}`
    : desktop
      ? `Every ${WEEKDAYS[r.day - 1]}`
      : `${WEEKDAYS[r.day - 1]}s`;

/** A phone's line under the name: "1st · Maybank", "20th · amount changes", "5th · from Maybank" */
export function phoneLine(r: Recurring, accounts: readonly Account[]) {
  const from = accountName(accounts, r.accountId);
  const detail =
    r.amountVaries === true
      ? 'amount changes'
      : r.kind === 'transfer'
        ? `from ${from}`
        : r.kind === 'income'
          ? r.payee ?? from
          : from;
  return `${whenText(r, false)} · ${detail}`;
}

/** Whether it waits for Log it or Skip on Home, its day passed */
export const waiting = (r: Recurring, today: string) => r.askFirst === true && r.nextDue <= today;

/** "Next Dec 1", or "Was due Nov 1" for one waiting on Home */
export const nextText = (r: Recurring, today: string) =>
  `${waiting(r, today) ? 'Was due' : 'Next'} ${shortDate(r.nextDue)}`;

/** Its amount, signed by which way it goes: "−1,350.00", "+5,200.00", a transfer "80.00" */
export function signedAmount(r: Pick<Recurring, 'kind' | 'amountCents'>) {
  const amount = formatAmount(r.amountCents, DEFAULT_CURRENCY);
  return r.kind === 'expense' ? `−${amount}` : r.kind === 'income' ? `+${amount}` : amount;
}

/** What the edit sheet says of the next one: when, and how it's added */
export function nextLine(
  r: Pick<
    Recurring,
    'kind' | 'nextDue' | 'accountId' | 'toAccountId' | 'amountCents' | 'amountVaries' | 'askFirst'
  >,
  accounts: readonly Account[],
  today: string,
) {
  const day = shortDate(r.nextDue);
  const from = accountName(accounts, r.accountId);
  if (r.askFirst === true && r.nextDue <= today) {
    return `${day} · waiting for you on Home: Log it or Skip`;
  }
  if (r.amountVaries === true) {
    return `${day} · added at ${formatMoney(r.amountCents, DEFAULT_CURRENCY)}, for you to check`;
  }
  if (r.kind === 'transfer') {
    return `${day} · moved automatically from ${from} to ${accountName(accounts, r.toAccountId)}`;
  }
  return `${day} · added automatically ${r.kind === 'income' ? 'into' : 'from'} ${from}`;
}

/** Whether an item is running on listed accounts */
export function running(ledger: Ledger, r: Recurring) {
  if (r.archived) return false;
  const listed = (id: string | null) =>
    id == null || ledger.accounts.some((a) => a.id === id && !a.archived);
  return listed(r.accountId) && listed(r.toAccountId);
}

/** The day `days` after `date` (2026-11-10 + 30 = 2026-12-10), from its digits */
function daysAfter(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A card owed with no payment scheduled into it: what's owed, and by when if a charge is ahead */
export interface CardNote {
  account: Account;
  /** "RM 879.80" */
  owed: string;
  /** "Dec 3", the day of its last charge in the next 30 days, or null with none ahead */
  by: string | null;
}

/**
 * Each listed card that's owed with no running transfer scheduled into it: what's owed today
 * plus its scheduled spending up to its last charge in the next 30 days, by that day ("Visa:
 * RM 879.80 owed by Dec 3, no payment scheduled."), or with none ahead what's owed alone
 */
export function cardNotes(ledger: Ledger, today: string): CardNote[] {
  const items = (ledger.recurring ?? []).filter((r) => running(ledger, r));
  const until = daysAfter(today, 30);
  return ledger.accounts
    .filter((a) => a.kind === 'card' && !a.archived && a.balanceCents < 0)
    .filter((card) => !items.some((r) => r.kind === 'transfer' && r.toAccountId === card.id))
    .map((card) => {
      let owed = -card.balanceCents;
      let last: string | null = null;
      for (const r of items) {
        if (r.kind !== 'expense' || r.accountId !== card.id) continue;
        for (let at = r.nextDue; at <= until; at = nextAfter(r.schedule, r.day, at)) {
          owed += r.amountCents;
          if (last == null || at > last) last = at;
        }
      }
      return {
        account: card,
        owed: formatMoney(owed, card.currency),
        by: last == null ? null : shortDate(last),
      };
    });
}
