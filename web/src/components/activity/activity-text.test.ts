import { describe, expect, test } from 'vitest';
import type { Account, Category, Transaction } from '@shared/api';
import {
  budgetEffect,
  dayTotal,
  entriesText,
  foundLine,
  headlineAmount,
  kindText,
  listAmount,
  movingLine,
  noMatchLine,
  periodText,
  pickedLine,
  pickedOf,
  pickedParts,
  rowText,
  shortDay,
} from './activity-text';

// Activity's words, from the design (R-Activity, R-Activity-Select, R-Activity-Move,
// R-Desk-Activity, R-Desk-Bulk, R-Empty-Search) and its sign rules (R-System "Amounts say
// which way"): spending has a minus, income a plus, a transfer no sign at all. The fixed
// copy is the design's; every figure, name and date here is this file's own.

let n = 0;
const t = (over: Partial<Transaction>): Transaction => ({
  id: (++n).toString(16).padStart(16, '0'),
  kind: 'expense',
  accountId: 'a'.repeat(16),
  toAccountId: null,
  amountCents: 1_234,
  categoryId: 'f'.repeat(16),
  payee: null,
  note: null,
  date: '2026-11-07',
  createdAt: n,
  ...over,
});
const TODAY = '2026-11-10';

describe('amounts', () => {
  test('in lists: a minus for spending, a plus for income, no sign for a transfer, no RM', () => {
    expect(listAmount(t({ amountCents: 725 }), 'MYR')).toBe('−7.25');
    expect(listAmount(t({ kind: 'income', amountCents: 325_000 }), 'MYR')).toBe('+3,250.00');
    expect(listAmount(t({ kind: 'transfer', amountCents: 7_500 }), 'MYR')).toBe('75.00');
  });

  test('as an entry’s headline, with the currency', () => {
    expect(headlineAmount(t({ amountCents: 21_200 }), 'MYR')).toBe('−RM 212.00');
    expect(headlineAmount(t({ kind: 'income', amountCents: 5 }), 'MYR')).toBe('+RM 0.05');
    expect(headlineAmount(t({ kind: 'transfer', amountCents: 7_500 }), 'MYR')).toBe('RM 75.00');
  });

  test("a day's total: what came in less what went out, nothing for transfers alone", () => {
    expect(dayTotal({ entries: 2, spentCents: 1_185, receivedCents: 0 }, 'MYR')).toBe('−11.85');
    expect(dayTotal({ entries: 2, spentCents: 1_000, receivedCents: 2_500 }, 'MYR')).toBe('+15.00');
    expect(dayTotal({ entries: 2, spentCents: 900, receivedCents: 900 }, 'MYR')).toBe('0.00');
    expect(dayTotal({ entries: 1, spentCents: 0, receivedCents: 0 }, 'MYR')).toBeNull();
  });
});

