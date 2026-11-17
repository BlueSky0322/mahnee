import { describe, expect, test } from 'vitest';
import type { LedgerChange, MonthSummary, MonthTotals, MonthTrend, Transaction } from '@shared/api';
import { addMonths } from '../utils/date-input';
import { applyToSummary, applyToTrend } from './summary';

/** The default Other spending category, which Tidy up counts with what's under it */
const OTHER = 'c000000000000008';

/** The calendar month's first and last day, as the server sums a month from the 1st */
const calendarDays = (month: string) => ({
  firstDay: `${month}-01`,
  lastDay: new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5)), 0))
    .toISOString()
    .slice(0, 10),
});

const empty = (month: string): MonthSummary => ({
  month,
  ...calendarDays(month),
  incomeCents: 0,
  spentCents: 0,
  leftCents: 0,
  spentByCategory: [],
  incomeByCategory: [],
  spentByDay: [],
  tidyUp: { from: `${addMonths(month, -1)}-01`, entries: 0, categoryIds: [OTHER] },
});

const coffee: Transaction = {
  id: 't1',
  kind: 'expense',
  accountId: 'wallet',
  toAccountId: null,
  amountCents: 300,
  categoryId: 'coffee',
  payee: null,
  note: null,
  date: '2026-10-14',
  createdAt: 1,
};

/**
 * October with the coffee in it, as the server summed it: two Food entries on the 3rd,
 * RM 50 of salary, and nothing in Other since September 1
 */
const october: MonthSummary = {
  month: '2026-10',
  firstDay: '2026-10-01',
  lastDay: '2026-10-31',
  incomeCents: 5_000,
  spentCents: 1_100,
  leftCents: 3_900,
  spentByCategory: [
    { categoryId: 'food', cents: 800, entries: 2 },
    { categoryId: 'coffee', cents: 300, entries: 1 },
  ],
  incomeByCategory: [{ categoryId: 'salary', cents: 5_000, entries: 1, payee: 'Acme' }],
  spentByDay: [
    { date: '2026-10-03', cents: 800 },
    { date: '2026-10-14', cents: 300 },
  ],
  tidyUp: { from: '2026-09-01', entries: 0, categoryIds: [OTHER, 'odd-jobs'] },
};

const saved = (id: string) => (id === coffee.id ? coffee : undefined);

