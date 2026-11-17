import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { BudgetRow } from './budgets';
import { budgetFigures, budgetPace, monthBudgets } from './budgets';
import { periodDay, periodDays } from './period';

// The budget rule both the Worker and the app use (B1, B2): an amount from a month on until
// changed; with Carry over, last month's leftover added (or its overspending taken away),
// chained month to month from the first budgeted month.

const row = (
  categoryId: string,
  fromMonth: string,
  amountCents: number | null,
  carryOver = false,
): BudgetRow => ({ categoryId, fromMonth, amountCents, carryOver });

/** Spending by month and top-level category, nothing where not given */
const spending =
  (by: Record<string, number>) =>
  (month: string, categoryId: string): number =>
    by[`${month} ${categoryId}`] ?? 0;

describe('budgetFigures', () => {
  test("is the amount less spending, with last month's leftover only when carried over", () => {
    const food = { amountCents: 30_000, carryOver: false, lastMonthLeftCents: 3_000 };
    expect(budgetFigures(food, 18_000)).toEqual({
      carriedCents: 0,
      availableCents: 30_000,
      leftCents: 12_000,
    });
    expect(budgetFigures({ ...food, carryOver: true }, 18_000)).toEqual({
      carriedCents: 3_000,
      availableCents: 33_000,
      leftCents: 15_000,
    });
    expect(budgetFigures({ ...food, carryOver: true, lastMonthLeftCents: -2_000 }, 30_000)).toEqual(
      { carriedCents: -2_000, availableCents: 28_000, leftCents: -2_000 },
    );
    expect(budgetFigures(food, 30_000).leftCents).toBe(0);
  });
});

describe('monthBudgets', () => {
  test('repeats an amount every month until changed, and none before it starts', () => {
    const rows = [row('food', '2025-08', 30_000), row('food', '2025-10', 40_000)];
    const spent = spending({
      '2025-08 food': 10_000,
      '2025-09 food': 27_000,
      '2025-10 food': 18_000,
    });
    expect(monthBudgets('2025-07', rows, spent)).toEqual([]);
    expect(monthBudgets('2025-08', rows, spent)).toEqual([
      { categoryId: 'food', amountCents: 30_000, carryOver: false, lastMonthLeftCents: 0 },
    ]);
    expect(monthBudgets('2025-09', rows, spent)).toEqual([
      { categoryId: 'food', amountCents: 30_000, carryOver: false, lastMonthLeftCents: 20_000 },
    ]);
    expect(monthBudgets('2025-10', rows, spent)).toEqual([
      { categoryId: 'food', amountCents: 40_000, carryOver: false, lastMonthLeftCents: 3_000 },
    ]);
    expect(monthBudgets('2025-11', rows, spent)).toEqual([
      { categoryId: 'food', amountCents: 40_000, carryOver: false, lastMonthLeftCents: 22_000 },
    ]);
  });

  test("chains what's carried over month to month, and starts fresh once it is off", () => {
    const spent = spending({ '2025-08 transport': 7_000, '2025-09 transport': 15_000 });
    const on = [row('transport', '2025-08', 10_000, true)];
    const line = (lastMonthLeftCents: number, carryOver = true) => [
      { categoryId: 'transport', amountCents: 10_000, carryOver, lastMonthLeftCents },
    ];
    expect(monthBudgets('2025-08', on, spent)).toEqual(line(0));
    expect(monthBudgets('2025-09', on, spent)).toEqual(line(3_000));
    // September had RM 130 and spent RM 150
    expect(monthBudgets('2025-10', on, spent)).toEqual(line(-2_000));

    const off = [...on, row('transport', '2025-10', 10_000, false)];
    expect(monthBudgets('2025-09', off, spent)).toEqual(line(3_000));
    expect(monthBudgets('2025-10', off, spent)).toEqual(line(-2_000, false));
    expect(monthBudgets('2025-11', off, spent)).toEqual(line(10_000, false));
  });

  test('a budget taken away is none from that month on, and nothing carries across the gap', () => {
    const rows = [
      row('food', '2025-08', 30_000),
      row('food', '2025-10', null),
      row('food', '2025-11', 20_000, true),
    ];
    const spent = spending({});
    expect(monthBudgets('2025-09', rows, spent)).toEqual([
      { categoryId: 'food', amountCents: 30_000, carryOver: false, lastMonthLeftCents: 30_000 },
    ]);
    expect(monthBudgets('2025-10', rows, spent)).toEqual([]);
    expect(monthBudgets('2025-11', rows, spent)).toEqual([
      { categoryId: 'food', amountCents: 20_000, carryOver: true, lastMonthLeftCents: 0 },
    ]);
  });

  test('lists categories in the order their rows come', () => {
    const rows = [row('fun', '2025-10', 8_000), row('food', '2025-10', 30_000)];
    expect(monthBudgets('2025-10', rows, spending({})).map((b) => b.categoryId)).toEqual([
      'fun',
      'food',
    ]);
  });

  test('stays exact over the longest chain at the largest budget', () => {
    const rows = [row('food', '2000-01', 1_000_000_000, true)];
    // 309 months, January 2000 to September 2025, nothing spent
    expect(monthBudgets('2025-10', rows, spending({}))).toEqual([
      {
        categoryId: 'food',
        amountCents: 1_000_000_000,
        carryOver: true,
        lastMonthLeftCents: 309_000_000_000,
      },
    ]);
  });
});

// How far through its period a month is, and how a budget is doing against it (R-Home,
// R-Plan, R-Desk-Plan): the today marker sits at the share of the period gone, day N of M,
// and a budget is "faster than the month" when more of it is spent than of the period is
// gone, without being over. A period is given by its first and last day, so one that
// isn't the calendar month (October 25 to November 24) works the same way.