describe('a row', () => {
  const CASH = 'a'.repeat(16);
  const BANK = 'b'.repeat(16);
  const [FOOD, COFFEE] = ['1', '2'].map((c) => c.repeat(16));
  const accounts = [
    { id: CASH, name: 'Cash' },
    { id: BANK, name: 'Bank' },
  ] as Account[];
  const categories = [
    { id: FOOD, name: 'Food', kind: 'expense', parentId: null, position: 0, archived: false },
    { id: COFFEE, name: 'Coffee', kind: 'expense', parentId: FOOD, position: 0, archived: false },
  ] as Category[];
  const of = (x: Transaction, q = '', selecting = false) =>
    rowText(x, { accounts, categories, q, selecting, today: TODAY });

  test('is titled by its payee, else its note, else what it was', () => {
    expect(of(t({ payee: 'Kedai Ali', note: 'lunch', categoryId: FOOD }))).toEqual({
      title: 'Kedai Ali',
      subtitle: 'Food · Cash',
    });
    expect(of(t({ note: 'teh tarik', categoryId: COFFEE }))).toEqual({
      title: 'teh tarik',
      subtitle: 'Food › Coffee · Cash',
    });
    // The quick entry: no payee and no note
    expect(of(t({ categoryId: COFFEE }))).toEqual({ title: 'Food › Coffee', subtitle: 'Cash' });
  });

  test('a transfer is the two accounts, with no category', () => {
    const moved = {
      kind: 'transfer' as const,
      accountId: BANK,
      toAccountId: CASH,
      categoryId: null,
    };
    expect(of(t(moved))).toEqual({ title: 'Bank to Cash', subtitle: 'Transfer' });
    expect(of(t({ ...moved, note: 'top-up' }))).toEqual({
      title: 'top-up',
      subtitle: 'Bank to Cash',
    });
  });

  test('shows the note in place of the category only when the words found it', () => {
    const x = t({ payee: 'Kopitiam', note: 'teh tarik', categoryId: COFFEE, accountId: BANK });
    expect(of(x, 'TEH')).toEqual({ title: 'Kopitiam', subtitle: 'teh tarik · Bank' });
    expect(of(x, 'kopi')).toEqual({ title: 'Kopitiam', subtitle: 'Food › Coffee · Bank' });
  });

  test('while selecting, says its day too, with the year when it is another', () => {
    expect(of(t({ payee: 'Kedai Ali', categoryId: FOOD }), '', true).subtitle).toBe(
      'Food · Cash · Nov 7',
    );
    expect(
      of(t({ payee: 'Kedai Ali', categoryId: FOOD, date: '2025-10-14' }), '', true).subtitle,
    ).toBe('Food · Cash · Oct 14, 2025');
  });

  test("a register's day: the month and day, and the year when it is another", () => {
    expect(shortDay('2026-11-07', TODAY)).toBe('Nov 7');
    expect(shortDay('2025-10-14', TODAY)).toBe('Oct 14, 2025');
  });
});

describe('what was found', () => {
  test('how many, and what they spent and received', () => {
    expect(foundLine({ entries: 12, spentCents: 4_318, receivedCents: 0 }, 'MYR')).toBe(
      '12 found · RM 43.18 spent',
    );
    expect(foundLine({ entries: 2, spentCents: 100, receivedCents: 650_000 }, 'MYR')).toBe(
      '2 found · RM 1.00 spent · RM 6,500.00 received',
    );
    expect(foundLine({ entries: 1, spentCents: 0, receivedCents: 0 }, 'MYR')).toBe('1 found');
    expect(foundLine({ entries: 0, spentCents: 0, receivedCents: 0 }, 'MYR')).toBe('0 found');
  });

  test('while selecting: how many, in the category filtered by when there is one', () => {
    const found = { entries: 4, spentCents: 1, receivedCents: 0 };
    expect(foundLine(found, 'MYR', { category: 'Other' })).toBe('4 found in Other');
    // Words or days alone don't change it
    expect(foundLine(found, 'MYR', { category: null })).toBe('4 found');
  });

  test('"1 entry", "3 entries"', () => {
    expect([entriesText(1), entriesText(3)]).toEqual(['1 entry', '3 entries']);
  });
});

describe('the filters, named on their chips', () => {
  test('the days', () => {
    expect(periodText({ from: '2026-11-01', to: '2026-11-30' }, TODAY)).toBe('This month');
    expect(periodText({ from: '2026-10-01', to: '2026-10-31' }, TODAY)).toBe('Last month');
    expect(periodText({ from: '2026-08-01', to: '2026-08-31' }, TODAY)).toBe('August 2026');
    expect(periodText({ from: '2026-10-01', to: null }, TODAY)).toBe('Since Oct 1');
    expect(periodText({ from: null, to: '2026-10-31' }, TODAY)).toBe('Until Oct 31');
    expect(periodText({ from: '2026-11-10', to: '2026-11-10' }, TODAY)).toBe('Tue, Nov 10');
    expect(periodText({ from: '2026-10-03', to: '2026-10-09' }, TODAY)).toBe('Oct 3 to Oct 9');
    expect(periodText({ from: null, to: null }, TODAY)).toBe('All months');
    // Another year says which
    expect(periodText({ from: '2025-10-01', to: null }, TODAY)).toBe('Since Oct 1, 2025');
  });

  test('the kinds', () => {
    expect(kindText(null)).toBe('All kinds');
    expect(kindText(['expense'])).toBe('Expenses');
    expect(kindText(['income'])).toBe('Income');
    expect(kindText(['transfer'])).toBe('Transfers');
    expect(kindText(['expense', 'income'])).toBe('Expenses and income');
    expect(kindText(['expense', 'transfer'])).toBe('Expenses and transfers');
    expect(kindText(['income', 'transfer'])).toBe('Income and transfers');
  });
});

