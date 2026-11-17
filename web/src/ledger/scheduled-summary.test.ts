import { describe, expect, test } from 'vitest';
import type { LedgerChange, MonthSummary, Transaction } from '@shared/api';
import { applyToSummary } from './summary';

// A month's entries from Scheduled (owner decision D8), counted on top of the server's sum
// as changes are made, as Home's "Added this month" and amounts to check and Plan's "N added
// this month" read them: each item's entries in the month and the day of its first, in that
// order, and those still to check. An entry confirmed (or given a new amount) leaves the ones to
// check; one deleted leaves both; one brought back (Undo) or logged returns.

const RENT = 'r'.repeat(16);
const WATER = 'w'.repeat(16);
const GYM = 'g'.repeat(16);

const water: Transaction = {
  id: 't1',
  kind: 'expense',
  accountId: 'bank',
  toAccountId: null,
  amountCents: 3_015,
  categoryId: 'bills',
  payee: 'Water',
  note: null,
  date: '2026-11-05',
  createdAt: 1,
  scheduled: { recurringId: WATER, due: '2026-11-05', toCheck: true },
};

/** November as the server summed it: Rent on the 1st and Water on the 5th, to check */
const november: MonthSummary = {
  month: '2026-11',
  firstDay: '2026-11-01',
  lastDay: '2026-11-30',
  incomeCents: 0,
  spentCents: 138_015,
  leftCents: -138_015,
  spentByCategory: [{ categoryId: 'bills', cents: 138_015, entries: 2 }],
  incomeByCategory: [],
  spentByDay: [
    { date: '2026-11-01', cents: 135_000 },
    { date: '2026-11-05', cents: 3_015 },
  ],
  tidyUp: { from: '2026-10-01', entries: 0, categoryIds: [] },
  fromScheduled: [
    { recurringId: RENT, entries: 1, firstDate: '2026-11-01', toCheck: [] },
    {
      recurringId: WATER,
      entries: 1,
      firstDate: '2026-11-05',
      toCheck: [{ id: water.id, date: '2026-11-05', amountCents: 3_015 }],
    },
  ],
};

const saved = (id: string) => (id === water.id ? water : undefined);

describe('entries from Scheduled in a month', () => {
  test('confirming one leaves it added, with nothing left to check', () => {
    const changes: LedgerChange[] = [{ op: 'updateTransaction', id: water.id, toCheck: false }];
    expect(applyToSummary(november, changes, saved).fromScheduled).toEqual([
      { recurringId: RENT, entries: 1, firstDate: '2026-11-01', toCheck: [] },
      { recurringId: WATER, entries: 1, firstDate: '2026-11-05', toCheck: [] },
    ]);
  });

  test('a new amount confirms it too', () => {
    const changes: LedgerChange[] = [{ op: 'updateTransaction', id: water.id, amountCents: 3_170 }];
    expect(applyToSummary(november, changes, saved).fromScheduled?.[1]).toEqual({
      recurringId: WATER,
      entries: 1,
      firstDate: '2026-11-05',
      toCheck: [],
    });
  });

  test('deleting one takes it out, and the item with it when it was its only one', () => {
    const changes: LedgerChange[] = [{ op: 'removeTransaction', id: water.id }];
    expect(applyToSummary(november, changes, saved).fromScheduled).toEqual([
      { recurringId: RENT, entries: 1, firstDate: '2026-11-01', toCheck: [] },
    ]);
  });

  test('Undo brings it back, still to check', () => {
    const { createdAt: _createdAt, ...back } = water;
    const changes: LedgerChange[] = [
      { op: 'removeTransaction', id: water.id },
      { op: 'addTransaction', transaction: back },
    ];
    expect(applyToSummary(november, changes, saved).fromScheduled).toEqual(november.fromScheduled);
  });

  test('a log adds the item, in the order of its first entry, with nothing to check', () => {
    const changes: LedgerChange[] = [
      {
        op: 'logRecurring',
        id: GYM,
        due: '2026-11-02',
        transaction: {
          id: 't9',
          kind: 'expense',
          accountId: 'bank',
          toAccountId: null,
          amountCents: 1_500,
          categoryId: 'health',
          payee: 'Gym',
          note: null,
          date: '2026-11-02',
          scheduled: { recurringId: GYM, due: '2026-11-02', toCheck: false },
        },
      },
    ];
    expect(
      applyToSummary(november, changes, saved).fromScheduled?.map((s) => s.recurringId),
    ).toEqual([RENT, GYM, WATER]);
  });

  test('an entry of another month counts nowhere here', () => {
    const changes: LedgerChange[] = [
      {
        op: 'addTransaction',
        transaction: {
          ...water,
          id: 't8',
          date: '2026-10-05',
          scheduled: { recurringId: WATER, due: '2026-10-05', toCheck: true },
        },
      },
    ];
    expect(applyToSummary(november, changes, saved).fromScheduled).toEqual(november.fromScheduled);
  });
});

describe("entries from Scheduled in a person's month from the 25th", () => {
  const fromThe25th: MonthSummary = {
    ...november,
    firstDay: '2026-10-25',
    lastDay: '2026-11-24',
    fromScheduled: [],
  };
  const gym = (id: string, date: string): LedgerChange => ({
    op: 'addTransaction',
    transaction: {
      ...water,
      id,
      payee: 'Gym',
      date,
      scheduled: { recurringId: GYM, due: date, toCheck: false },
    },
  });

  test('one on October 26 counts; one on November 25 counts nowhere here', () => {
    expect(
      applyToSummary(fromThe25th, [gym('t5', '2026-10-26'), gym('t6', '2026-11-25')], saved)
        .fromScheduled,
    ).toEqual([{ recurringId: GYM, entries: 1, firstDate: '2026-10-26', toCheck: [] }]);
  });
});
