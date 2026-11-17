import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Recurring, Settings } from './api';
import { DEFAULT_SETTINGS } from './api';
import { isBudgetMonth } from './budgets';
import { tidyUpFrom } from './categories';
import {
  MAX_PERIOD_DAYS,
  monthStartDayOf,
  periodDay,
  periodDays,
  periodMonthOf,
  periodOf,
} from './period';
import { LAST_DAY_OF_MONTH } from './settings';

// The month start day (owner decision D7, "Every monthly figure"): every monthly figure
// runs from the day the person's month starts on to the day before the next one starts,
// and a period is named for the month holding most of its days ("November" = Oct 25 to
// Nov 24). So that every name is used once and no month is skipped, a period is named for
// the month it starts in when it starts on the 15th or before, and for the month it ends
// in when it starts on the 16th or later (design digest, question 1). A day of the month
// past a month's last (29 to 31) starts that month on its last day; 31 is "Last day of the
// month". Payday mode starts each month on the scheduled pay's day of the month.

const settings = (more: Partial<Settings>) => ({ ...DEFAULT_SETTINGS, ...more });

const pay = (more: Partial<Recurring> = {}): Recurring => ({
  id: 'a'.repeat(16),
  kind: 'income',
  accountId: 'b'.repeat(16),
  toAccountId: null,
  amountCents: 500_000,
  categoryId: 'c'.repeat(16),
  payee: 'Acme',
  schedule: 'monthly',
  day: 20,
  startDate: '2026-01-20',
  nextDue: '2026-11-20',
  archived: false,
  ...more,
});

