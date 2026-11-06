import type { Ledger, Recurring } from '@shared/api';
import { monthEnd, nextAfter } from '@shared/recurring';

// What's expected at the end of this month, and what's due now, worked out from one copy of
// the ledger (balances and repeating items read together), so a log is never counted in
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

/** What's expected at the end of the month `today` (the person's own day) is in */
export function monthEndForecast(ledger: Ledger, today: string): Forecast {
  const balancesCents = ledger.accounts
    .filter((a) => !a.archived)
    .reduce((sum, a) => sum + a.balanceCents, 0);
  const end = monthEnd(today);
  const items: StillDue[] = [];
  for (const r of ledger.recurring ?? []) {
    if (r.kind === 'transfer' || !active(ledger, r)) continue;
    const cents = r.kind === 'income' ? r.amountCents : -r.amountCents;
    for (let date = r.nextDue; date <= end; date = nextAfter(r.schedule, r.day, date)) {
      items.push({ recurring: r, date, cents });
    }
  }
  const sorted = byDay(items);
  return {
    cents: sorted.reduce((sum, item) => sum + item.cents, balancesCents),
    balancesCents,
    items: sorted,
  };
}

/** Every listed item due now (next due `today` or before), oldest first */
export function dueNow(ledger: Ledger, today: string): DueNow[] {
  return byDay(
    (ledger.recurring ?? [])
      .filter((r) => active(ledger, r) && r.nextDue <= today)
      .map((recurring) => ({ recurring, date: recurring.nextDue })),
  ).map(({ recurring, date }) => ({ recurring, due: date }));
}

/** Whether anything repeats: listed items, whether due or not */
export const anyRepeating = (ledger: Ledger) => (ledger.recurring ?? []).some((r) => !r.archived);
