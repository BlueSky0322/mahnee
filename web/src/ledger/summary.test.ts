import { describe, expect, test } from 'vitest';
import type { LedgerChange, MonthSummary, Transaction } from '@shared/api';
import { applyToSummary } from './summary';

const empty = (month: string): MonthSummary => ({
  month,
  incomeCents: 0,
  spentCents: 0,
  leftCents: 0,
  spentByCategory: [],
  incomeByCategory: [],
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

/** October with the coffee in it, as the server summed it, and RM 50 of salary */
const october: MonthSummary = {
  month: '2026-10',
  incomeCents: 5_000,
  spentCents: 1_100,
  leftCents: 3_900,
  spentByCategory: [
    { categoryId: 'food', cents: 800 },
    { categoryId: 'coffee', cents: 300 },
  ],
  incomeByCategory: [{ categoryId: 'salary', cents: 5_000 }],
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
      incomeCents: 6_000,
      spentCents: 2_200,
      leftCents: 3_800,
      spentByCategory: [
        { categoryId: 'food', cents: 1_000 },
        { categoryId: 'transport', cents: 900 },
        { categoryId: 'coffee', cents: 300 },
      ],
      incomeByCategory: [
        { categoryId: 'salary', cents: 5_000 },
        { categoryId: 'gift', cents: 1_000 },
      ],
    });
  });

  test('moves an edited one between categories and months, out of one total and into the other', () => {
    const toTea: LedgerChange = { op: 'updateTransaction', id: coffee.id, categoryId: 'tea' };
    const toNovember: LedgerChange = { op: 'updateTransaction', id: coffee.id, date: '2026-11-02' };

    const moved = applyToSummary(october, [toTea], saved);
    expect(moved.spentByCategory).toEqual([
      { categoryId: 'food', cents: 800 },
      { categoryId: 'tea', cents: 300 },
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
});
