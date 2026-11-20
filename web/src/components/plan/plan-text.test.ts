import { describe, expect, it } from 'vitest';
import type { BudgetLine } from '../../ledger/budgets';
import type { CategorySpending } from '../../ledger/derive';
import {
  budgetWords,
  deskSubtitle,
  entriesText,
  phoneSubtitle,
  shareLabel,
  sharePercent,
  usualText,
  yearComparison,
} from './plan-text';

// Plan's words (R-Plan, R-Desk-Plan, R-Category; digest 3.6, 3.7, 4.3, 4.4): each category's
// share of the month's spending, the rows' subtitles, how a month compares with the usual,
// where it stands in the year, and each budget's figures. The boards' figures are made-up
// samples; these check the copy and its shape against figures worked out here.

const DAY_10_OF_30 = { day: 10, days: 30 };
const DAY_30_OF_30 = { day: 30, days: 30 };

const line = (
  name: string,
  availableCents: number,
  spentCents: number,
  carriedCents = 0,
): BudgetLine => ({
  id: name.toLowerCase().padEnd(16, 'x'),
  name,
  amountCents: availableCents - carriedCents,
  carriedCents,
  availableCents,
  spentCents,
  leftCents: availableCents - spentCents,
});

const row = (
  name: string,
  cents: number,
  entries: number,
  more: Partial<CategorySpending> = {},
): CategorySpending => ({
  id: name.toLowerCase().padEnd(16, 'x'),
  name,
  cents,
  ownCents: cents,
  entries,
  payee: null,
  subcategories: [],
  ...more,
});

describe("a category's share of the month's spending", () => {
  it('is a whole percent, rounded half up', () => {
    // 1 of 8 is 12.5%, 3 of 8 is 37.5%, 1 of 3 is 33.3%
    expect(sharePercent(100, 800)).toBe('13%');
    expect(sharePercent(300, 800)).toBe('38%');
    expect(sharePercent(100, 300)).toBe('33%');
    expect(sharePercent(800, 800)).toBe('100%');
  });

  it('says "under 1%" for a share that rounds to nothing, never 0%', () => {
    // 1 in 200 is 0.5%, which rounds up; 1 in 201 doesn't
    expect(sharePercent(1, 200)).toBe('1%');
    expect(sharePercent(1, 201)).toBe('under 1%');
    expect(sharePercent(50, 165_050)).toBe('under 1%');
  });

  it('stays exact at the largest totals a person can have', () => {
    // 5e15 cents in all: 2.5e13 + 1 of it is just over 0.5%, 2.5e13 - 1 just under
    expect(sharePercent(25_000_000_000_001, 5_000_000_000_000_000)).toBe('1%');
    expect(sharePercent(24_999_999_999_999, 5_000_000_000_000_000)).toBe('under 1%');
    // Half of it plus a cent is 50.000...02%, so rounds to 50, not 51
    expect(sharePercent(2_500_000_000_000_001, 5_000_000_000_000_000)).toBe('50%');
    // 12.5% of it, exactly, rounds up
    expect(sharePercent(625_000_000_000_000, 5_000_000_000_000_000)).toBe('13%');
  });

  it('names the share bar with each category, largest first, as drawn', () => {
    expect(
      shareLabel(
        [
          { name: 'Bills', cents: 120_000 },
          { name: 'Groceries', cents: 18_000 },
          { name: 'Fun', cents: 50 },
        ],
        138_050,
      ),
    ).toBe('Share of expenses: Bills 87%, Groceries 13%, Fun under 1%');
  });
});