describe('applyToSummary', () => {
  test('counts spending and income added in the month, largest first, and never a transfer', () => {
    const add = (t: Partial<Transaction>): LedgerChange => ({
      op: 'addTransaction',
      transaction: { ...coffee, ...t },
    });
    const after = applyToSummary(
      october,
      [
        add({ id: 'n1', amountCents: 900, categoryId: 'transport' }),
        add({ id: 'n2', amountCents: 200, categoryId: 'food' }),
        add({ id: 'n3', kind: 'income', amountCents: 1_000, categoryId: 'gift' }),
        add({ id: 'n4', kind: 'transfer', amountCents: 40_000, categoryId: null }),
        // Another month's
        add({ id: 'n5', amountCents: 700, date: '2026-11-01' }),
      ],
      () => undefined,
    );
    expect(after).toEqual({
      month: '2026-10',
      firstDay: '2026-10-01',
      lastDay: '2026-10-31',
      incomeCents: 6_000,
      spentCents: 2_200,
      leftCents: 3_800,
      spentByCategory: [
        { categoryId: 'food', cents: 1_000, entries: 3 },
        { categoryId: 'transport', cents: 900, entries: 1 },
        { categoryId: 'coffee', cents: 300, entries: 1 },
      ],
      incomeByCategory: [
        { categoryId: 'salary', cents: 5_000, entries: 1, payee: 'Acme' },
        { categoryId: 'gift', cents: 1_000, entries: 1 },
      ],
      // The coffee's day, with the two added on it
      spentByDay: [
        { date: '2026-10-03', cents: 800 },
        { date: '2026-10-14', cents: 1_400 },
      ],
      tidyUp: october.tidyUp,
    });
  });

  test('moves an edited one between categories and months, out of one total and into the other', () => {
    const toTea: LedgerChange = { op: 'updateTransaction', id: coffee.id, categoryId: 'tea' };
    const toNovember: LedgerChange = { op: 'updateTransaction', id: coffee.id, date: '2026-11-02' };

    const moved = applyToSummary(october, [toTea], saved);
    expect(moved.spentByCategory).toEqual([
      { categoryId: 'food', cents: 800, entries: 2 },
      { categoryId: 'tea', cents: 300, entries: 1 },
    ]);
    expect(moved.spentCents).toBe(1_100);

    const changes = [toTea, toNovember];
    expect(applyToSummary(october, changes, saved)).toMatchObject({
      spentCents: 800,
      leftCents: 4_200,
      spentByCategory: [{ categoryId: 'food', cents: 800 }],
    });
    expect(applyToSummary(empty('2026-11'), changes, saved)).toMatchObject({
      spentCents: 300,
      leftCents: -300,
      spentByCategory: [{ categoryId: 'tea', cents: 300 }],
    });
  });

  test('takes out one deleted or turned into income, and Undo puts it back', () => {
    const remove: LedgerChange = { op: 'removeTransaction', id: coffee.id };
    expect(applyToSummary(october, [remove], saved)).toMatchObject({
      spentCents: 800,
      spentByCategory: [{ categoryId: 'food', cents: 800 }],
    });
    expect(
      applyToSummary(october, [remove, { op: 'addTransaction', transaction: coffee }], saved),
    ).toEqual(october);
    expect(
      applyToSummary(
        october,
        [{ op: 'updateTransaction', id: coffee.id, kind: 'income', categoryId: 'salary' }],
        saved,
      ),
    ).toMatchObject({
      incomeCents: 5_300,
      spentCents: 800,
      leftCents: 4_500,
      incomeByCategory: [{ categoryId: 'salary', cents: 5_300 }],
    });
  });

  test('leaves the totals alone for one it does not know, and for one already saved being added', () => {
    const changes: LedgerChange[] = [
      { op: 'updateTransaction', id: 'unknown', amountCents: 1 },
      { op: 'removeTransaction', id: 'unknown' },
      { op: 'addTransaction', transaction: coffee },
    ];
    expect(applyToSummary(october, changes, saved)).toBe(october);
  });

  test('moves spending between days as entries are added, moved, edited and deleted', () => {
    const changes: LedgerChange[] = [
      { op: 'addTransaction', transaction: { ...coffee, id: 'n1', date: '2026-10-09' } },
      { op: 'addTransaction', transaction: { ...coffee, id: 'n2', date: '2026-10-03' } },
      // Income, a transfer and another month's spending are never a day's spending
      {
        op: 'addTransaction',
        transaction: { ...coffee, id: 'n3', kind: 'income', categoryId: 'salary' },
      },
      {
        op: 'addTransaction',
        transaction: { ...coffee, id: 'n4', kind: 'transfer', categoryId: null },
      },
      { op: 'addTransaction', transaction: { ...coffee, id: 'n5', date: '2026-11-01' } },
    ];
    expect(applyToSummary(october, changes, saved).spentByDay).toEqual([
      { date: '2026-10-03', cents: 1_100 },
      { date: '2026-10-09', cents: 300 },
      { date: '2026-10-14', cents: 300 },
    ]);
    // The coffee moved to the 20th, then made dearer: its old day is gone
    expect(
      applyToSummary(
        october,
        [
          { op: 'updateTransaction', id: coffee.id, date: '2026-10-20' },
          { op: 'updateTransaction', id: coffee.id, amountCents: 450 },
        ],
        saved,
      ).spentByDay,
    ).toEqual([
      { date: '2026-10-03', cents: 800 },
      { date: '2026-10-20', cents: 450 },
    ]);
    expect(
      applyToSummary(october, [{ op: 'removeTransaction', id: coffee.id }], saved).spentByDay,
    ).toEqual([{ date: '2026-10-03', cents: 800 }]);
  });

  test("counts each category's entries, and names a lone entry's payee only while it's alone", () => {
    const add = (t: Partial<Transaction>): LedgerChange => ({
      op: 'addTransaction',
      transaction: { ...coffee, ...t },
    });
    // A first entry in a category brings its payee; a second leaves none named
    const first = applyToSummary(
      october,
      [add({ id: 'n1', categoryId: 'tea', payee: 'Tea Garden' })],
      saved,
    );
    expect(first.spentByCategory).toContainEqual({
      categoryId: 'tea',
      cents: 300,
      entries: 1,
      payee: 'Tea Garden',
    });
    const second = applyToSummary(
      october,
      [
        add({ id: 'n1', categoryId: 'tea', payee: 'Tea Garden' }),
        add({ id: 'n2', categoryId: 'tea', payee: 'Tea Garden' }),
      ],
      saved,
    );
    expect(second.spentByCategory).toContainEqual({ categoryId: 'tea', cents: 600, entries: 2 });
    // The lone coffee given a payee names it
    expect(
      applyToSummary(october, [{ op: 'updateTransaction', id: coffee.id, payee: 'Kopi' }], saved)
        .spentByCategory,
    ).toContainEqual({ categoryId: 'coffee', cents: 300, entries: 1, payee: 'Kopi' });
    // One of two Food entries moved out: which one is left isn't known here, so no payee
    // is named until the totals are fetched again
    const foodEntry: Transaction = { ...coffee, id: 'f1', categoryId: 'food', amountCents: 500 };
    const known = (id: string) => (id === foodEntry.id ? foodEntry : saved(id));
    expect(
      applyToSummary(
        october,
        [{ op: 'updateTransaction', id: foodEntry.id, categoryId: 'tea' }],
        known,
      ).spentByCategory,
    ).toEqual([
      { categoryId: 'tea', cents: 500, entries: 1 },
      { categoryId: 'coffee', cents: 300, entries: 1 },
      { categoryId: 'food', cents: 300, entries: 1 },
    ]);
    // Deleting the salary takes its row away, payee and all
    const salary: Transaction = {
      ...coffee,
      id: 's1',
      kind: 'income',
      categoryId: 'salary',
      amountCents: 5_000,
      payee: 'Acme',
    };
    expect(
      applyToSummary(october, [{ op: 'removeTransaction', id: salary.id }], (id) =>
        id === salary.id ? salary : undefined,
      ).incomeByCategory,
    ).toEqual([]);
  });

  test('counts spending in Other or under it since the first of the month before, for Tidy up', () => {
    const add = (t: Partial<Transaction>): LedgerChange => ({
      op: 'addTransaction',
      transaction: { ...coffee, ...t },
    });
    const after = applyToSummary(
      october,
      [
        add({ id: 'n1', categoryId: OTHER, date: '2026-10-20' }),
        add({ id: 'n2', categoryId: 'odd-jobs', date: '2026-09-01' }),
        add({ id: 'n3', categoryId: OTHER, date: '2026-10-31' }),
        // Before the first of the month before, after the month, in another category, or
        // not spending: none of these count
        add({ id: 'n4', categoryId: OTHER, date: '2026-08-31' }),
        add({ id: 'n5', categoryId: OTHER, date: '2026-11-01' }),
        add({ id: 'n6', categoryId: 'food', date: '2026-10-05' }),
        add({ id: 'n7', kind: 'income', categoryId: OTHER, date: '2026-10-05' }),
      ],
      saved,
    );
    expect(after.tidyUp).toEqual({
      from: '2026-09-01',
      entries: 3,
      categoryIds: [OTHER, 'odd-jobs'],
    });
    // The September one counts for Tidy up but not in October's spending
    expect(after.spentCents).toBe(2_000);

    // Sorted out of Other (moved to Food), the coffee filed in Other no longer counts
    const inOther: Transaction = { ...coffee, categoryId: OTHER };
    const sorted = applyToSummary(
      { ...october, tidyUp: { ...october.tidyUp, entries: 1 } },
      [{ op: 'recategoriseTransactions', ids: [inOther.id], categoryId: 'food' }],
      (id) => (id === inOther.id ? inOther : undefined),
    );
    expect(sorted.tidyUp.entries).toBe(0);
  });
});

