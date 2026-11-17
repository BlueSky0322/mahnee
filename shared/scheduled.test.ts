import { describe, expect, test } from 'vitest';
import {
  MAX_POSTED_PER_ITEM,
  MAX_POSTED_PER_RUN,
  dayIn,
  dueThrough,
  monthlyCents,
} from './scheduled';

// Scheduled entries added on their day (owner decision D8, "Add on the day"): the nightly
// job adds each occurrence once the person's own day has reached it, in their stored time
// zone, catching up missed runs from the item's next due date, at most 31 occurrences of
// one item and 200 entries in all in one run. Scheduled's monthly totals count a weekly
// item as its occurrences in the person's month (design digest 4.5), so they stay exact
// in cents. Every clock here is a fixed instant; nothing reads the machine's own clock or
// zone.

const at = (iso: string) => Date.parse(iso);

describe('the day it is where the person is', () => {
  test.each([
    // Kuala Lumpur is eight hours ahead of UTC: its midnight is 16:00 UTC the day before
    ['Asia/Kuala_Lumpur', '2026-11-19T15:59:59Z', '2026-11-19'],
    ['Asia/Kuala_Lumpur', '2026-11-19T16:00:00Z', '2026-11-20'],
    // Kathmandu is five hours and 45 minutes ahead: its midnight falls at a quarter past
    ['Asia/Kathmandu', '2026-11-19T18:14:59Z', '2026-11-19'],
    ['Asia/Kathmandu', '2026-11-19T18:15:00Z', '2026-11-20'],
    ['UTC', '2026-11-19T23:59:59Z', '2026-11-19'],
    ['UTC', '2026-11-20T00:00:00Z', '2026-11-20'],
    // Los Angeles leaves summer time at 2 am on November 1, 2026 (09:00 UTC): before
    // that it is seven hours behind, after it eight
    ['America/Los_Angeles', '2026-11-01T06:59:59Z', '2026-10-31'],
    ['America/Los_Angeles', '2026-11-01T07:00:00Z', '2026-11-01'],
    ['America/Los_Angeles', '2026-11-02T07:59:59Z', '2026-11-01'],
    ['America/Los_Angeles', '2026-11-02T08:00:00Z', '2026-11-02'],
    // A year turns over in Kuala Lumpur before it does in UTC
    ['Asia/Kuala_Lumpur', '2026-12-31T16:00:00Z', '2027-01-01'],
  ])('in %s at %s it is %s', (zone, instant, day) => {
    expect(dayIn(zone, at(instant))).toBe(day);
  });

  test('a zone no one has is no day at all', () => {
    expect(dayIn('Mars/Olympus_Mons', at('2026-11-19T16:00:00Z'))).toBeNull();
  });
});

describe('the occurrences due by a day', () => {
  const monthly = (day: number, nextDue: string) => ({
    schedule: 'monthly' as const,
    day,
    nextDue,
  });
  const weekly = (day: number, nextDue: string) => ({ schedule: 'weekly' as const, day, nextDue });

  test('none before its next due date', () => {
    expect(dueThrough(monthly(20, '2026-11-20'), '2026-11-19', MAX_POSTED_PER_ITEM)).toEqual([]);
  });

  test('its next due date on that very day', () => {
    expect(dueThrough(monthly(20, '2026-11-20'), '2026-11-20', MAX_POSTED_PER_ITEM)).toEqual([
      '2026-11-20',
    ]);
  });

  test('every one missed, oldest first, on its own day', () => {
    // Mondays from November 2 to November 23
    expect(dueThrough(weekly(1, '2026-11-02'), '2026-11-25', MAX_POSTED_PER_ITEM)).toEqual([
      '2026-11-02',
      '2026-11-09',
      '2026-11-16',
      '2026-11-23',
    ]);
  });

  test('the 31st falls on a shorter month’s last day', () => {
    expect(dueThrough(monthly(31, '2026-10-31'), '2026-12-01', MAX_POSTED_PER_ITEM)).toEqual([
      '2026-10-31',
      '2026-11-30',
    ]);
  });

  test('at most as many as asked for, the oldest ones', () => {
    // Forty Mondays have passed since January 5, 2026 by October 5
    const due = dueThrough(weekly(1, '2026-01-05'), '2026-10-05', MAX_POSTED_PER_ITEM);
    expect(due).toHaveLength(31);
    expect(due[0]).toBe('2026-01-05');
    expect(due[30]).toBe('2026-08-03');
  });

  test('the limits are 31 for one item and 200 for a run', () => {
    expect(MAX_POSTED_PER_ITEM).toBe(31);
    expect(MAX_POSTED_PER_RUN).toBe(200);
  });
});

describe('what scheduled items come to in a month', () => {
  const item = (amountCents: number, schedule: 'monthly' | 'weekly', day: number) => ({
    amountCents,
    schedule,
    day,
  });
  const november = { firstDay: '2026-11-01', lastDay: '2026-11-30' };

  test('a monthly item counts once', () => {
    expect(monthlyCents([item(120_000, 'monthly', 1), item(5_490, 'monthly', 3)], november)).toBe(
      125_490,
    );
  });

  test('a weekly item counts as each time it falls in the month: five Mondays in November', () => {
    expect(monthlyCents([item(1_000, 'weekly', 1)], november)).toBe(5_000);
  });

  test('four Mondays in February', () => {
    expect(
      monthlyCents([item(1_000, 'weekly', 1)], { firstDay: '2026-02-01', lastDay: '2026-02-28' }),
    ).toBe(4_000);
  });

  test('a month from the 25th counts the Mondays from October 25 to November 24', () => {
    // October 26, November 2, 9, 16 and 23
    expect(
      monthlyCents([item(1_000, 'weekly', 1)], { firstDay: '2026-10-25', lastDay: '2026-11-24' }),
    ).toBe(5_000);
  });

  test('nothing scheduled comes to nothing', () => {
    expect(monthlyCents([], november)).toBe(0);
  });

  test('stays exact at the largest amounts: 200 weekly items of RM 10,000,000.00', () => {
    const items = Array.from({ length: 200 }, () => item(1_000_000_000, 'weekly', 1));
    expect(monthlyCents(items, november)).toBe(1_000_000_000_000);
  });
});