/** Every day from `first` to `last`, as 2026-11-05, worked from UTC so no zone moves them */
function days(first: string, last: string) {
  const out: string[] = [];
  for (
    let at = Date.parse(`${first}T00:00:00Z`);
    at <= Date.parse(`${last}T00:00:00Z`);
    at += 86_400_000
  ) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

const START_DAYS = [...Array.from({ length: 28 }, (_, i) => i + 1), 29, 30, LAST_DAY_OF_MONTH];

describe('monthStartDayOf', () => {
  test('is the day of the month chosen, 31 meaning each month on its last day', () => {
    expect(monthStartDayOf(DEFAULT_SETTINGS, [])).toBe(1);
    expect(monthStartDayOf(settings({ monthStartDay: 25 }), [])).toBe(25);
    expect(monthStartDayOf(settings({ monthStartDay: LAST_DAY_OF_MONTH }), [])).toBe(31);
  });

  test("on payday, is the scheduled pay's day of the month", () => {
    const salary = pay({ day: 20 });
    const s = settings({ monthStartMode: 'payday', monthStartDay: 1, monthStartPayId: salary.id });
    expect(monthStartDayOf(s, [pay({ id: 'd'.repeat(16), day: 3 }), salary])).toBe(20);
    expect(monthStartDayOf(s, [pay({ day: 31 })])).toBe(31);
  });

  test("falls back to the day chosen when the pay doesn't fit: gone, stopped, weekly or not income", () => {
    const id = 'a'.repeat(16);
    const s = settings({ monthStartMode: 'payday', monthStartDay: 5, monthStartPayId: id });
    expect(monthStartDayOf(s, [])).toBe(5);
    expect(monthStartDayOf(s, [pay({ archived: true })])).toBe(5);
    expect(monthStartDayOf(s, [pay({ schedule: 'weekly', day: 3 })])).toBe(5);
    expect(monthStartDayOf(s, [pay({ kind: 'expense' })])).toBe(5);
    expect(monthStartDayOf(settings({ monthStartMode: 'payday', monthStartPayId: null }), [])).toBe(
      1,
    );
  });

  test('a pay chosen while the month runs on a date plays no part', () => {
    const s = settings({ monthStartMode: 'date', monthStartDay: 9, monthStartPayId: pay().id });
    expect(monthStartDayOf(s, [pay()])).toBe(9);
  });
});

describe.each([
  ['Asia/Kuala_Lumpur', -480],
  ['America/New_York', 300],
])('in %s', (zone, januaryOffset) => {
  beforeAll(() => {
    vi.stubEnv('TZ', zone);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test('the zone is in effect', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(januaryOffset);
  });

  describe('periodOf', () => {
    test('the 1st is the calendar month, as before', () => {
      expect(periodOf('2026-11', 1)).toEqual({
        month: '2026-11',
        firstDay: '2026-11-01',
        lastDay: '2026-11-30',
      });
      expect(periodOf('2028-02', 1)).toEqual({
        month: '2028-02',
        firstDay: '2028-02-01',
        lastDay: '2028-02-29',
      });
    });

    test('is named for the month holding most of its days: November is Oct 25 to Nov 24 (D7)', () => {
      expect(periodOf('2026-11', 25)).toEqual({
        month: '2026-11',
        firstDay: '2026-10-25',
        lastDay: '2026-11-24',
      });
      // Across a year
      expect(periodOf('2027-01', 25)).toEqual({
        month: '2027-01',
        firstDay: '2026-12-25',
        lastDay: '2027-01-24',
      });
    });

    test('starting on the 15th or before, it is the month it starts in; from the 16th, the one it ends in', () => {
      expect(periodOf('2026-11', 15)).toMatchObject({
        firstDay: '2026-11-15',
        lastDay: '2026-12-14',
      });
      expect(periodOf('2026-11', 16)).toMatchObject({
        firstDay: '2026-10-16',
        lastDay: '2026-11-15',
      });
      expect(periodOf('2026-12', 10)).toMatchObject({
        firstDay: '2026-12-10',
        lastDay: '2027-01-09',
      });
    });

    test('Last day of the month starts each month on its last day, February too', () => {
      expect(periodOf('2026-11', LAST_DAY_OF_MONTH)).toMatchObject({
        firstDay: '2026-10-31',
        lastDay: '2026-11-29',
      });
      expect(periodOf('2026-03', LAST_DAY_OF_MONTH)).toMatchObject({
        firstDay: '2026-02-28',
        lastDay: '2026-03-30',
      });
      expect(periodOf('2028-03', LAST_DAY_OF_MONTH)).toMatchObject({
        firstDay: '2028-02-29',
        lastDay: '2028-03-30',
      });
      // A pay on the 30th or 29th starts February on its last day, and the 29th in a leap year
      expect(periodOf('2026-03', 30)).toMatchObject({
        firstDay: '2026-02-28',
        lastDay: '2026-03-29',
      });
      expect(periodOf('2026-03', 29)).toMatchObject({
        firstDay: '2026-02-28',
        lastDay: '2026-03-28',
      });
      expect(periodOf('2028-03', 30)).toMatchObject({
        firstDay: '2028-02-29',
        lastDay: '2028-03-29',
      });
      expect(periodOf('2028-03', 29)).toMatchObject({
        firstDay: '2028-02-29',
        lastDay: '2028-03-28',
      });
    });

    test('refuses what is not a month or a start day', () => {
      expect(() => periodOf('2026-13', 1)).toThrow(RangeError);
      expect(() => periodOf('2026-11', 0)).toThrow(RangeError);
      expect(() => periodOf('2026-11', 32)).toThrow(RangeError);
      expect(() => periodOf('2026-11', 2.5)).toThrow(RangeError);
    });
  });

  describe('periodMonthOf', () => {
    test('names the period a day is in', () => {
      expect(periodMonthOf('2026-11-24', 25)).toBe('2026-11');
      expect(periodMonthOf('2026-11-25', 25)).toBe('2026-12');
      expect(periodMonthOf('2026-12-31', 25)).toBe('2027-01');
      expect(periodMonthOf('2026-11-30', 1)).toBe('2026-11');
      expect(periodMonthOf('2026-11-14', 15)).toBe('2026-10');
      expect(periodMonthOf('2026-11-15', 15)).toBe('2026-11');
      expect(periodMonthOf('2026-10-31', LAST_DAY_OF_MONTH)).toBe('2026-11');
      expect(periodMonthOf('2026-10-30', LAST_DAY_OF_MONTH)).toBe('2026-10');
    });

    test('every day of four years is in the period it names, and periods follow one another with no gap', () => {
      const all = days('2026-01-01', '2029-12-31');
      for (const start of START_DAYS) {
        const seen = new Map<string, { firstDay: string; lastDay: string }>();
        let last: string | null = null;
        for (const day of all) {
          const month = periodMonthOf(day, start);
          const period = seen.get(month) ?? periodOf(month, start);
          seen.set(month, period);
          expect(day >= period.firstDay && day <= period.lastDay, `${day} start ${start}`).toBe(
            true,
          );
          if (last != null && last !== month) {
            // The next period's name is the next month: none skipped, none used twice
            const [y, m] = last.split('-').map(Number);
            const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
            expect(month, `${day} start ${start}`).toBe(next);
            expect(period.firstDay).toBe(day);
          }
          last = month;
        }
        for (const { firstDay, lastDay } of seen.values()) {
          const length = days(firstDay, lastDay).length;
          expect(length).toBeGreaterThanOrEqual(28);
          expect(length).toBeLessThanOrEqual(MAX_PERIOD_DAYS);
        }
      }
    });

    test('is named for the month holding most of its days, but for a tie and a start on the 16th in a 31-day month', () => {
      for (const start of START_DAYS) {
        for (let year = 2026; year <= 2029; year++) {
          for (let m = 1; m <= 12; m++) {
            const month = `${year}-${String(m).padStart(2, '0')}`;
            const { firstDay, lastDay } = periodOf(month, start);
            const inside = days(firstDay, lastDay);
            const named = inside.filter((d) => d.startsWith(`${month}-`)).length;
            const other = inside.length - named;
            const where = `${month} start ${start}`;
            // A tie (14 and 14 from the 15th in a 28-day February; 15 and 15 from the 16th
            // in a 30-day month) is named by the rule, either month being right
            if (named === other) {
              expect([15, 16], where).toContain(start);
              continue;
            }
            // From the 16th in a 31-day month, the month it starts in holds 16 days to 15:
            // named for the month it ends in so that no name is skipped
            if (start === 16 && named < other) {
              expect([other - named, firstDay.slice(8)], where).toEqual([1, '16']);
              expect(days(firstDay, `${firstDay.slice(0, 8)}31`).length, where).toBe(16);
              continue;
            }
            expect(named, where).toBeGreaterThan(other);
          }
        }
      }
    });
  });

  describe('periodDay and periodDays', () => {
    test('day N of M of a period that is not the calendar month', () => {
      const { firstDay, lastDay } = periodOf('2026-12', 25);
      expect(periodDay(firstDay, lastDay, '2026-11-26')).toEqual({ day: 2, days: 30 });
      expect(periodDays(firstDay, lastDay)[0]).toBe('2026-11-25');
      expect(periodDays(firstDay, lastDay).at(-1)).toBe('2026-12-24');
    });

    test.each([
      // Across New York's clocks going back (November 1) and forward (March 8)
      ['2026-10-25', '2026-11-24'],
      ['2026-03-01', '2026-03-31'],
    ])('lists every day once, in order, from %s to %s', (firstDay, lastDay) => {
      const listed = periodDays(firstDay, lastDay);
      expect(listed).toEqual(days(firstDay, lastDay));
      expect(listed).toHaveLength(31);
      expect(new Set(listed).size).toBe(31);
      expect(periodDay(firstDay, lastDay, lastDay)).toEqual({ day: 31, days: 31 });
      expect(periodDay(firstDay, lastDay, '2026-11-02')).toEqual(
        firstDay === '2026-10-25' ? { day: 9, days: 31 } : { day: 31, days: 31 },
      );
    });
  });

  describe('tidyUpFrom', () => {
    test('is the first day of the period before', () => {
      expect(tidyUpFrom('2026-11', 1)).toBe('2026-10-01');
      expect(tidyUpFrom('2026-12', 25)).toBe('2026-10-25');
      expect(tidyUpFrom('2026-01', 25)).toBe('2025-11-25');
      expect(tidyUpFrom('2026-11', LAST_DAY_OF_MONTH)).toBe('2026-09-30');
    });
  });

  describe('isBudgetMonth', () => {
    // 01:00 on 26 November in UTC: tomorrow in UTC is the 27th
    const now = Date.UTC(2026, 10, 26, 1);
    test('takes the period tomorrow (in UTC) is in, and none after it', () => {
      expect(isBudgetMonth('2026-11', now, 1)).toBe(true);
      expect(isBudgetMonth('2026-12', now, 1)).toBe(false);
      // From the 25th, the 27th of November is in December's period
      expect(isBudgetMonth('2026-12', now, 25)).toBe(true);
      expect(isBudgetMonth('2027-01', now, 25)).toBe(false);
      expect(isBudgetMonth('1999-12', now, 25)).toBe(false);
    });

    test('from 23:30 UTC on the 24th, tomorrow in UTC is the 25th: the next period is allowed', () => {
      const late = Date.UTC(2026, 10, 24, 23, 30);
      expect(isBudgetMonth('2026-12', late, 25)).toBe(true);
      expect(isBudgetMonth('2027-01', late, 25)).toBe(false);
      // Half an hour earlier, tomorrow in UTC is still the 24th
      expect(isBudgetMonth('2026-12', Date.UTC(2026, 10, 23, 23, 30), 25)).toBe(false);
    });
  });
});
