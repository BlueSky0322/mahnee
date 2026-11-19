import { describe, expect, it } from 'vitest';
import type { BudgetLine } from '../../ledger/budgets';
import {
  budgetText,
  dayLabel,
  expensesLine,
  heroLine,
  incomeLine,
  leadingBlanks,
  runningFast,
  tidyText,
  weekdays,
} from './home-text';

// Home's words (R-Home, R-Desk-Home, R-Empty-Home): the month-end line, the two cards'
// lines, Tidy up, the calendar's day names and weekdays, and each budget's figures. The
// boards' figures are made-up samples; these check the copy and its shape.

const DAY_10_OF_30 = { day: 10, days: 30 };

const line = (name: string, availableCents: number, spentCents: number): BudgetLine => ({
  id: name.toLowerCase().padEnd(16, 'x'),
  name,
  amountCents: availableCents,
  carriedCents: 0,
  availableCents,
  spentCents,
  leftCents: availableCents - spentCents,
});

describe("the month end's line", () => {
  it('says today, the bills still due and the pay still due, each signed', () => {
    expect(
      heroLine({
        accounts: [{ name: 'Maybank Savings' }, { name: 'Cash' }],
        balancesCents: 815_700,
        billsCents: 18_900,
        payCents: 680_000,
        currency: 'MYR',
      }),
    ).toEqual({ today: 'RM 8,157.00 today', bills: '− RM 189.00', pay: '+ RM 6,800.00' });
  });

  it('leaves out bills or pay when none is due', () => {
    expect(
      heroLine({
        accounts: [{ name: 'Maybank Savings' }, { name: 'Cash' }],
        balancesCents: 100_000,
        billsCents: 18_900,
        payCents: 0,
        currency: 'MYR',
      }),
    ).toEqual({ today: 'RM 1,000.00 today', bills: '− RM 189.00', pay: null });
  });

  it('says the balances, not an account, when there are several and nothing is due', () => {
    expect(
      heroLine({
        accounts: [{ name: 'Maybank Savings' }, { name: 'Cash' }],
        balancesCents: 100_000,
        billsCents: 0,
        payCents: 0,
        currency: 'MYR',
      }),
    ).toEqual({ today: 'RM 1,000.00 today', bills: null, pay: null });
  });

  it("names the one account when it's all there is and nothing is due", () => {
    expect(
      heroLine({
        accounts: [{ name: 'Maybank Savings' }],
        balancesCents: 500_000,
        billsCents: 0,
        payCents: 0,
        currency: 'MYR',
      }),
    ).toEqual({ today: 'Maybank Savings today', bills: null, pay: null });
  });

  it('writes a balance below zero with a minus', () => {
    expect(
      heroLine({
        accounts: [{ name: 'Maybank Savings' }, { name: 'Visa' }],
        balancesCents: -2_500,
        billsCents: 0,
        payCents: 0,
        currency: 'MYR',
      }).today,
    ).toBe('−RM 25.00 today');
  });
});

describe("the expenses card's line", () => {
  it('says none yet before anything is spent', () => {
    expect(expensesLine(0, DAY_10_OF_30, null)).toBe('None yet');
  });

  it('says which day of the month it is, and the budget running fast', () => {
    expect(expensesLine(2_400, DAY_10_OF_30, null)).toBe('Day 10 of 30');
    expect(expensesLine(2_400, DAY_10_OF_30, 'Shopping')).toBe(
      'Day 10 of 30 · Shopping running fast',
    );
  });
});

describe('the budget running fast', () => {
  it('is the one furthest ahead of the month, by spent x days less available x day', () => {
    // Food: 2,400 x 30 - 6,000 x 10 = 12,000 ahead; Fun: 1,500 x 30 - 3,000 x 10 = 15,000
    const lines = [line('Food', 6_000, 2_400), line('Fun', 3_000, 1_500), line('Bills', 9_000, 0)];
    expect(runningFast(lines, DAY_10_OF_30)).toBe('Fun');
  });

  it('takes the first in the categories order when two are as far ahead', () => {
    // Both 12,000 ahead
    const lines = [line('Food', 6_000, 2_400), line('Fun', 3_000, 1_400)];
    expect(runningFast(lines, { day: 10, days: 30 })).toBe('Food');
    expect(runningFast([...lines].reverse(), { day: 10, days: 30 })).toBe('Fun');
  });

  it('is none when every budget is on track, and never one already over', () => {
    expect(runningFast([line('Food', 6_000, 2_000)], DAY_10_OF_30)).toBeNull();
    expect(runningFast([line('Food', 6_000, 6_001)], DAY_10_OF_30)).toBeNull();
    expect(runningFast([], DAY_10_OF_30)).toBeNull();
  });

  it('stays exact with the largest budgets', () => {
    const max = 1_000_000_000_000;
    const lines = [line('Food', max, max - 2), line('Fun', max, max - 1)];
    expect(runningFast(lines, { day: 29, days: 31 })).toBe('Fun');
  });
});

describe("the income card's line", () => {
  it('names the next pay and its day', () => {
    expect(incomeLine({ name: 'Salary', date: '2026-11-25' })).toBe('Salary due Nov 25');
  });

  it('says so when no pay is scheduled', () => {
    expect(incomeLine(null)).toBe('No pay scheduled');
  });
});

