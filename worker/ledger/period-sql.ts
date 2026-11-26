// The period name for a stored day, following shared/period.ts. The month is named for its
// start through day 15, and for the month after its start when it starts later.
export function periodMonthSql(column: string, start: string): string {
  // With a late start, the last day of a short month also starts a new period. Looking
  // one day ahead handles February and any other month shorter than the chosen start.
  return `CASE
    WHEN ${start} = 1 THEN substr(${column}, 1, 7)
    WHEN ${start} <= 15 THEN strftime('%Y-%m', ${column}, (1 - ${start}) || ' days')
    WHEN CAST(substr(${column}, 9, 2) AS INTEGER) >= ${start}
      THEN strftime('%Y-%m', ${column}, 'start of month', '+1 month')
    ELSE strftime('%Y-%m', ${column}, '+1 day')
  END`;
}