describe("a category row's subtitle", () => {
  it('counts the entries, one or many', () => {
    expect(entriesText(1)).toBe('1 entry');
    expect(entriesText(6)).toBe('6 entries');
    expect(phoneSubtitle(row('Groceries', 18_000, 3), 165_050, 'MYR')).toBe('11% · 3 entries');
    expect(phoneSubtitle(row('Health', 600, 1), 165_050, 'MYR')).toBe('under 1% · 1 entry');
  });

  it('names the payee of a single entry', () => {
    expect(phoneSubtitle(row('Bills', 120_000, 1, { payee: 'Rent' }), 165_050, 'MYR')).toBe(
      '73% · Rent',
    );
  });

  it('lists the subcategories with their amounts, then what was filed on the category itself', () => {
    const food = row('Food', 8_400, 4, {
      ownCents: 900,
      subcategories: [
        { id: 'd'.repeat(16), name: 'Dining out', cents: 6_000, entries: 2 },
        { id: 'c'.repeat(16), name: 'Coffee', cents: 1_500, entries: 1 },
      ],
    });
    expect(phoneSubtitle(food, 165_050, 'MYR')).toBe(
      '5% · Dining out 60.00, Coffee 15.00, Food 9.00',
    );
    // With nothing filed on Food itself, only the subcategories
    expect(
      phoneSubtitle(
        row('Transport', 3_000, 1, {
          ownCents: 0,
          payee: 'Shell',
          subcategories: [{ id: 'p'.repeat(16), name: 'Petrol', cents: 3_000, entries: 1 }],
        }),
        165_050,
        'MYR',
      ),
    ).toBe('2% · Petrol 30.00');
  });

  it("on a computer: the subcategories' names, entries or payee, and carry-over", () => {
    const food = row('Food', 8_400, 4, {
      ownCents: 900,
      subcategories: [
        { id: 'd'.repeat(16), name: 'Dining out', cents: 6_000, entries: 2 },
        { id: 'c'.repeat(16), name: 'Coffee', cents: 1_500, entries: 1 },
      ],
    });
    expect(deskSubtitle(food, { carriesOver: true })).toBe('Dining out, Coffee · carries over');
    expect(deskSubtitle(food, { carriesOver: false })).toBe('Dining out, Coffee');
    expect(deskSubtitle(row('Bills', 120_000, 1, { payee: 'Rent' }), { carriesOver: false })).toBe(
      'Rent',
    );
    expect(deskSubtitle(row('Groceries', 18_000, 3), { carriesOver: true })).toBe(
      '3 entries · carries over',
    );
    // Nothing in the month: the row's 0.00 says so, so only whether its budget carries over
    expect(deskSubtitle(null, { carriesOver: false })).toBeNull();
    expect(deskSubtitle(null, { carriesOver: true })).toBe('Carries over');
  });
});

describe('the month against the usual', () => {
  it('says how far under or over the average of the 11 months before, or the same', () => {
    expect(usualText({ averageCents: 3_182, byCents: 5_218, direction: 'above' }, 'MYR')).toBe(
      'RM 52.18 over your usual RM 31.82',
    );
    expect(usualText({ averageCents: 37_146, byCents: 15_624, direction: 'below' }, 'MYR')).toBe(
      'RM 156.24 under your usual RM 371.46',
    );
    expect(usualText({ averageCents: 1_000, byCents: 0, direction: 'same' }, 'MYR')).toBe(
      'the same as your usual RM 10.00',
    );
  });
});

describe('where the month stands in its year', () => {
  const year = (cents: number[]) =>
    cents.map((c, i) => ({
      month: i === 0 ? '2025-12' : `2026-${String(i).padStart(2, '0')}`,
      cents: c,
    }));

  it('names the latest earlier month as low when the month shown is lower than the one before', () => {
    // Nov 84.00; Oct 250.00 and Sep 100.00 above it, Aug nothing: lowest since August
    expect(yearComparison(year([0, 0, 0, 0, 0, 0, 0, 0, 0, 10_000, 25_000, 8_400]))).toBe(
      'November lowest since August',
    );
  });

  it('names the latest earlier month as high when it is higher than the one before', () => {
    // Nov 300.00; Oct 100.00, Sep 200.00, Aug 350.00: highest since August
    expect(
      yearComparison(
        year([500, 500, 500, 500, 500, 500, 500, 500, 35_000, 20_000, 10_000, 30_000]),
      ),
    ).toBe('November highest since August');
  });

  it('says lowest or highest in 12 months when no month before comes near', () => {
    expect(yearComparison(year([900, 800, 700, 600, 500, 400, 300, 300, 400, 500, 600, 100]))).toBe(
      'November lowest in 12 months',
    );
    expect(
      yearComparison(year([900, 800, 700, 600, 500, 400, 300, 300, 400, 500, 600, 1_000])),
    ).toBe('November highest in 12 months');
  });

  it('counts a month level with the month shown as at or below it', () => {
    // Nov 84.00 and Aug 84.00, Sep and Oct above: lowest since August
    expect(yearComparison(year([0, 0, 0, 0, 0, 0, 0, 0, 8_400, 10_000, 25_000, 8_400]))).toBe(
      'November lowest since August',
    );
    // Level with the lowest of the 11 before (December): lowest since then, not in 12 months
    expect(yearComparison(year([100, 900, 900, 900, 900, 900, 900, 900, 900, 900, 500, 100]))).toBe(
      'November lowest since December',
    );
  });

  it('says nothing when the month is level with the one before', () => {
    expect(
      yearComparison(year([900, 800, 700, 600, 500, 400, 300, 300, 400, 500, 600, 600])),
    ).toBeNull();
    expect(yearComparison(year(Array.from({ length: 12 }, () => 0)))).toBeNull();
  });
});

