// Spending over time: a category's last 12 months, as the month card shows them. The 12
// are the month shown and the 11 before it; the average is over those 11 finished months,
// so a month half done doesn't drag it down, in whole cents rounded half up; and the month
// is compared with the average as shown (rounded to the cent).

/** How many months a category's spending over time shows, the month shown included */
export const TREND_MONTHS = 12;

/** The month `by` months after `month` (before it, below zero), as 2026-11 */
function shiftMonth(month: string, by: number) {
  const [y, m] = month.split('-').map(Number);
  const index = y * 12 + (m - 1) + by;
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/** The TREND_MONTHS months ending at `month` (2026-11), oldest first */
export const trendMonths = (month: string): string[] =>
  Array.from({ length: TREND_MONTHS }, (_, i) => shiftMonth(month, i - (TREND_MONTHS - 1)));

/** The month after `month`, where its 12 months stop (exclusive) */
export const monthAfter = (month: string) => shiftMonth(month, 1);

/**
 * The average of whole-cent amounts, in whole cents, rounded half up. Each amount is at
 * least 0 and their sum at most what a person can have (5e15 cents), so the sum, the
 * quotient and the remainder are whole numbers a number holds exactly.
 */
export function averageCents(cents: readonly number[]): number {
  if (cents.length === 0) return 0;
  const sum = cents.reduce((all, c) => all + c, 0);
  const n = cents.length;
  let quotient = Math.floor(sum / n);
  let remainder = sum - quotient * n;
  // The division above is a float's: put it right should it be one off
  if (remainder < 0) {
    quotient -= 1;
    remainder += n;
  } else if (remainder >= n) {
    quotient += 1;
    remainder -= n;
  }
  return remainder * 2 >= n ? quotient + 1 : quotient;
}

/** A month against the average of the months before it */
export interface AgainstAverage {
  /** The average of the months before, in whole cents, as shown */
  averageCents: number;
  /** How far the month is from that average, in whole cents; 0 when the same */
  byCents: number;
  direction: 'above' | 'below' | 'same';
}

/**
 * The last of `months` (whole cents, oldest first) against the average of the ones before
 * it, as shown: the difference is taken from the rounded average
 */
export function againstAverage(months: readonly number[]): AgainstAverage {
  const shown = months.at(-1) ?? 0;
  const average = averageCents(months.slice(0, -1));
  const difference = shown - average;
  return {
    averageCents: average,
    byCents: Math.abs(difference),
    direction: difference > 0 ? 'above' : difference < 0 ? 'below' : 'same',
  };
}
