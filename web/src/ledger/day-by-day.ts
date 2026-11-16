import type { DayTotal } from '@shared/api';
import { periodDays } from '@shared/budgets';

// Home's "Day by day" calendar: each day of the period with what was spent on it, against
// the middle day so far. The middle day is the median of each day's spending from the
// period's first day to today, a day with nothing spent counting as 0; with an even count
// it's the mean of the two middle days, in whole cents rounded half up. A day so far above
// it is "more", at or below it "less" (against the figure as shown); a day still to come is
// neither. `today` is the person's own day, as toDateInput(new Date()) gives it.

/** One day of the period as the calendar shows it */
export interface DaySpent {
  date: string;
  /** Spent on it, whole cents; 0 for nothing */
  cents: number;
  /** Against the middle day; null for a day still to come */
  against: 'more' | 'less' | null;
}

/**
 * The period's days (at most a month's) with their spending, from a month's totals'
 * spentByDay; days outside the period are left out
 */
export function dayByDay(
  spentByDay: readonly DayTotal[],
  firstDay: string,
  lastDay: string,
  today: string,
): { middleCents: number | null; days: DaySpent[] } {
  const spent = new Map(spentByDay.map((d) => [d.date, d.cents]));
  const days = periodDays(firstDay, lastDay).map((date) => ({
    date,
    cents: spent.get(date) ?? 0,
  }));
  const soFar = days.filter((d) => d.date <= today).map((d) => d.cents);
  const middleCents = median(soFar);
  return {
    middleCents,
    days: days.map((d) => ({
      ...d,
      against:
        middleCents == null || d.date > today ? null : d.cents > middleCents ? 'more' : 'less',
    })),
  };
}

/**
 * The median of whole-cent amounts, rounded half up; null for none. A day's spending is
 * at most what a person can have (5e15 cents), and the mean of two is taken as the lower
 * plus half the gap, so nothing passes what a number holds exactly.
 */
function median(cents: number[]): number | null {
  if (cents.length === 0) return null;
  const sorted = [...cents].sort((a, b) => a - b);
  const half = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[half];
  const [low, high] = [sorted[half - 1], sorted[half]];
  return low + Math.ceil((high - low) / 2);
}
