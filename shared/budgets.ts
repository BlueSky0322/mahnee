// Budgets: a monthly amount a person means to spend in a top-level spending category, its
// subcategories counting toward it. An amount set in a month applies from then on, until
// it's changed; earlier months keep what they had. With Carry over, last month's leftover
// is added to this month's amount (or what it overspent taken away), chained month to month
// from the first budgeted month. The Worker works out what each month before left
// (monthBudgets); the app works out what's left now from the spending it shows
// (budgetFigures), so both use the same sum.
//
// Every figure stays exact: an amount is at most MAX_TRANSACTION_CENTS, and a chain runs
// from the first budgeted month (2000 at the earliest) to the month asked, which is never
// after this one (worker/ledger/summary.ts gives a month still to come no budgets): a few
// hundred months, so carried amounts stay under 1e12 cents, and spending under the 5e15 a
// person's totals are bounded by.

import type { Category, MonthBudget } from './api';
import { MAX_TRANSACTION, MAX_TRANSACTION_CENTS, fitsTransactionCents, isMonth } from './ledger';

/** A budget as it's kept: an amount from a month on, or none (null) from that month on */
export interface BudgetRow {
  categoryId: string;
  fromMonth: string;
  amountCents: number | null;
  carryOver: boolean;
}

/** The largest monthly budget, in cents: the same as the largest single amount */
export const MAX_BUDGET_CENTS = MAX_TRANSACTION_CENTS;

/** Why an amount can't be a budget */
export const BUDGET_RANGE = `A budget is more than 0 and up to ${MAX_TRANSACTION.toLocaleString('en')}`;

/** Whether an amount can be a monthly budget: whole cents, above 0, at most MAX_BUDGET_CENTS */
export const fitsBudgetCents = fitsTransactionCents;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether `v` is a month a budget can be set from: 2000 or later and not after this one (by
 * tomorrow in UTC, so wherever a person is, their own month is allowed)
 */
export const isBudgetMonth = (v: unknown, now = Date.now()): v is string =>
  isMonth(v) && v <= new Date(now + DAY_MS).toISOString().slice(0, 7);

/**
 * Why `category` (one of the person's) can't have a budget, or null when it can: only a
 * top-level spending category has one; its subcategories count toward it
 */
export function whyNoBudget(category: Pick<Category, 'kind' | 'parentId'>): string | null {
  if (category.parentId != null) return 'A budget goes on a top-level category';
  if (category.kind !== 'expense') return 'A budget goes on a spending category';
  return null;
}

/** The month after `month` (2026-12 after 2026-11) */
export function nextMonth(month: string): string {
  const [year, m] = month.split('-').map(Number);
  return m === 12 ? `${year + 1}-01` : `${year}-${String(m + 1).padStart(2, '0')}`;
}

/**
 * A month's budget against `spentCents` spent in it (its subcategories included): what was
 * carried in (last month's leftover, only with Carry over), what that makes available, and
 * what's left (below zero when over)
 */
export function budgetFigures(
  budget: Pick<MonthBudget, 'amountCents' | 'carryOver' | 'lastMonthLeftCents'>,
  spentCents: number,
): { carriedCents: number; availableCents: number; leftCents: number } {
  const carriedCents = budget.carryOver ? budget.lastMonthLeftCents : 0;
  const availableCents = budget.amountCents + carriedCents;
  return { carriedCents, availableCents, leftCents: availableCents - spentCents };
}

/**
 * The budgets in effect in `month`, from the rows kept (the person's, in any order within
 * a category), listed in the order each category's rows first come. `spent` gives what
 * was spent in a top-level category in an earlier month, subcategories included.
 */
export function monthBudgets(
  month: string,
  rows: readonly BudgetRow[],
  spent: (month: string, categoryId: string) => number,
): MonthBudget[] {
  const byCategory = new Map<string, BudgetRow[]>();
  for (const row of rows) {
    if (row.fromMonth > month) continue;
    const list = byCategory.get(row.categoryId) ?? [];
    list.push(row);
    byCategory.set(row.categoryId, list);
  }
  const budgets: MonthBudget[] = [];
  for (const [categoryId, list] of byCategory) {
    const sorted = [...list].sort((a, b) => (a.fromMonth < b.fromMonth ? -1 : 1));
    // Month by month from the first, each month's leftover carried into the next
    let at = 0;
    let lastMonthLeftCents = 0;
    for (let m = sorted[0].fromMonth; ; m = nextMonth(m)) {
      while (at + 1 < sorted.length && sorted[at + 1].fromMonth <= m) at++;
      const { amountCents, carryOver } = sorted[at];
      if (m === month) {
        if (amountCents != null) {
          budgets.push({ categoryId, amountCents, carryOver, lastMonthLeftCents });
        }
        break;
      }
      lastMonthLeftCents =
        amountCents == null
          ? 0
          : budgetFigures({ amountCents, carryOver, lastMonthLeftCents }, spent(m, categoryId))
              .leftCents;
    }
  }
  return budgets;
}

