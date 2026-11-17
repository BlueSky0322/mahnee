import { useEffect, useRef } from 'react';
import { DEFAULT_SETTINGS } from '@shared/api';
import type { Period } from '@shared/period';
import { monthStartDayOf, periodMonthOf, periodOf } from '@shared/period';
import { useProfile } from '../profile/ProfileContext';
import { toDateInput } from '../utils/date-input';
import { forgetMonthTotals } from './ledger';
import { useWholeLedger } from './useLedger';

// The person's month (shared/period.ts) as the app works it out: from their settings and,
// on payday, the pay's day among the repeating items, as the server does from the same.
// Each month's figures come from the server summed over its days (MonthSummary firstDay
// and lastDay); this says which month today is in and what an earlier one's days are, so
// a page knows which to ask for.

/**
 * The day the person's month starts on, 1 to 31; null until it's known (the profile, and
 * on payday the repeating items, not loaded yet)
 */
export function useKnownMonthStart(): number | null {
  const { profile } = useProfile();
  const { data: ledger } = useWholeLedger();
  if (profile == null) return null;
  const { settings } = profile;
  if (settings.monthStartMode === 'payday' && ledger == null) return null;
  return monthStartDayOf(settings, ledger?.recurring ?? []);
}

/** The day the person's month starts on, 1 to 31: the 1st until it's known */
export const useMonthStart = (): number =>
  useKnownMonthStart() ?? monthStartDayOf(DEFAULT_SETTINGS, []);

/** The month `today` (the person's own day, 2026-11-26) is in, from `start` */
export const periodOfDay = (today: string, start: number): Period =>
  periodOf(periodMonthOf(today, start), start);

/** The person's month: the one today is in, and an earlier one's days by its name */
export interface Months {
  start: number;
  /** Today where the person is, as 2026-11-26 */
  today: string;
  /** The month today is in */
  current: Period;
  /** The month named `month` (2026-10) */
  of: (month: string) => Period;
}

export function useMonths(): Months {
  const start = useMonthStart();
  const today = toDateInput(new Date());
  return { start, today, current: periodOfDay(today, start), of: (m) => periodOf(m, start) };
}

/**
 * Drops every month's totals kept and shown when the day the month starts on changes on
 * this page: a new start day saved, or the pay it starts on moved or stopped. Not when it
 * first becomes known, so opening the app drops nothing.
 */
export function useForgetMonthsWhenTheStartChanges() {
  const start = useKnownMonthStart();
  const was = useRef<number | null>(null);
  useEffect(() => {
    if (start == null) return;
    if (was.current != null && was.current !== start) void forgetMonthTotals();
    was.current = start;
  }, [start]);
}

/** This month's name (2026-11), the person's month */
export const useThisMonth = (): string => useMonths().current.month;
