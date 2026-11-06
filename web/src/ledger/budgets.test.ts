import { describe, expect, test } from 'vitest';
import type { Category, LedgerChange, MonthSummary, Transaction } from '@shared/api';
import { budgetLines } from './budgets';
import { applyToSummary } from './summary';

// A month's budgets as Home shows them (B1, B2): each budgeted top-level spending category
// with what was set for the month, what carried over from the month before, and what's
// left once its spending (its subcategories' included) is taken away. Setting a budget
// shows at once, offline too, and setting it again comes out the same.

const category = (id: string, name: string, more: Partial<Category> = {}): Category => ({
  id,
  name,
  kind: 'expense',
  parentId: null,
  position: 0,
  archived: false,
  ...more,
});

const CATEGORIES: Category[] = [
  category('food', 'Food', { position: 0 }),
  category('transport', 'Transport', { position: 1 }),
  category('fun', 'Fun', { position: 2 }),
  category('coffee', 'Coffee', { parentId: 'food' }),
  category('salary', 'Salary', { kind: 'income' }),
];

/**
 * November: RM 150 on Food and RM 30 on Coffee (under Food), RM 50 on Transport, RM 2,000
 * of salary
 */
const november = (budgets?: MonthSummary['budgets']): MonthSummary => ({
  month: '2026-11',
  incomeCents: 200_000,
  spentCents: 23_000,
  leftCents: 177_000,
  spentByCategory: [
    { categoryId: 'food', cents: 15_000 },
    { categoryId: 'transport', cents: 5_000 },
    { categoryId: 'coffee', cents: 3_000 },
  ],
  incomeByCategory: [{ categoryId: 'salary', cents: 200_000 }],
  ...(budgets != null && { budgets }),
});

const food = { categoryId: 'food', amountCents: 30_000, carryOver: false, lastMonthLeftCents: 0 };

describe('budgetLines', () => {
  test('a budget less what was spent in it, subcategories included: RM 120 left of RM 300', () => {
    expect(budgetLines(november([food]), CATEGORIES)).toEqual([
      {
        id: 'food',
        name: 'Food',
        amountCents: 30_000,
        carriedCents: 0,
        availableCents: 30_000,
        spentCents: 18_000,
        leftCents: 12_000,
      },
    ]);
  });

  test('spending past the budget leaves less than nothing: RM 40 over', () => {
    const [line] = budgetLines(
      november([{ ...food, categoryId: 'transport', amountCents: 1_000 }]),
      CATEGORIES,
    );
    expect(line).toMatchObject({ name: 'Transport', spentCents: 5_000, leftCents: -4_000 });
  });

  test('a category with nothing spent yet has all of its budget left', () => {
    const [line] = budgetLines(
      november([{ ...food, categoryId: 'fun', amountCents: 10_000 }]),
      CATEGORIES,
    );
    expect(line).toMatchObject({ name: 'Fun', spentCents: 0, leftCents: 10_000 });
  });

  test("with Carry over on, last month's leftover is added, and overspending taken away", () => {
    const [kept] = budgetLines(
      november([{ ...food, carryOver: true, lastMonthLeftCents: 3_000 }]),
      CATEGORIES,
    );
    expect(kept).toMatchObject({
      amountCents: 30_000,
      carriedCents: 3_000,
      availableCents: 33_000,
      leftCents: 15_000,
    });
    const [overspent] = budgetLines(
      november([{ ...food, carryOver: true, lastMonthLeftCents: -2_000 }]),
      CATEGORIES,
    );
    expect(overspent).toMatchObject({
      carriedCents: -2_000,
      availableCents: 28_000,
      leftCents: 10_000,
    });
  });

  test("with Carry over off (as it starts), last month's leftover is not added", () => {
    const [line] = budgetLines(november([{ ...food, lastMonthLeftCents: 3_000 }]), CATEGORIES);
    expect(line).toMatchObject({ carriedCents: 0, availableCents: 30_000, leftCents: 12_000 });
  });

  test('lists budgets in the order the categories are, and none for a month without', () => {
    const lines = budgetLines(
      november([
        { ...food, categoryId: 'fun', amountCents: 10_000 },
        food,
        { ...food, categoryId: 'transport', amountCents: 6_000 },
      ]),
      CATEGORIES,
    );
    expect(lines.map((l) => l.name)).toEqual(['Food', 'Transport', 'Fun']);
    expect(budgetLines(november(), CATEGORIES)).toEqual([]);
  });

  test('shows no budget on an archived category, one moved under another, or one not known', () => {
    const categories = [
      category('food', 'Food'),
      category('fun', 'Fun', { archived: true }),
      category('transport', 'Transport', { parentId: 'food' }),
      category('coffee', 'Coffee', { parentId: 'food' }),
    ];
    const lines = budgetLines(
      november([
        food,
        { ...food, categoryId: 'fun' },
        { ...food, categoryId: 'transport' },
        { ...food, categoryId: 'gone' },
      ]),
      categories,
    );
    // Transport now counts toward Food, as Coffee does: RM 150 + RM 50 + RM 30
    expect(lines).toEqual([expect.objectContaining({ id: 'food', spentCents: 23_000 })]);
  });

  test('spending exactly the budget leaves RM 0.00, not over', () => {
    const [line] = budgetLines(november([{ ...food, amountCents: 18_000 }]), CATEGORIES);
    expect(line).toMatchObject({ availableCents: 18_000, spentCents: 18_000, leftCents: 0 });
  });

  test('overspent last month and over again this month: both taken away', () => {
    const [line] = budgetLines(
      november([{ ...food, amountCents: 15_000, carryOver: true, lastMonthLeftCents: -2_000 }]),
      CATEGORIES,
    );
    expect(line).toMatchObject({
      carriedCents: -2_000,
      availableCents: 13_000,
      spentCents: 18_000,
      leftCents: -5_000,
    });
  });
});

