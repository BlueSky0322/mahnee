import { describe, expect, it } from 'vitest';
import type { Recurring } from './api';
import { readExportRows, parseCsv } from './csv-import';
import { EXPORT_COLUMNS, csvLine, openingCells, repeatingLines } from './export';

describe('export lines', () => {
  it('keeps a negative amount a number, while text starting with "-" gets a \'', () => {
    const owed = openingCells({
      id: 'a'.repeat(16),
      name: '-Old card',
      currency: 'MYR',
      openingCents: -32_005,
      createdAt: Date.UTC(2026, 0, 3, 23, 59),
    });
    expect(csvLine(owed)).toBe(
      `2026-01-03,Opening balance,'-Old card,,-320.05,MYR,,,,,${'a'.repeat(16)}\r\n`,
    );
  });
});

describe('repeating lines', () => {
  const BANK = 'b'.repeat(16);
  const CARD = 'c'.repeat(16);
  const [FOOD, COFFEE, SALARY] = ['f'.repeat(16), 'e'.repeat(16), 'd'.repeat(16)];
  const names = {
    accounts: new Map([
      [BANK, { name: 'Maybank', currency: 'MYR' }],
      [CARD, { name: 'Visa', currency: 'MYR' }],
    ]),
    categories: new Map([
      [FOOD, { name: 'Food', parentId: null }],
      [COFFEE, { name: 'Coffee', parentId: FOOD }],
      [SALARY, { name: 'Salary', parentId: null }],
    ]),
  };
  const item = (id: string, more: Partial<Recurring>): Recurring => ({
    id: id.repeat(16),
    kind: 'expense',
    accountId: BANK,
    toAccountId: null,
    amountCents: 1_000,
    categoryId: FOOD,
    payee: null,
    schedule: 'monthly',
    day: 1,
    startDate: '2026-10-01',
    nextDue: '2026-11-01',
    archived: false,
    ...more,
  });

  it('writes each running item, in the order given, and leaves stopped ones out', () => {
    const lines = repeatingLines(
      [
        item('1', {
          amountCents: 120_050,
          categoryId: COFFEE,
          payee: 'Rent',
          day: 15,
          nextDue: '2026-12-15',
        }),
        // Stopped: not in the file
        item('2', { payee: 'Old gym', archived: true }),
        item('3', {
          kind: 'income',
          amountCents: 500_000,
          categoryId: SALARY,
          payee: '=Employer',
          day: 25,
          nextDue: '2026-10-25',
        }),
        // Weekly on Wednesdays (1 is Monday)
        item('4', {
          kind: 'transfer',
          toAccountId: CARD,
          amountCents: 30_000,
          categoryId: null,
          schedule: 'weekly',
          day: 3,
          nextDue: '2026-11-11',
        }),
      ],
      names,
    );
    expect(lines).toBe(
      `2026-12-15,Repeating spent,Maybank,,1200.50,MYR,Coffee,Food,Rent,"Monthly, day 15",${'1'.repeat(16)}\r\n` +
        // The amount stays unsigned, and a payee a spreadsheet would run gets a '
        `2026-10-25,Repeating received,Maybank,,5000.00,MYR,Salary,,'=Employer,"Monthly, day 25",${'3'.repeat(16)}\r\n` +
        `2026-11-11,Repeating transfer,Maybank,Visa,300.00,MYR,,,,"Weekly, day 3",${'4'.repeat(16)}\r\n`,
    );
  });

  it('reads back as written: each schedule and day, kind, amount, next due and payee', () => {
    const written = [
      item('a', {
        day: 1,
        nextDue: '2026-12-01',
        payee: '=Employer',
        kind: 'income',
        categoryId: SALARY,
      }),
      item('b', { day: 15, nextDue: '2026-11-15', amountCents: 1 }),
      item('c', { day: 31, nextDue: '2026-11-30', categoryId: COFFEE }),
      // 9 November 2026 is a Monday, the 11th a Wednesday, the 8th a Sunday
      item('d', { schedule: 'weekly', day: 1, nextDue: '2026-11-09' }),
      item('e', { schedule: 'weekly', day: 3, nextDue: '2026-11-11', amountCents: 1_000_000_000 }),
      item('f', {
        schedule: 'weekly',
        day: 7,
        nextDue: '2026-11-08',
        kind: 'transfer',
        toAccountId: CARD,
        categoryId: null,
      }),
    ];
    const read = readExportRows(
      parseCsv(csvLine(EXPORT_COLUMNS) + repeatingLines(written, names)),
      Date.UTC(2026, 10, 6, 12),
    );
    expect(
      read.map((r) =>
        r.problem === undefined ? [r.kind, r.repeat, r.cents, r.date, r.payee] : r.problem,
      ),
    ).toEqual(
      written.map((w) => [
        w.kind,
        { schedule: w.schedule, day: w.day },
        w.amountCents,
        w.nextDue,
        w.payee,
      ]),
    );
  });

  it('writes nothing for someone with nothing running', () => {
    expect(repeatingLines([], names)).toBe('');
    expect(repeatingLines([item('5', { archived: true })], names)).toBe('');
  });
});