// Days are calendar days, wherever the device is: the same answers in a zone ahead of UTC
// (the owner's) and in one with a daylight-saving change inside a month
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

  describe('periodDay', () => {
    test('is day N of M, counting the first and the last day', () => {
      // A third of November gone
      expect(periodDay('2026-11-01', '2026-11-30', '2026-11-10')).toEqual({ day: 10, days: 30 });
      expect(periodDay('2026-11-01', '2026-11-30', '2026-11-01')).toEqual({ day: 1, days: 30 });
      expect(periodDay('2026-11-01', '2026-11-30', '2026-11-30')).toEqual({ day: 30, days: 30 });
      // A leap February
      expect(periodDay('2028-02-01', '2028-02-29', '2028-02-29')).toEqual({ day: 29, days: 29 });
    });

    test('works for a period that is not the calendar month', () => {
      // October 25 to November 24: 7 days of October, then 10 of November
      expect(periodDay('2026-10-25', '2026-11-24', '2026-11-10')).toEqual({ day: 17, days: 31 });
      // Across a year's end
      expect(periodDay('2026-12-25', '2027-01-24', '2027-01-01')).toEqual({ day: 8, days: 31 });
    });

    test('is all of it once the period is over, and none of it before it starts', () => {
      expect(periodDay('2026-10-01', '2026-10-31', '2026-11-10')).toEqual({ day: 31, days: 31 });
      expect(periodDay('2026-12-01', '2026-12-31', '2026-11-10')).toEqual({ day: 0, days: 31 });
    });

    test('refuses a period that ends before it starts or runs past 31 days', () => {
      expect(() => periodDay('2026-11-30', '2026-11-01', '2026-11-10')).toThrow(RangeError);
      expect(() => periodDay('2026-11-01', '2026-12-02', '2026-11-10')).toThrow(RangeError);
    });
  });

  describe('periodDays', () => {
    test('lists every day of the period, first to last', () => {
      expect(periodDays('2026-10-29', '2026-11-02')).toEqual([
        '2026-10-29',
        '2026-10-30',
        '2026-10-31',
        '2026-11-01',
        '2026-11-02',
      ]);
      expect(periodDays('2026-02-01', '2026-02-28')).toHaveLength(28);
      expect(periodDays('2026-11-05', '2026-11-05')).toEqual(['2026-11-05']);
    });

    test('refuses a period that ends before it starts or runs past 31 days', () => {
      expect(() => periodDays('2026-11-02', '2026-11-01')).toThrow(RangeError);
      expect(() => periodDays('2026-01-01', '2026-02-01')).toThrow(RangeError);
    });
  });

  test('a month with a daylight-saving change is still whole days', () => {
    expect(periodDays('2026-03-01', '2026-03-31')).toHaveLength(31);
    expect(periodDays('2026-03-01', '2026-03-31')[7]).toBe('2026-03-08');
    expect(periodDay('2026-03-01', '2026-03-31', '2026-03-31')).toEqual({ day: 31, days: 31 });
    expect(periodDays('2026-10-31', '2026-11-02')).toEqual([
      '2026-10-31',
      '2026-11-01',
      '2026-11-02',
    ]);
  });

  test('refuses a day that is not one', () => {
    expect(() => periodDay('2026-02-01', '2026-02-30', '2026-02-10')).toThrow(RangeError);
    expect(() => periodDays('2026-02-01', 'February')).toThrow(RangeError);
  });
});

describe('budgetPace', () => {
  const tenOfThirty = { day: 10, days: 30 };

  test('is on track while no more of the budget is spent than of the month is gone', () => {
    expect(budgetPace(20_000, 80_000, tenOfThirty)).toBe('onTrack');
    // Exactly a third of a budget a third of the way in
    expect(budgetPace(10_000, 30_000, tenOfThirty)).toBe('onTrack');
    expect(budgetPace(0, 30_000, tenOfThirty)).toBe('onTrack');
  });

  test('is faster than the month a cent past the share of the month gone', () => {
    expect(budgetPace(10_001, 30_000, tenOfThirty)).toBe('faster');
    expect(budgetPace(24_000, 30_000, tenOfThirty)).toBe('faster');
    // All of it spent, but not over
    expect(budgetPace(30_000, 30_000, tenOfThirty)).toBe('faster');
  });

  test('is over once more is spent than is available, carried amounts included', () => {
    expect(budgetPace(30_001, 30_000, tenOfThirty)).toBe('over');
    // Last month overspent by more than this month's amount: over before anything is spent
    expect(budgetPace(0, -500, tenOfThirty)).toBe('over');
  });

  test('before the period starts, any spending is faster than the month', () => {
    expect(budgetPace(1, 30_000, { day: 0, days: 30 })).toBe('faster');
    expect(budgetPace(0, 30_000, { day: 0, days: 30 })).toBe('onTrack');
  });

  test('a budget of nothing with nothing spent is on track', () => {
    expect(budgetPace(0, 0, tenOfThirty)).toBe('onTrack');
  });

  test('in a finished period a budget is on track or over, never faster', () => {
    const allOf = { day: 30, days: 30 };
    expect(budgetPace(30_000, 30_000, allOf)).toBe('onTrack');
    expect(budgetPace(30_001, 30_000, allOf)).toBe('over');
  });

  test('compares whole cents exactly at the largest amounts', () => {
    // Available just under 2e12 cents (the largest budget with a long chain carried in):
    // 30 days in of 31, spent exactly 30/31 of it, then a cent more
    const available = 31 * 60_000_000_000;
    const at = { day: 30, days: 31 };
    expect(budgetPace(30 * 60_000_000_000, available, at)).toBe('onTrack');
    expect(budgetPace(30 * 60_000_000_000 + 1, available, at)).toBe('faster');
  });
});