// How far through its period a month is, and how a budget is doing against it: Home's and
// Plan's today marker sits at day N of M, and a budget is "faster than the month" when more
// of it is spent than of the period is gone. A period is given by its first and last day,
// so one that isn't the calendar month (October 25 to November 24) works the same way.
// Days are worked out as calendar days from their digits, never from a Date in the
// device's zone, so a daylight-saving change or a zone ahead of UTC can't shift them.
// (These go to shared/period.ts with the month start day; nothing else should import them
// from here.)

/** The longest period: a month */
export const MAX_PERIOD_DAYS = 31;

/** Day N of a period of M days: 0 before it starts, M once it's over */
export interface PeriodDay {
  day: number;
  days: number;
}

/** How a budget is doing: over it, spending faster than the period is going, or on track */
export type BudgetPace = 'over' | 'faster' | 'onTrack';

/** A day (2026-11-05) as a count of days, the same for every zone; RangeError if not a day */
function dayNumber(day: string): number {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const [y, m, d] = found == null ? [0, 0, 0] : found.slice(1).map(Number);
  const inMonth = [
    31,
    y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  if (found == null || m < 1 || m > 12 || d < 1 || d > inMonth[m - 1]) {
    throw new RangeError(`Not a day: ${day}`);
  }
  // Days from March 1 of year 0, March first so a leap day ends its year
  const year = m <= 2 ? y - 1 : y;
  const dayOfYear = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return (
    year * 365 + Math.floor(year / 4) - Math.floor(year / 100) + Math.floor(year / 400) + dayOfYear
  );
}

/** The day (2026-11-05) a count of days from dayNumber stands for */
function dayOf(n: number): string {
  const era = Math.floor(n / 146_097);
  const dayOfEra = n - era * 146_097;
  const yearOfEra = Math.floor(
    (dayOfEra -
      Math.floor(dayOfEra / 1_460) +
      Math.floor(dayOfEra / 36_524) -
      Math.floor(dayOfEra / 146_096)) /
      365,
  );
  const dayOfYear =
    dayOfEra - (365 * yearOfEra + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100));
  const mp = Math.floor((5 * dayOfYear + 2) / 153);
  const d = dayOfYear - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const y = era * 400 + yearOfEra + (m <= 2 ? 1 : 0);
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** How many days a period has; RangeError if it ends before it starts or is over a month */
function periodLength(firstDay: string, lastDay: string): { first: number; days: number } {
  const first = dayNumber(firstDay);
  const days = dayNumber(lastDay) - first + 1;
  if (days < 1 || days > MAX_PERIOD_DAYS) {
    throw new RangeError(`A period is 1 to ${MAX_PERIOD_DAYS} days`);
  }
  return { first, days };
}

/** Every day of the period, first to last: at most MAX_PERIOD_DAYS */
export function periodDays(firstDay: string, lastDay: string): string[] {
  const { first, days } = periodLength(firstDay, lastDay);
  return Array.from({ length: days }, (_, i) => dayOf(first + i));
}

/**
 * How far through the period `today` (the person's own day, as 2026-11-10) is: day 10 of
 * 30 puts the today marker a third of the way
 */
export function periodDay(firstDay: string, lastDay: string, today: string): PeriodDay {
  const { first, days } = periodLength(firstDay, lastDay);
  const day = Math.min(Math.max(dayNumber(today) - first + 1, 0), days);
  return { day, days };
}

/**
 * A budget's pace, from what was spent in it and what's available (its amount and what
 * carried over, budgetFigures): over when more was spent than is available; faster than
 * the month when spent / available is more than day / days, compared as spent x days
 * against available x day so nothing rounds. Over is decided first, so spent is at most
 * what's available (under 2e12 cents) when multiplied, and the products stay exact.
 */
export function budgetPace(spentCents: number, availableCents: number, at: PeriodDay): BudgetPace {
  if (spentCents > availableCents) return 'over';
  return spentCents * at.days > availableCents * at.day ? 'faster' : 'onTrack';
}
