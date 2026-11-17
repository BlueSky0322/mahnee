// The day the person's month starts on (shared/period.ts), read from their settings (and,
// on payday, their pay) each time a month's figures are summed or a budget is set.

import { DEFAULT_SETTINGS } from '../../shared/api';
import type { MonthStartMode } from '../../shared/api';
import { monthStartDayOf } from '../../shared/period';

interface StartRow {
  mode: MonthStartMode;
  day: number;
  payId: string | null;
  /** The pay's day, kind, schedule and whether it stopped; null without one */
  payDay: number | null;
  payKind: 'expense' | 'income' | 'transfer' | null;
  paySchedule: 'monthly' | 'weekly' | null;
  payArchived: 0 | 1 | null;
}

/**
 * The day of the month `email`'s month starts on (1 to 31): their pay's day on payday,
 * while it's a running monthly income, otherwise the day chosen; the 1st before they
 * choose anything
 */
export async function readMonthStart(db: D1Database, email: string): Promise<number> {
  const row = await db
    .prepare(
      `SELECT s.month_start_mode AS mode, s.month_start_day AS day,
              s.month_start_pay_id AS payId, r.day AS payDay, r.kind AS payKind,
              r.schedule AS paySchedule, r.archived AS payArchived
       FROM user_settings s
       LEFT JOIN recurring r ON r.email = s.email AND r.id = s.month_start_pay_id
       WHERE s.email = ?`,
    )
    .bind(email)
    .first<StartRow>();
  if (row == null) return monthStartDayOf(DEFAULT_SETTINGS, []);
  return monthStartDayOf(
    { monthStartMode: row.mode, monthStartDay: row.day, monthStartPayId: row.payId },
    row.payId == null || row.payDay == null
      ? []
      : [
          {
            id: row.payId,
            day: row.payDay,
            kind: row.payKind ?? 'expense',
            schedule: row.paySchedule ?? 'weekly',
            archived: row.payArchived === 1,
          },
        ],
  );
}