describe('nothing found', () => {
  const month = { from: '2026-11-01', to: '2026-11-30' };
  test('says what was looked for, and how many are found on other days', () => {
    expect(noMatchLine({ q: 'bolt', category: 'Transport', ...month, elsewhere: 2 }, TODAY)).toBe(
      'No "bolt" in Transport this month. 2 in other months.',
    );
    expect(noMatchLine({ q: 'bolt', category: null, ...month, elsewhere: 1 }, TODAY)).toBe(
      'No "bolt" this month. 1 in another month.',
    );
    expect(noMatchLine({ q: 'kedai', category: null, ...month, elsewhere: 0 }, TODAY)).toBe(
      'No "kedai" this month.',
    );
    expect(noMatchLine({ q: '', category: 'Fun', ...month, elsewhere: 0 }, TODAY)).toBe(
      'Nothing in Fun this month.',
    );
    expect(
      noMatchLine({ q: 'teh', category: null, from: '2026-10-01', to: null, elsewhere: 2 }, TODAY),
    ).toBe('No "teh" since Oct 1. 2 on other days.');
    expect(
      noMatchLine({ q: '', category: null, from: TODAY, to: TODAY, elsewhere: 1 }, TODAY),
    ).toBe('Nothing on Tue, Nov 10. 1 on another day.');
    expect(
      noMatchLine({ q: 'x', category: null, from: null, to: null, elsewhere: null }, TODAY),
    ).toBe('No "x".');
  });

  test('on the first of a month, with nothing yet this month but earlier entries', () => {
    expect(noMatchLine({ q: '', category: null, ...month, elsewhere: 4 }, TODAY)).toBe(
      'Nothing this month. 4 in other months.',
    );
  });
});

