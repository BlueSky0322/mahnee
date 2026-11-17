import type { PeriodDay } from '@shared/period';
import { periodDay } from '@shared/period';
import type { Months } from '../../ledger/month-start';

/** The month Plan shows, and how far through it today is */
export interface PlanMonth {
  /** As 2026-11 */
  month: string;
  /** This month, as 2026-11 */
  current: string;
  isCurrent: boolean;
  firstDay: string;
  lastDay: string;
  /** Day N of M: today's on this month, the last day's on one gone by */
  at: PeriodDay;
}

// The month Plan shows (`month`, null for this one), its first and last day and how far
// through it today is, the person's own day: the person's month (shared/period.ts, through
// useMonths), the one place Plan's month and its day N of M come from.
export function planMonth(month: string | null, months: Months): PlanMonth {
  const current = months.current.month;
  const shown = month != null && month < current ? month : current;
  const isCurrent = shown === current;
  const { firstDay, lastDay } = months.of(shown);
  const today = isCurrent ? months.today : lastDay;
  return {
    month: shown,
    current,
    isCurrent,
    firstDay,
    lastDay,
    at: periodDay(firstDay, lastDay, today),
  };
}