describe('applyToTrend', () => {
  const totals = (month: string, more: Partial<MonthTotals> = {}): MonthTotals => ({
    month,
    ...calendarDays(month),
    incomeCents: 0,
    spentCents: 0,
    leftCents: 0,
    spentByCategory: [],
    incomeByCategory: [],
    ...more,
  });
  const trend: MonthTrend = {
    month: '2026-10',
    months: [
      totals('2026-09'),
      totals('2026-10', {
        spentCents: 300,
        leftCents: -300,
        spentByCategory: [{ categoryId: 'coffee', cents: 300, entries: 1, payee: 'Kopi' }],
      }),
    ],
  };

  test("counts a change in the month it falls in, entries and a lone payee as a month's totals do", () => {
    const after = applyToTrend(
      trend,
      [{ op: 'addTransaction', transaction: { ...coffee, id: 'n1', payee: 'Tea Garden' } }],
      () => undefined,
    );
    // September has nothing in it, and is the same month as before
    expect(after.months[0]).toBe(trend.months[0]);
    expect(after.months[1]).toEqual(
      totals('2026-10', {
        spentCents: 600,
        leftCents: -600,
        spentByCategory: [{ categoryId: 'coffee', cents: 600, entries: 2 }],
      }),
    );
    // A month of the 12 never gains the month's own days or Tidy up
    for (const month of after.months) {
      expect('spentByDay' in month).toBe(false);
      expect('tidyUp' in month).toBe(false);
    }
  });

  test('is left as it was when nothing falls in the 12 months', () => {
    expect(
      applyToTrend(
        trend,
        [{ op: 'addTransaction', transaction: { ...coffee, id: 'n1', date: '2026-12-01' } }],
        () => undefined,
      ),
    ).toBe(trend);
  });
});