describe("a budget's figures on Plan", () => {
  it("on track: what's left, and what's spent of what's available, with no pace words", () => {
    expect(
      budgetWords(line('Food', 80_000, 21_522), DAY_10_OF_30, { short: false, currency: 'MYR' }),
    ).toEqual({
      left: 'RM 584.78 left',
      meta: 'RM 215.22 of RM 800.00',
      label: 'Food: 27% spent',
      pace: 'onTrack',
    });
  });

  it('faster than the month: says so after the figures', () => {
    expect(
      budgetWords(line('Shopping', 30_000, 23_842), DAY_10_OF_30, {
        short: false,
        currency: 'MYR',
      }),
    ).toEqual({
      left: 'RM 61.58 left',
      meta: 'RM 238.42 of RM 300.00 · faster than the month',
      label: 'Shopping: 79% spent',
      pace: 'faster',
    });
  });

  it('over: how far over, said once, before the figures', () => {
    expect(
      budgetWords(line('Transport', 2_000, 3_000), DAY_10_OF_30, { short: false, currency: 'MYR' }),
    ).toEqual({
      left: 'RM 10.00 over',
      meta: 'RM 30.00 of RM 20.00',
      label: 'Transport: 150% spent',
      pace: 'over',
    });
  });

  it('exactly on budget: nothing left, never over', () => {
    expect(
      budgetWords(line('Groceries', 18_000, 18_000), DAY_30_OF_30, {
        short: false,
        currency: 'MYR',
      }),
    ).toEqual({
      left: 'RM 0.00 left',
      meta: 'RM 180.00 of RM 180.00',
      label: 'Groceries: 100% spent',
      pace: 'onTrack',
    });
  });

  it("counts what carried over in what's available", () => {
    // RM 300.00 set, RM 50.00 carried in, RM 84.00 spent
    expect(
      budgetWords(line('Food', 35_000, 8_400, 5_000), DAY_10_OF_30, {
        short: false,
        currency: 'MYR',
      }),
    ).toEqual({
      left: 'RM 266.00 left',
      meta: 'RM 84.00 of RM 350.00',
      label: 'Food: 24% spent',
      pace: 'onTrack',
    });
  });

  it('once the month is over: on track or over, never faster', () => {
    expect(
      budgetWords(line('Shopping', 30_000, 23_842), DAY_30_OF_30, { short: false, currency: 'MYR' })
        .pace,
    ).toBe('onTrack');
  });

  it("names the bar's percent exactly: nothing spent, half up, and at the limits", () => {
    expect(
      budgetWords(line('Food', 30_000, 0), DAY_10_OF_30, { short: false, currency: 'MYR' }).label,
    ).toBe('Food: 0% spent');
    // 1 in 200 is 0.5%, which rounds up
    expect(
      budgetWords(line('Food', 20_000, 100), DAY_10_OF_30, { short: false, currency: 'MYR' }).label,
    ).toBe('Food: 1% spent');
    // RM 2.00 available and nearly all a person can spend: 1,897,210,537,686,175.5%, exactly,
    // which rounds up; worked in floats it comes out one short
    expect(
      budgetWords(line('Food', 200, 3_794_421_075_372_351), DAY_10_OF_30, {
        short: false,
        currency: 'MYR',
      }).label,
    ).toBe('Food: 1897210537686176% spent');
  });

  it('on a computer: figures without the symbol in the Left column', () => {
    expect(
      budgetWords(line('Food', 80_000, 21_522), DAY_10_OF_30, { short: true, currency: 'MYR' })
        .left,
    ).toBe('584.78');
    expect(
      budgetWords(line('Transport', 2_000, 3_000), DAY_10_OF_30, { short: true, currency: 'MYR' })
        .left,
    ).toBe('10.00 over');
  });
});
