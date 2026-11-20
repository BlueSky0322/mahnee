import type { DayTotal, Transaction, WeekStart } from '@shared/api';
import { addDays, weekStartOf } from '@shared/period';
import { dayByDay } from './day-by-day';

// Home at a glance on a phone (owner audit, "Phone Home at a glance"): what was spent so
// far this month, the day against the median daily spend, the week's biggest expense and
// the last few days' entries. Only spending (expenses) counts towards the figures: income,
// transfers and planned payments still to come never do. For an earlier month everything
// is as of its last day (`day`). Money is whole cents.

/** How many days Recent activity goes back, the day itself included */
export const RECENT_DAYS = 7;

/** The days Home's glance looks at, all as the person's own calendar days */
export interface GlanceDays {
  /** Today, or an earlier month's last day */
  day: string;
  /** The month's first day */
  firstDay: string;
  /** The first day of the week `day` is in (weeks starting on the person's chosen day) */
  weekFrom: string;
  /** The first of the last RECENT_DAYS days to `day` */
  recentFrom: string;
}

export function glanceDays(day: string, firstDay: string, weekStart: WeekStart): GlanceDays {
  return {
    day,
    firstDay,
    weekFrom: weekStartOf(day, weekStart),
    recentFrom: addDays(day, -(RECENT_DAYS - 1)),
  };
}

/** What was spent from the month's first day to `day`, both included, in whole cents */
export function spentSoFar(spentByDay: readonly DayTotal[], firstDay: string, day: string) {
  let cents = 0;
  for (const d of spentByDay) if (d.date >= firstDay && d.date <= day) cents += d.cents;
  return cents;
}

/** A day's spending against the median daily spend so far */
export interface AgainstMedian {
  /** Spent on the day */
  cents: number;
  /** The median of each day's spending from the month's first day to the day, nothing as 0 */
  medianCents: number;
  /** How far above (over 0) or below (under 0) the median it is; 0 at it */
  differenceCents: number;
}

/**
 * The day's spending against Mahnee's median daily spend (the calendar's, dayByDay), from
 * the month's first day through `day`, days with nothing spent counting as 0
 */
export function againstMedian(
  spentByDay: readonly DayTotal[],
  firstDay: string,
  lastDay: string,
  day: string,
): AgainstMedian {
  const { middleCents, days } = dayByDay(spentByDay, firstDay, lastDay, day);
  const cents = days.find((d) => d.date === day)?.cents ?? 0;
  const medianCents = middleCents ?? 0;
  return { cents, medianCents, differenceCents: cents - medianCents };
}

/**
 * The largest single expense from `from` to `to` (both included), among `transactions`;
 * of two the same, the later one (they come newest first); null for none
 */
export function biggestSpend(
  transactions: readonly Transaction[],
  from: string,
  to: string,
): Transaction | null {
  let best: Transaction | null = null;
  for (const t of transactions) {
    if (t.kind !== 'expense' || t.date < from || t.date > to) continue;
    if (best == null || t.amountCents > best.amountCents) best = t;
  }
  return best;
}

/** The entries from `from` to `to`, by day, newest day first, each day's newest first */
export function byDay(
  transactions: readonly Transaction[],
  from: string,
  to: string,
): { date: string; entries: Transaction[] }[] {
  const days: { date: string; entries: Transaction[] }[] = [];
  for (const t of transactions) {
    if (t.date < from || t.date > to) continue;
    const last = days.at(-1);
    if (last?.date === t.date) last.entries.push(t);
    else days.push({ date: t.date, entries: [t] });
  }
  return days;
}