describe('changing many', () => {
  const kedai = (date: string, amountCents: number) => t({ payee: 'Kedai', date, amountCents });

  test('what is ticked: how many, and what they add up to as expenses, income and net', () => {
    const three = [
      kedai('2026-11-08', 730),
      kedai('2026-10-21', 1_345),
      kedai('2026-10-12', 1_015),
    ];
    const spent = pickedOf(three);
    expect(spent).toEqual({
      entries: 3,
      spentCents: 3_090,
      receivedCents: 0,
      netCents: -3_090,
      transfers: 0,
      waiting: 0,
      payee: 'Kedai',
    });
    expect(pickedLine(spent, 'MYR')).toBe('3 selected · Net −RM 30.90');
    expect(pickedParts(spent, 'MYR')).toEqual({
      expenses: 'RM 30.90',
      income: 'RM 0.00',
      net: '−RM 30.90',
      notes: ['All Kedai'],
    });

    // Expense 1 and expense 2 with income 1: net is what came in less what went out
    const mixed = pickedOf([
      three[0],
      three[1],
      t({ kind: 'income', amountCents: 5_000, payee: 'Boss' }),
    ]);
    expect(mixed).toMatchObject({ spentCents: 2_075, receivedCents: 5_000, netCents: 2_925 });
    expect(pickedLine(mixed, 'MYR')).toBe('3 selected · Net +RM 29.25');
    expect(pickedParts(mixed, 'MYR').notes).toEqual([]);
    expect(pickedLine(pickedOf([three[0], t({ kind: 'income', amountCents: 730 })]), 'MYR')).toBe(
      '2 selected · Net RM 0.00',
    );
  });

  test('transfers are counted as selected but never as spending or income, and say so', () => {
    const picked = pickedOf([
      kedai('2026-11-08', 730),
      t({ kind: 'transfer', toAccountId: 'b'.repeat(16), categoryId: null, amountCents: 9_999 }),
      t({ kind: 'transfer', toAccountId: 'b'.repeat(16), categoryId: null, amountCents: 1 }),
    ]);
    expect(picked).toMatchObject({ entries: 3, spentCents: 730, receivedCents: 0, transfers: 2 });
    expect(pickedLine(picked, 'MYR')).toBe('3 selected · Net −RM 7.30 · 2 transfers not counted');
    expect(pickedParts(picked, 'MYR').notes).toEqual(['2 transfers not counted']);
    const one = pickedOf([t({ kind: 'transfer', toAccountId: 'b'.repeat(16), categoryId: null })]);
    expect(pickedLine(one, 'MYR')).toBe('1 selected · Net RM 0.00 · 1 transfer not counted');
  });

  test('another currency counts at what it came to; one waiting for a rate is said to be left out', () => {
    const thb = t({
      amountCents: 1_530,
      original: { currency: 'THB', cents: 12_000, rate: 0.1275, source: 'wise', at: 1 },
    });
    expect(pickedOf([thb, kedai('2026-11-08', 730)])).toMatchObject({ spentCents: 2_260 });
    const waiting = t({
      amountCents: 0,
      original: { currency: 'THB', cents: 12_000, rate: 1, source: 'wise', at: 1, pending: true },
    });
    const picked = pickedOf([waiting, kedai('2026-11-08', 730)]);
    expect(picked).toMatchObject({ spentCents: 730, waiting: 1 });
    expect(pickedLine(picked, 'MYR')).toBe('2 selected · Net −RM 7.30 · 1 waiting for a rate');
    expect(pickedParts(picked, 'MYR').notes).toEqual(['Leaves out 1 entry waiting for a rate']);
  });

  test('the days they are from, and where they are now', () => {
    const names = (id: string | null) => (id === 'f'.repeat(16) ? 'Other' : 'Food');
    const three = [kedai('2026-11-08', 1), kedai('2026-10-21', 1), kedai('2026-10-12', 1)];
    expect(movingLine(three, names, TODAY)).toBe('Kedai, Nov 8, Oct 21 and 12 · now in Other');
    expect(movingLine([three[1]], names, TODAY)).toBe('Kedai, Oct 21 · now in Other');
    const mixed = [three[0], t({ payee: 'Kiosk', date: '2026-11-02', categoryId: 'e'.repeat(16) })];
    expect(movingLine(mixed, names, TODAY)).toBe('Nov 8 and 2 · now in 2 categories');
    const many = Array.from({ length: 9 }, (_, i) => kedai(`2026-10-${10 + i}`, 1));
    expect(movingLine(many, names, TODAY)).toBe('Kedai, Oct 10, 11 and 7 more · now in Other');
    // Another year says which
    expect(movingLine([kedai('2025-12-30', 1)], names, TODAY)).toBe(
      'Kedai, Dec 30, 2025 · now in Other',
    );
  });

  test("the budget it goes into: what's left before and after, or that it has none", () => {
    expect(budgetEffect('Food', { leftCents: 31_250 }, 2_075, 'MYR')).toBe(
      'Food budget: RM 312.50 → RM 291.75 left',
    );
    expect(budgetEffect('Food', { leftCents: 1_000 }, 2_500, 'MYR')).toBe(
      'Food budget: RM 10.00 left → RM 15.00 over',
    );
    expect(budgetEffect('Food', { leftCents: -500 }, 100, 'MYR')).toBe(
      'Food budget: RM 5.00 over → RM 6.00 over',
    );
    // None of them newly in this month's budget: it stays as it is
    expect(budgetEffect('Food', { leftCents: 31_250 }, 0, 'MYR')).toBe(
      'Food budget: RM 312.50 left',
    );
    expect(budgetEffect('Groceries', null, 2_075, 'MYR')).toBe('Groceries has no budget');
  });
});