describe('Tidy up', () => {
  it('counts the entries since a day still in Other', () => {
    expect(tidyText(9, '2026-10-01', 'Other')).toEqual({
      count: '9 entries',
      rest: 'since Oct 1, still in Other',
    });
    expect(tidyText(1, '2026-10-01', 'Misc')).toEqual({
      count: '1 entry',
      rest: 'since Oct 1, still in Misc',
    });
  });
});

describe("a calendar day's name", () => {
  it('says what was spent against the middle day', () => {
    expect(dayLabel({ date: '2026-11-10', cents: 1_768, against: 'less' }, [], 'MYR')).toBe(
      'November 10, spent RM 17.68, less than the middle day',
    );
    expect(dayLabel({ date: '2026-11-01', cents: 147_017, against: 'more' }, [], 'MYR')).toBe(
      'November 1, spent RM 1,470.17, more than the middle day',
    );
    expect(dayLabel({ date: '2026-11-02', cents: 0, against: 'less' }, [], 'MYR')).toBe(
      'November 2, spent RM 0.00, less than the middle day',
    );
  });

  it('names what is due on a day to come', () => {
    expect(
      dayLabel({ date: '2026-11-20', cents: 0, against: null }, ['TNB electricity'], 'MYR'),
    ).toBe('November 20, TNB electricity due');
    expect(
      dayLabel({ date: '2026-11-25', cents: 0, against: null }, ['Rent', 'Netflix'], 'MYR'),
    ).toBe('November 25, Rent and Netflix due');
    expect(dayLabel({ date: '2026-11-21', cents: 0, against: null }, [], 'MYR')).toBe(
      'November 21',
    );
  });

  it('says what was spent first, then what is due, on a day with both', () => {
    expect(
      dayLabel({ date: '2026-11-10', cents: 900, against: 'more' }, ['TNB electricity'], 'MYR'),
    ).toBe('November 10, spent RM 9.00, more than the middle day, TNB electricity due');
  });
});

describe("the calendar's weeks", () => {
  it('start on the day the setting says', () => {
    expect(weekdays('monday')).toEqual(['M', 'T', 'W', 'T', 'F', 'S', 'S']);
    expect(weekdays('sunday')).toEqual(['S', 'M', 'T', 'W', 'T', 'F', 'S']);
  });

  it('leave blank the days before the first in its week', () => {
    // 1 November 2026 is a Sunday; 1 December a Tuesday; 1 June 2026 a Monday
    expect(leadingBlanks('2026-11-01', 'monday')).toBe(6);
    expect(leadingBlanks('2026-11-01', 'sunday')).toBe(0);
    expect(leadingBlanks('2026-12-01', 'monday')).toBe(1);
    expect(leadingBlanks('2026-12-01', 'sunday')).toBe(2);
    expect(leadingBlanks('2026-06-01', 'monday')).toBe(0);
  });
});

describe("a budget's figures", () => {
  it('say what is left, of what, and how it goes against the month (phone)', () => {
    expect(
      budgetText(line('Food', 80_000, 21_522), DAY_10_OF_30, { short: false, currency: 'MYR' }),
    ).toEqual({
      left: 'RM 584.78 left',
      meta: 'RM 215.22 of RM 800.00 · on track',
      pace: 'onTrack',
      label: 'Food: 27% of budget spent, 33% of the month gone',
    });
    expect(
      budgetText(line('Shopping', 30_000, 23_842), DAY_10_OF_30, { short: false, currency: 'MYR' }),
    ).toEqual({
      left: 'RM 61.58 left',
      meta: 'RM 238.42 of RM 300.00 · faster than the month',
      pace: 'faster',
      label: 'Shopping: 79% of budget spent, 33% of the month gone',
    });
  });

  it('drop the symbol from what is left, and what is spent, on a computer', () => {
    expect(
      budgetText(line('Food', 80_000, 21_522), DAY_10_OF_30, { short: true, currency: 'MYR' }),
    ).toEqual({
      left: '584.78 left',
      meta: 'of RM 800.00 · on track',
      pace: 'onTrack',
      label: 'Food: 27% of budget spent, 33% of the month gone',
    });
  });

  it('say how far over', () => {
    expect(
      budgetText(line('Fun', 30_000, 34_000), DAY_10_OF_30, { short: false, currency: 'MYR' }),
    ).toEqual({
      left: 'RM 40.00 over',
      meta: 'RM 340.00 of RM 300.00 · over',
      pace: 'over',
      label: 'Fun: 113% of budget spent, 33% of the month gone',
    });
    expect(
      budgetText(line('Fun', 30_000, 34_000), DAY_10_OF_30, { short: true, currency: 'MYR' }).left,
    ).toBe('40.00 over');
  });

  it('keep the words once the month is over, and say on track', () => {
    const done = { day: 31, days: 31 };
    expect(
      budgetText(line('Food', 80_000, 21_522), done, { short: false, currency: 'MYR' }).meta,
    ).toBe('RM 215.22 of RM 800.00 · on track');
    expect(
      budgetText(line('Fun', 30_000, 34_000), done, { short: false, currency: 'MYR' }).meta,
    ).toBe('RM 340.00 of RM 300.00 · over');
  });
});