describe('setting a budget before the server has it', () => {
  const set = (more: Partial<Extract<LedgerChange, { op: 'setBudget' }>> = {}): LedgerChange => ({
    op: 'setBudget',
    categoryId: 'food',
    fromMonth: '2026-11',
    amountCents: 30_000,
    carryOver: false,
    ...more,
  });
  const none = () => undefined;

  test('shows a new budget for the month at once', () => {
    const after = applyToSummary(november(), [set()], none);
    expect(after.budgets).toEqual([food]);
    expect(budgetLines(after, CATEGORIES)[0]).toMatchObject({ leftCents: 12_000 });
    // The totals themselves are as they were
    expect({ ...after, budgets: undefined }).toEqual({ ...november(), budgets: undefined });
  });

  test('changes the amount and Carry over, keeping what last month left', () => {
    const before = november([{ ...food, lastMonthLeftCents: 3_000 }]);
    const after = applyToSummary(before, [set({ amountCents: 40_000, carryOver: true })], none);
    expect(after.budgets).toEqual([
      { categoryId: 'food', amountCents: 40_000, carryOver: true, lastMonthLeftCents: 3_000 },
    ]);
    expect(budgetLines(after, CATEGORIES)[0]).toMatchObject({
      carriedCents: 3_000,
      availableCents: 43_000,
      leftCents: 25_000,
    });
  });

  test('takes a budget away with no amount', () => {
    const after = applyToSummary(november([food]), [set({ amountCents: null })], none);
    expect(budgetLines(after, CATEGORIES)).toEqual([]);
  });

  test('applies from the month it was set in onward, never to the months before', () => {
    const october = { ...november([food]), month: '2026-10' };
    expect(applyToSummary(october, [set({ amountCents: 50_000 })], none).budgets).toEqual([food]);
    // Set from an earlier month, it applies to this one too
    const after = applyToSummary(
      november([food]),
      [set({ fromMonth: '2026-09', amountCents: 50_000 })],
      none,
    );
    expect(after.budgets).toEqual([{ ...food, amountCents: 50_000 }]);
  });

  test('comes out the same set twice, or on a copy that has it already', () => {
    const once = applyToSummary(november(), [set()], none);
    expect(applyToSummary(november(), [set(), set()], none)).toEqual(once);
    expect(applyToSummary(once, [set()], none)).toEqual(once);
  });

  test("moves what's left as spending in the month is added, once", () => {
    const spend: Transaction = {
      id: 't9',
      kind: 'expense',
      accountId: 'wallet',
      toAccountId: null,
      amountCents: 800,
      categoryId: 'coffee',
      payee: null,
      note: null,
      date: '2026-11-20',
      createdAt: 9,
    };
    const added: LedgerChange = { op: 'addTransaction', transaction: spend };
    const after = applyToSummary(november([food]), [added], none);
    expect(budgetLines(after, CATEGORIES)[0]).toMatchObject({ leftCents: 11_200 });
    // A copy that holds it already (the server's, with it saved) doesn't take it twice
    const held = applyToSummary(november([food]), [added], (id) =>
      id === spend.id ? spend : undefined,
    );
    expect(budgetLines(held, CATEGORIES)[0]).toMatchObject({ leftCents: 12_000 });
  });
});
