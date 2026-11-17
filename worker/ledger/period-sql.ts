// Which period (shared/period.ts) a stored day is in, worked out by SQLite from the day's
// digits, so a month's spending can be grouped by the person's month in one statement.

/**
 * SQL for the name of the period (2026-11) the day in `column` (2026-11-05) is in, for a
 * month starting on the day bound as `start` (a parameter such as ?3, never written into
 * the statement): the period that starts in the day's month, or the one that started in
 * the month before; named for the month it starts in from the 15th or before, else for
 * the one after. A start past a month's last day is that month's last day.
 */
export function periodMonthSql(column: string, start: string): string {
  const monthStart = `strftime('%Y-%m', ${column})`;
  const lastDay = `CAST(strftime('%d', ${monthStart} || '-01', '+1 month', '-1 day') AS INTEGER)`;
  const startsOn = `MIN(${start}, ${lastDay})`;
  const day = `CAST(strftime('%d', ${column}) AS INTEGER)`;
  // Months to move from the day's own: back one before this month's start, on one when
  // named for the month a period ends in
  const by = `((CASE WHEN ${day} < ${startsOn} THEN -1 ELSE 0 END) + (CASE WHEN ${start} <= 15 THEN 0 ELSE 1 END))`;
  return `strftime('%Y-%m', ${monthStart} || '-01', ${by} || ' months')`;
}
