import { describe, expect, test } from 'vitest';
import type { Transaction } from '@shared/api';
import { againstMedian, biggestSpend, byDay, glanceDays, spentSoFar } from './glance';

// Home's glance on a phone, worked out: spent so far, the day against the median daily
// spend, the week's biggest expense and the last 7 days by day. Figures are made up.

let n = 0;
const t = (date: string, amountCents: number, more: Partial<Transaction> = {}): Transaction => ({
  id: String(++n),
  kind: 'expense',
  accountId: 'a',
  toAccountId: null,
  amountCents,
  categoryId: 'c',
  payee: null,
  note: null,
  date,
  createdAt: n,
  ...more,
});

describe('the glance', () => {
  test('its days: the week from its first day, and the last 7 days, across months', () => {
    expect(glanceDays('2026-12-01', '2026-12-01', 'monday')).toEqual({
      day: '2026-12-01',
      firstDay: '2026-12-01',
      weekFrom: '2026-11-30',
      recentFrom: '2026-11-25',
    });
    expect(glanceDays('2026-11-20', '2026-11-01', 'sunday').weekFrom).toBe('2026-11-15');
  });

  test('spent so far counts the month’s days to the day, never later or earlier ones', () => {
    const days = [
      { date: '2026-10-24', cents: 9_999 },
      { date: '2026-10-25', cents: 100 },
      { date: '2026-11-20', cents: 250 },
      { date: '2026-11-21', cents: 7_000 },
    ];
    expect(spentSoFar(days, '2026-10-25', '2026-11-20')).toBe(350);
  });

  test('a day against the median: above, below and on it, nothing spent as 0', () => {
    const days = [
      { date: '2026-11-01', cents: 500 },
      { date: '2026-11-03', cents: 900 },
    ];
    // 500, 0, 900: the median is 500
    expect(againstMedian(days, '2026-11-01', '2026-11-30', '2026-11-03')).toEqual({
      cents: 900,
      medianCents: 500,
      differenceCents: 400,
    });
    // On the 2nd, 500 and 0 make a median of 250, nothing spent 250 below it
    expect(againstMedian(days, '2026-11-01', '2026-11-30', '2026-11-02').differenceCents).toBe(
      -250,
    );
    // 0, 0, 0 and nothing today: at a median of nothing
    expect(againstMedian([], '2026-11-01', '2026-11-30', '2026-11-03')).toEqual({
      cents: 0,
      medianCents: 0,
      differenceCents: 0,
    });
  });

  test('the biggest spend is an expense in the days, the newer of two the same', () => {
    const newer = t('2026-11-19', 1_000, { payee: 'Newer' });
    const list = [
      t('2026-11-20', 50_000, { kind: 'transfer', categoryId: null, toAccountId: 'b' }),
      t('2026-11-20', 90_000, { kind: 'income' }),
      newer,
      t('2026-11-18', 1_000, { payee: 'Older' }),
      t('2026-11-15', 5_000),
    ];
    expect(biggestSpend(list, '2026-11-16', '2026-11-20')).toBe(newer);
    expect(biggestSpend(list.slice(0, 2), '2026-11-16', '2026-11-20')).toBeNull();
  });

  test('entries by day, newest day first, keeping each day’s order', () => {
    const [a, b, c] = [t('2026-11-20', 1), t('2026-11-20', 2), t('2026-11-18', 3)];
    expect(byDay([a, b, c, t('2026-11-13', 4)], '2026-11-14', '2026-11-20')).toEqual([
      { date: '2026-11-20', entries: [a, b] },
      { date: '2026-11-18', entries: [c] },
    ]);
  });
});
