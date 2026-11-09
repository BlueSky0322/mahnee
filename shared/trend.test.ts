import { describe, expect, test } from 'vitest';
import { againstAverage, averageCents, trendMonths } from './trend';

// The rule for a category's last 12 months (O1), which the Worker reads by and the app
// shows: the month and the 11 before it, the average over those 11 in whole cents rounded
// half up, and the month against that average as shown.

describe('the 12 months', () => {
  test('end at the month, oldest first, across the turn of a year', () => {
    expect(trendMonths('2026-11')).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(trendMonths('2026-12')[0]).toBe('2026-01');
    expect(trendMonths('2000-01').slice(0, 2)).toEqual(['1999-02', '1999-03']);
  });
});

describe('the average', () => {
  test('is in whole cents, rounded half up', () => {
    expect(averageCents([1, 2])).toBe(2);
    // A tie goes up, never to the even cent
    expect(averageCents([2, 3])).toBe(3);
    expect(averageCents([1, 1, 2])).toBe(1);
    expect(averageCents([1, 2, 2])).toBe(2);
    expect(averageCents([0, 0, 0])).toBe(0);
  });

  test('stays exact for the largest total a person can have', () => {
    // Every transaction a person can have, in one month: 5e15 cents less a little
    const months = [4_999_999_999_999_995, ...Array.from({ length: 10 }, () => 0)];
    expect(averageCents(months)).toBe(454_545_454_545_454);
  });
});

describe('a month against the average of the 11 before', () => {
  const before = (cents: number[]) => [
    ...cents,
    ...Array.from({ length: 11 - cents.length }, () => 0),
  ];

  test('is above or below by the difference from the average as shown', () => {
    // RM 45.40 over 11 months is RM 4.1272...: RM 4.13 as shown, and RM 11 is RM 6.87 above it
    expect(againstAverage([...before([1_540, 1_000, 2_000]), 1_100])).toEqual({
      averageCents: 413,
      byCents: 687,
      direction: 'above',
    });
    expect(againstAverage([...before([12_440]), 0])).toEqual({
      averageCents: 1_131,
      byCents: 1_131,
      direction: 'below',
    });
  });

  test('is the same when it matches the average as shown', () => {
    expect(againstAverage(Array.from({ length: 12 }, () => 1_000))).toEqual({
      averageCents: 1_000,
      byCents: 0,
      direction: 'same',
    });
    // RM 0.10 over 11 months is RM 0.0090..., RM 0.01 as shown, the month's RM 0.01 with it
    expect(againstAverage([...before([10]), 1])).toEqual({
      averageCents: 1,
      byCents: 0,
      direction: 'same',
    });
    expect(againstAverage(Array.from({ length: 12 }, () => 0))).toEqual({
      averageCents: 0,
      byCents: 0,
      direction: 'same',
    });
  });
});
