import { describe, expect, test } from 'vitest';
import type { BudgetRow } from './budgets';
import { budgetFigures, monthBudgets } from './budgets';

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
