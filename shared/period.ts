// The person's month (owner decision D7, "Every monthly figure"): every monthly figure
// runs from the day their month starts on to the day before the next one starts. Home's
// month, its days and Tidy up, budgets and what each month carries over, the 12 months,
// Plan, Activity's This month and the month end all use these days; export's "This year"
// stays the calendar year.
//
// The month can start on a day of the month (1 to 28), on each month's last day ("Last
// day of the month", kept as 31), or on payday: the day of the month a running monthly
// pay in Scheduled is due (1 to 31). A start past a month's last day starts that month on
// its last day, so every period is 28 to 31 days.
//
// A period is named for the month holding most of its days: from the 25th, "November" is
// October 25 to November 24. So that every name is used once and no month is skipped, a
// period starting on the 15th or before is named for the month it starts in, and one
// starting on the 16th or later for the month it ends in; that is the month holding most
// of its days, but for a tie and a start on the 16th in a 31-day month (16 days to 15).
//
// Days are worked out as calendar days from their digits, never from a Date in the
// device's zone, so a daylight-saving change or a zone ahead of UTC can't shift them.

import type { Recurring, Settings } from './api';
import { isMonth } from './ledger';
import { LAST_DAY_OF_MONTH } from './settings';

/** The longest period: a month */
export const MAX_PERIOD_DAYS = 31;

/** Day N of a period of M days: 0 before it starts, M once it's over */
export interface PeriodDay {
  day: number;
  days: number;
}

/** A period: the month it's named for (2026-11) and its first and last day */
export interface Period {
  month: string;
  firstDay: string;
  lastDay: string;
}

/**
 * The last month that can be asked for: a month's days can run into the month after it,
 * and days end in 9999
 */
export const LAST_MONTH = '9998-12';

/** Whether `v` is a month whose days can be worked out: from 2000 up to LAST_MONTH */
export const isPeriodMonth = (v: unknown): v is string => isMonth(v) && v <= LAST_MONTH;

/** The last start day a period is named for the month it starts in */
const NAMED_FROM_ITS_START = 15;

const pad = (n: number) => String(n).padStart(2, '0');

const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);

/** How many days month `m` (1 to 12) of year `y` has */
const daysIn = (y: number, m: number) =>
  m === 2 ? (isLeap(y) ? 29 : 28) : [4, 6, 9, 11].includes(m) ? 30 : 31;

/** A day (2026-11-05) as a count of days, the same for every zone; RangeError if not a day */
function dayNumber(day: string): number {
  const found = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  const [y, m, d] = found == null ? [0, 0, 0] : found.slice(1).map(Number);
  if (found == null || m < 1 || m > 12 || d < 1 || d > daysIn(y, m)) {
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
  return `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
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

/** The month `by` months after `month` (before it, below zero), as 2026-11 */
export function shiftMonth(month: string, by: number): string {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${pad((index % 12) + 1)}`;
}

const isStartDay = (v: number) => Number.isInteger(v) && v >= 1 && v <= LAST_DAY_OF_MONTH;

/** The day a month (2026-11) starts on, from a start day: its last day when it's shorter */
function startIn(month: string, startDay: number): string {
  const [y, m] = month.split('-').map(Number);
  return `${month}-${pad(Math.min(startDay, daysIn(y, m)))}`;
}

/**
 * The day of the month the person's month starts on (1 to 31): on payday, the day their
 * pay is due, while it's a running monthly income; otherwise, and when the pay no longer
 * fits (stopped, weekly, gone), the day chosen, 31 for each month's last day
 */
export function monthStartDayOf(
  settings: Pick<Settings, 'monthStartMode' | 'monthStartDay' | 'monthStartPayId'>,
  recurring: readonly Pick<Recurring, 'id' | 'kind' | 'schedule' | 'day' | 'archived'>[],
): number {
  if (settings.monthStartMode === 'payday') {
    const pay = recurring.find((r) => r.id === settings.monthStartPayId);
    if (pay != null && !pay.archived && pay.kind === 'income' && pay.schedule === 'monthly') {
      return pay.day;
    }
  }
  return settings.monthStartDay;
}

/** The period named `month` (2026-11) for a month starting on `startDay` (1 to 31) */
export function periodOf(month: string, startDay: number): Period {
  if (!isPeriodMonth(month) || !isStartDay(startDay)) {
    throw new RangeError(`Not a month and start day: ${month}, ${startDay}`);
  }
  // Named for the month it starts in, or the one it ends in
  const startMonth = startDay <= NAMED_FROM_ITS_START ? month : shiftMonth(month, -1);
  const firstDay = startIn(startMonth, startDay);
  const lastDay = dayOf(dayNumber(startIn(shiftMonth(startMonth, 1), startDay)) - 1);
  return { month, firstDay, lastDay };
}

/** The name (2026-11) of the period `day` (2026-11-05) is in, for a month starting on `startDay` */
export function periodMonthOf(day: string, startDay: number): string {
  const month = day.slice(0, 7);
  // In the period that starts this month, or the one that started the month before
  const startMonth = day >= startIn(month, startDay) ? month : shiftMonth(month, -1);
  return startDay <= NAMED_FROM_ITS_START ? startMonth : shiftMonth(startMonth, 1);
}
