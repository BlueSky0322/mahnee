import type { PeriodDay } from '@shared/budgets';
import { periodDay } from '@shared/budgets';
import { monthEnd } from '@shared/recurring';
import { thisMonth, toDateInput } from '../../utils/date-input';

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
// through it today is, the person's own day. Its days come from the shared period rules
// (periodDay), so a month start day changes them in one place.
export function planMonth(month: string | null): PlanMonth {
  const current = thisMonth();
  const shown = month != null && month < current ? month : current;
  const isCurrent = shown === current;
  const firstDay = `${shown}-01`;
  const lastDay = monthEnd(firstDay);
  const today = isCurrent ? toDateInput(new Date()) : lastDay;
  return {
    month: shown,
    current,
    isCurrent,
    firstDay,
    lastDay,
    at: periodDay(firstDay, lastDay, today),
  };
}
