import { describe, expect, test } from 'vitest';
import type { Transaction } from '@shared/api';
import { newestFirst } from './apply';

// The order lists are drawn in, as the server lists them (owner decision D20): by day, then
// by the time of day an entry carries (latest first, those with none after), then when it
// was saved, then by id.

const entry = (id: string, date: string, createdAt: number, time?: string | null): Transaction => ({
  id: id.repeat(16),
  kind: 'expense',
  accountId: 'a'.repeat(16),
  toAccountId: null,
  amountCents: 100,
  categoryId: 'f'.repeat(16),
  payee: null,
  note: null,
  date,
  createdAt,
  ...(time === undefined ? {} : { time }),
});

const order = (list: Transaction[]) => [...list].sort(newestFirst).map((t) => t.id[0]);

describe('newest first', () => {
  test('within a day, by time, latest first, whenever each was saved', () => {
    expect(
      order([
        entry('1', '2026-11-10', 1, '07:05'),
        entry('2', '2026-11-10', 2, '20:12'),
        entry('3', '2026-11-10', 3, '12:30'),
      ]),
    ).toEqual(['2', '3', '1']);
  });

  test('at the same time, the one saved later first, then by id', () => {
    expect(
      order([
        entry('1', '2026-11-10', 1, '09:00'),
        entry('2', '2026-11-10', 2, '09:00'),
        entry('3', '2026-11-10', 2, '09:00'),
      ]),
    ).toEqual(['3', '2', '1']);
  });

  test('those with no time come after those with one, newest saved first', () => {
    expect(
      order([
        entry('1', '2026-11-10', 5),
        entry('2', '2026-11-10', 1, '07:05'),
        entry('3', '2026-11-10', 6, null),
      ]),
    ).toEqual(['2', '3', '1']);
  });

  test('the day still comes first: a late time the day before is after an early one today', () => {
    expect(
      order([entry('1', '2026-11-09', 9, '23:59'), entry('2', '2026-11-10', 1, '00:01')]),
    ).toEqual(['2', '1']);
  });

  test('with no times at all, as before: when saved, then id', () => {
    expect(
      order([
        entry('1', '2026-11-10', 1),
        entry('3', '2026-11-10', 2),
        entry('2', '2026-11-10', 2),
      ]),
    ).toEqual(['3', '2', '1']);
  });
});
