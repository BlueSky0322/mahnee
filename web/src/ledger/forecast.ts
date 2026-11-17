import type { Ledger, Recurring } from '@shared/api';
import { monthEnd, nextAfter, onOrAfter } from '@shared/recurring';

// What's expected at the end of this month, and what's due now (items that ask first),
// worked out from one copy of the ledger (balances and repeating items read together), so a log is never counted in
// both the balance and what's still due.
//
// Expected at month end: today's balances of every listed account (what's owed on a card
// is below zero, so it counts against them), less the bills still due this month, plus the
// income still due. Still due is every occurrence of a listed item on a listed account not
// yet logged or skipped: from its next due date (today's and overdue ones too) up to and
// including the month's last day. Transfers move money between the person's own accounts,
// so they change nothing. Logging one moves it from still due into the balance, so the
// total holds; skipping it raises the total.
//
// Every total is exact: balances are at most 5e15 cents, and at most MAX_RECURRING items,
// each due at most once a week since 2000 (about 1,400 times) at most MAX_TRANSACTION_CENTS,
// add at most about 2.8e14 more, well under the 9e15 a number holds exactly.

/** One occurrence still due this month, and how it moves the total (below zero for a bill) */
export interface StillDue {
  recurring: Recurring;
  date: string;
  cents: number;
}

export interface Forecast {
  /** What's expected at the end of the month, in cents; below zero when it would be */
  cents: number;
  /** Today's balances of every listed account */
  balancesCents: number;
  /** The bills still due this month, in total (0 or more) */
  billsCents: number;
  /** The income still due this month, in total (0 or more) */
  payCents: number;
  /** Each occurrence still due this month, by day */
  items: StillDue[];
}

/** One due now: its next due date is today or before */
export interface DueNow {
  recurring: Recurring;
  due: string;
}

/** Whether an item is repeating and can be logged: listed, on listed accounts */
function active(ledger: Ledger, r: Recurring) {
  if (r.archived) return false;
  const listed = (id: string | null) =>
    id == null || ledger.accounts.some((a) => a.id === id && !a.archived);
  return listed(r.accountId) && listed(r.toAccountId);
}

/** By day, then in the order the items were set up */
const byDay = <T extends { date: string }>(items: T[]) =>
  items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => (a.item.date < b.item.date ? -1 : a.item.date > b.item.date ? 1 : a.i - b.i))
    .map(({ item }) => item);

/**
 * What's expected at the end of the month `today` (the person's own day) is in: its last
 * day `end`, the person's month (shared/period.ts), the calendar month's when not given
 */
export function monthEndForecast(ledger: Ledger, today: string, end = monthEnd(today)): Forecast {
  const balancesCents = ledger.accounts
    .filter((a) => !a.archived)
    .reduce((sum, a) => sum + a.balanceCents, 0);
  const items: StillDue[] = [];
  for (const r of ledger.recurring ?? []) {
    if (r.kind === 'transfer' || !active(ledger, r)) continue;
    const cents = r.kind === 'income' ? r.amountCents : -r.amountCents;
    for (let date = r.nextDue; date <= end; date = nextAfter(r.schedule, r.day, date)) {
      items.push({ recurring: r, date, cents });
    }
  }
  const sorted = byDay(items);
  const billsCents = sorted.reduce((sum, item) => sum + (item.cents < 0 ? -item.cents : 0), 0);
  const payCents = sorted.reduce((sum, item) => sum + (item.cents > 0 ? item.cents : 0), 0);
  return {
    cents: balancesCents - billsCents + payCents,
    balancesCents,
    billsCents,
    payCents,
    items: sorted,
  };
}

/** One listed item's next day after today, as Home's Coming up lists it */
export interface Upcoming {
  recurring: Recurring;
  date: string;
}

/** The day after a calendar day (2026-11-30 -> 2026-12-01), worked from its digits */
function dayAfter(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1));
  return next.toISOString().slice(0, 10);
}

/**
 * Each listed item's next day after `today` (one due today or overdue moves on to the one
 * after today; that one is still asked about as due now), soonest first, at most `count`.
 * Transfers are listed too: they're scheduled, though they change no total.
 */
export function comingUp(ledger: Ledger, today: string, count: number): Upcoming[] {
  const after = dayAfter(today);
  const next = (ledger.recurring ?? [])
    .filter((r) => active(ledger, r))
    .map((recurring) => ({
      recurring,
      date:
        recurring.nextDue > today
          ? recurring.nextDue
          : onOrAfter(recurring.schedule, recurring.day, after),
    }));
  return byDay(next).slice(0, count);
}

/**
 * Every listed item due now (next due `today` or before) that asks first, oldest first: the
 * rest are added on their day by the server (owner decisions D8 and D19)
 */
export function dueNow(ledger: Ledger, today: string): DueNow[] {
  return byDay(
    (ledger.recurring ?? [])
      .filter((r) => active(ledger, r) && r.askFirst === true && r.nextDue <= today)
      .map((recurring) => ({ recurring, date: recurring.nextDue })),
  ).map(({ recurring, date }) => ({ recurring, due: date }));
}

/** Whether anything repeats: listed items, whether due or not */
export const anyRepeating = (ledger: Ledger) => (ledger.recurring ?? []).some((r) => !r.archived);

/** The listed income item next due (overdue or not), for Home's "Salary due Nov 25"; null for none */
export function nextPay(ledger: Ledger): DueNow | null {
  const pay = byDay(
    (ledger.recurring ?? [])
      .filter((r) => r.kind === 'income' && active(ledger, r))
      .map((recurring) => ({ recurring, date: recurring.nextDue })),
  )[0];
  return pay == null ? null : { recurring: pay.recurring, due: pay.date };
}
