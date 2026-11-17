import { describe, expect, test } from 'vitest';
import type { LedgerChange, MonthSummary, MonthTotals, MonthTrend, Transaction } from '@shared/api';
import { applyToSummary, applyToTrend } from './summary';

// Changes not yet saved count in a month's totals by the days the server summed them for
// (MonthSummary firstDay to lastDay), so with a month start day (D7) an entry on October
// 26 counts in "November" (October 25 to November 24), and one on November 25 doesn't.

const OTHER = 'c000000000000008';

/** November from the 25th, as the server summed it: nothing in it yet */
const november: MonthSummary = {
  month: '2026-11',
  firstDay: '2026-10-25',
  lastDay: '2026-11-24',
  incomeCents: 0,
  spentCents: 0,
  leftCents: 0,
  spentByCategory: [],
  incomeByCategory: [],
  spentByDay: [],
  tidyUp: { from: '2026-09-25', entries: 0, categoryIds: [OTHER] },
};

let made = 0;
const add = (date: string, more: Partial<Transaction> = {}): LedgerChange => ({
  op: 'addTransaction',
  transaction: {
    id: `t${++made}`,
    kind: 'expense',
    accountId: 'wallet',
    toAccountId: null,
    amountCents: 100,
    categoryId: 'food',
    payee: null,
    note: null,
    date,
    createdAt: made,
    ...more,
  },
});

describe('applyToSummary, with the month starting on the 25th', () => {
  test('counts what falls from the first day to the last, and nothing either side', () => {
    const after = applyToSummary(
      november,
      [
        add('2026-10-24', { amountCents: 1 }),
        add('2026-10-25', { amountCents: 200 }),
        add('2026-11-24', { amountCents: 400 }),
        add('2026-11-25', { amountCents: 800 }),
        add('2026-11-30', { amountCents: 1_600 }),
      ],
      () => undefined,
    );
    expect(after.spentCents).toBe(600);
    expect(after.spentByCategory).toEqual([{ categoryId: 'food', cents: 600, entries: 2 }]);
    expect(after.spentByDay).toEqual([
      { date: '2026-10-25', cents: 200 },
      { date: '2026-11-24', cents: 400 },
    ]);
  });

  test("counts Tidy up from the period before's first day to this one's last", () => {
    const after = applyToSummary(
      november,
      [
        add('2026-09-24', { categoryId: OTHER }),
        add('2026-09-25', { categoryId: OTHER }),
        add('2026-11-24', { categoryId: OTHER }),
        add('2026-11-25', { categoryId: OTHER }),
      ],
      () => undefined,
    );
    expect(after.tidyUp.entries).toBe(2);
  });

  test('an entry moved from November 24 to the 25th leaves the month', () => {
    const was: Transaction = {
      id: 'kept',
      kind: 'expense',
      accountId: 'wallet',
      toAccountId: null,
      amountCents: 400,
      categoryId: 'food',
      payee: null,
      note: null,
      date: '2026-11-24',
      createdAt: 1,
    };
    const counted: MonthSummary = {
      ...november,
      spentCents: 400,
      leftCents: -400,
      spentByCategory: [{ categoryId: 'food', cents: 400, entries: 1 }],
      spentByDay: [{ date: '2026-11-24', cents: 400 }],
    };
    const after = applyToSummary(
      counted,
      [{ op: 'updateTransaction', id: 'kept', date: '2026-11-25' }],
      (id) => (id === 'kept' ? was : undefined),
    );
    expect(after).toMatchObject({ spentCents: 0, spentByCategory: [], spentByDay: [] });
  });
});

describe('applyToTrend, with the month starting on the 25th', () => {
  const month = (m: string, firstDay: string, lastDay: string): MonthTotals => ({
    month: m,
    firstDay,
    lastDay,
    incomeCents: 0,
    spentCents: 0,
    leftCents: 0,
    spentByCategory: [],
    incomeByCategory: [],
  });

  test('counts each change in the period its day is in', () => {
    const trend: MonthTrend = {
      month: '2026-11',
      months: [
        month('2026-10', '2026-09-25', '2026-10-24'),
        month('2026-11', '2026-10-25', '2026-11-24'),
      ],
    };
    const after = applyToTrend(
      trend,
      [add('2026-10-24', { amountCents: 300 }), add('2026-10-26', { amountCents: 500 })],
      () => undefined,
    );
    expect(after.months.map((m) => m.spentCents)).toEqual([300, 500]);
  });
});
