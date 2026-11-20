import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { dayByDay } from './day-by-day';

// Home's "Day by day" calendar (R-Home, R-Desk-Home; design digest 4.1): each day of the
// period with what was spent on it, against the median daily spend so far. That is the
// median of each day's spending from the period's first day to today, a day with nothing
// spent counting as 0; with an even count it's the mean of the two middle days, in whole
// cents rounded half up. A day so far above it is "more", below it "less", on it "same"; a day
// still to come is neither.

/** Spending on the given days of November 2026 */
const november = (byDay: Record<number, number>) =>
  Object.entries(byDay).map(([day, cents]) => ({
    date: `2026-11-${day.padStart(2, '0')}`,
    cents,
  }));

// Days are calendar days wherever the device is: the same in a zone ahead of UTC (the
// owner's) and in one with a daylight-saving change inside a month
describe.each([
  ['Asia/Kuala_Lumpur', -480],
  ['America/New_York', 300],
])('dayByDay in %s', (zone, januaryOffset) => {
  beforeAll(() => {
    vi.stubEnv('TZ', zone);
  });
  afterAll(() => {
    vi.unstubAllEnvs();
  });

  test('the zone is in effect', () => {
    expect(new Date(2026, 0, 1).getTimezoneOffset()).toBe(januaryOffset);
  });

  test('a month with a daylight-saving change lists each day once', () => {
    const shown = dayByDay(
      [{ date: '2026-03-08', cents: 500 }],
      '2026-03-01',
      '2026-03-31',
      '2026-03-09',
    );
    expect(shown.days.map((d) => d.date)).toEqual(
      Array.from({ length: 31 }, (_, i) => `2026-03-${String(i + 1).padStart(2, '0')}`),
    );
    expect(shown.days[7]).toEqual({ date: '2026-03-08', cents: 500, against: 'more' });
  });

  test('the middle day is the median of the days so far, days with nothing counting as 0', () => {
    // Day 2 has nothing: 0, 300, 500, 900, 1,200 makes 500 the middle
    const shown = dayByDay(
      november({ 1: 500, 3: 1_200, 4: 300, 5: 900 }),
      '2026-11-01',
      '2026-11-30',
      '2026-11-05',
    );
    expect(shown.middleCents).toBe(500);
    expect(shown.days.slice(0, 5)).toEqual([
      // The day on the median is neither: "same"
      { date: '2026-11-01', cents: 500, against: 'same' },
      { date: '2026-11-02', cents: 0, against: 'less' },
      { date: '2026-11-03', cents: 1_200, against: 'more' },
      { date: '2026-11-04', cents: 300, against: 'less' },
      { date: '2026-11-05', cents: 900, against: 'more' },
    ]);
  });

  test('with an even count it is the mean of the two middle days, rounded half up', () => {
    // 0, 300, 500, 1,200: halfway between 300 and 500
    expect(
      dayByDay(november({ 1: 500, 3: 1_200, 4: 300 }), '2026-11-01', '2026-11-30', '2026-11-04')
        .middleCents,
    ).toBe(400);
    // 100 and 101: 100.5 cents is shown as 101
    const halfway = dayByDay(
      november({ 1: 100, 2: 101 }),
      '2026-11-01',
      '2026-11-30',
      '2026-11-02',
    );
    expect(halfway.middleCents).toBe(101);
    // Against the figure as shown: 101 is on it
    expect(halfway.days.slice(0, 2).map((d) => d.against)).toEqual(['less', 'same']);
  });

  test('lists every day of the period; the days still to come are neither more nor less', () => {
    const shown = dayByDay(
      november({ 1: 500, 2: 700, 20: 18_900 }),
      '2026-11-01',
      '2026-11-30',
      '2026-11-02',
    );
    expect(shown.days).toHaveLength(30);
    expect(shown.days[0]).toEqual({ date: '2026-11-01', cents: 500, against: 'less' });
    expect(shown.days[1]).toEqual({ date: '2026-11-02', cents: 700, against: 'more' });
    // Spending already dated later shows on its day but plays no part in the middle day
    expect(shown.middleCents).toBe(600);
    expect(shown.days[19]).toEqual({ date: '2026-11-20', cents: 18_900, against: null });
    expect(shown.days[29]).toEqual({ date: '2026-11-30', cents: 0, against: null });
  });

  test('a finished period counts every day', () => {
    const shown = dayByDay(november({ 30: 1_000 }), '2026-11-01', '2026-11-30', '2026-12-03');
    // 29 days of nothing and one of RM 10
    expect(shown.middleCents).toBe(0);
    expect(shown.days.every((d) => d.against != null)).toBe(true);
    expect(shown.days[29]).toEqual({ date: '2026-11-30', cents: 1_000, against: 'more' });
  });

  test('before the period starts there is no middle day', () => {
    const shown = dayByDay([], '2026-12-01', '2026-12-31', '2026-11-30');
    expect(shown.middleCents).toBeNull();
    expect(shown.days).toHaveLength(31);
    expect(shown.days.every((d) => d.against == null && d.cents === 0)).toBe(true);
  });

  test('runs over a period that is not the calendar month, and ignores days outside it', () => {
    const shown = dayByDay(
      [
        { date: '2026-10-24', cents: 99_999 },
        { date: '2026-10-25', cents: 200 },
        { date: '2026-10-27', cents: 800 },
        { date: '2026-11-25', cents: 99_999 },
      ],
      '2026-10-25',
      '2026-11-24',
      '2026-10-27',
    );
    expect(shown.days).toHaveLength(31);
    expect(shown.days[0].date).toBe('2026-10-25');
    expect(shown.days[30].date).toBe('2026-11-24');
    // 200, 0, 800: the middle is 200
    expect(shown.middleCents).toBe(200);
    expect(shown.days.slice(0, 3).map((d) => d.against)).toEqual(['same', 'less', 'more']);
  });

  test('refuses a period longer than 31 days', () => {
    expect(() => dayByDay([], '2026-11-01', '2026-12-02', '2026-11-10')).toThrow(RangeError);
  });
});
