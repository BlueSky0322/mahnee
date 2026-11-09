import { describe, expect, it } from 'vitest';
import type { ColumnMapping } from './csv-import';
import {
  MAX_IMPORT_ROWS,
  isMahneeExport,
  looksSaved,
  parseCsv,
  payeeKey,
  readBankRows,
  readCents,
  readDay,
  readExportRows,
} from './csv-import';
import { CSV_BOM, EXPORT_COLUMNS, csvLine, exportCells, openingCells } from './export';

// Reading a bank's CSV file, or Mahnee's own export, into rows to import: the file's
// cells, the days and amounts banks write, and which rows look already saved.

const NOW = Date.UTC(2026, 10, 6, 12);

describe('reading a CSV file', () => {
  it('takes quoted cells, doubled quotes, line breaks in quotes and a byte-order mark', () => {
    const text =
      `${CSV_BOM}Date,Description,Amount\r\n` +
      '05/11/2026,"Kopi, ""Corner""",-8.00\r\n' +
      '06/11/2026,"Two\nlines",12\n' +
      '\r\n' +
      '07/11/2026,Plain,"1,234.50"\n';
    expect(parseCsv(text)).toEqual([
      ['Date', 'Description', 'Amount'],
      ['05/11/2026', 'Kopi, "Corner"', '-8.00'],
      ['06/11/2026', 'Two\nlines', '12'],
      ['07/11/2026', 'Plain', '1,234.50'],
    ]);
  });

  it('reads a file without a line break at the end, and an empty cell at the end of a line', () => {
    expect(parseCsv('a,b\n1,')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ]);
  });
});

describe('days', () => {
  it.each([
    ['05/11/2026', '2026-11-05'],
    ['5/11/2026', '2026-11-05'],
    ['2026-11-05', '2026-11-05'],
    ['5 Nov 2026', '2026-11-05'],
    ['05 nov 2026', '2026-11-05'],
    [' 29/02/2024 ', '2024-02-29'],
  ])('reads %j as %s', (text, day) => {
    expect(readDay(text)).toBe(day);
  });

  it.each(['31/02/2026', '2026-13-01', '5 Nox 2026', 'yesterday', ''])(
    'reads %j as no day',
    (text) => {
      expect(readDay(text)).toBeNull();
    },
  );
});

describe('amounts', () => {
  it.each([
    ['8', 800],
    ['8.5', 850],
    ['1,234.50', 123_450],
    ['RM 1,234.50', 123_450],
    ['RM1,234.50', 123_450],
    ['-12.00', -1_200],
    ['(12.00)', -1_200],
    ['RM (12.00)', -1_200],
    ['-RM 5.00', -500],
    ['+20', 2_000],
    [' 0.05 ', 5],
  ])('reads %j as %d cents', (text, cents) => {
    expect(readCents(text)).toBe(cents);
  });

  it.each(['', 'abc', '1.234', '12.3.4', 'RM'])('reads %j as no amount', (text) => {
    expect(readCents(text)).toBeNull();
  });
});

describe("a bank's file, mapped by column", () => {
  const ONE_COLUMN: ColumnMapping = {
    date: 'Date',
    amount: 'Amount',
    moneyIn: null,
    moneyOut: null,
    payee: 'Description',
    note: 'Ref',
  };

  it('reads each row: its day, its amount (below zero for money out), payee and note', () => {
    const table = [
      ['Ref', 'Date', 'Description', 'Amount'],
      ['A1', '05/11/2026', '  Kopi Corner ', '-8.00'],
      ['', '2026-11-01', 'Salary', 'RM 5,000.00'],
      ['A3', '3 Nov 2026', '', '(20.00)'],
    ];
    expect(readBankRows(table, ONE_COLUMN, NOW)).toEqual([
      { row: 2, date: '2026-11-05', cents: -800, payee: 'Kopi Corner', note: 'A1' },
      { row: 3, date: '2026-11-01', cents: 500_000, payee: 'Salary', note: null },
      { row: 4, date: '2026-11-03', cents: -2_000, payee: null, note: 'A3' },
    ]);
  });

  it('reads money in and money out from two columns', () => {
    const table = [
      ['Date', 'Description', 'Money out', 'Money in'],
      ['05/11/2026', 'Kopi Corner', '8.00', ''],
      ['06/11/2026', 'Refund', '', '1,000.00'],
      ['07/11/2026', 'Fee', '-2.50', ''],
      ['04/11/2026', 'Nothing', '', ''],
    ];
    const rows = readBankRows(
      table,
      { ...ONE_COLUMN, amount: null, moneyIn: 'Money in', moneyOut: 'Money out', note: null },
      NOW,
    );
    expect(rows.slice(0, 3)).toEqual([
      { row: 2, date: '2026-11-05', cents: -800, payee: 'Kopi Corner', note: null },
      { row: 3, date: '2026-11-06', cents: 100_000, payee: 'Refund', note: null },
      { row: 4, date: '2026-11-07', cents: -250, payee: 'Fee', note: null },
    ]);
    expect(rows[3]).toMatchObject({ row: 5, problem: expect.stringMatching(/amount/i) });
  });

  it('says what is wrong with a row it cannot import, and reads the rest', () => {
    const table = [
      ['Date', 'Description', 'Amount'],
      ['31/02/2026', 'No such day', '-8.00'],
      ['05/11/2026', 'Not a number', 'abc'],
      ['05/11/2026', 'Nothing', '0.00'],
      ['05/11/2026', 'Too much', '-10,000,000.01'],
      ['31/12/1999', 'Too early', '-8.00'],
      ['08/11/2026', 'Too late', '-8.00'],
      ['05/11/2026', 'Fine', '-8.00'],
      ['05/11/2026'],
    ];
    const rows = readBankRows(table, { ...ONE_COLUMN, note: null }, NOW);
    expect(rows.map((r) => [r.row, r.problem === undefined ? 'ok' : r.problem])).toEqual([
      [2, expect.stringMatching(/date/i)],
      [3, expect.stringMatching(/amount/i)],
      [4, expect.stringMatching(/amount/i)],
      [5, expect.stringMatching(/amount/i)],
      [6, expect.stringMatching(/date|day/i)],
      [7, expect.stringMatching(/date|day/i)],
      [8, 'ok'],
      [9, expect.stringMatching(/amount/i)],
    ]);
  });

  it('cuts a payee or note longer than a transaction holds to fit', () => {
    const rows = readBankRows(
      [
        ['Date', 'Description', 'Amount', 'Ref'],
        ['05/11/2026', 'x'.repeat(200), '-8', 'y'.repeat(600)],
      ],
      ONE_COLUMN,
      NOW,
    );
    expect(rows[0]).toMatchObject({ payee: 'x'.repeat(80), note: 'y'.repeat(500) });
  });
});

describe("Mahnee's own export", () => {
  const WALLET = 'a'.repeat(16);
  const CARD = 'b'.repeat(16);
  const names = {
    accounts: new Map([
      [WALLET, { name: 'Wallet', currency: 'MYR' }],
      [CARD, { name: 'Visa', currency: 'MYR' }],
    ]),
    categories: new Map([
      ['f'.repeat(16), { name: 'Food', parentId: null }],
      ['c'.repeat(16), { name: 'Coffee', parentId: 'f'.repeat(16) }],
      ['s'.repeat(16), { name: 'Salary', parentId: null }],
    ]),
  };
  const t = {
    id: '1'.repeat(16),
    kind: 'expense' as const,
    accountId: WALLET,
    toAccountId: null,
    amountCents: 123_450,
    categoryId: 'c'.repeat(16),
    payee: 'Kopi, "Corner"\nSS2',
    note: '-RM5 off',
    date: '2026-10-04',
  };
  // Written by the export itself, so what it writes is what's read back
  const file =
    CSV_BOM +
    csvLine(EXPORT_COLUMNS) +
    csvLine(
      openingCells({
        id: WALLET,
        name: 'Wallet',
        currency: 'MYR',
        openingCents: 10_000,
        createdAt: Date.UTC(2026, 0, 1, 23),
      }),
    ) +
    csvLine(
      openingCells({
        id: CARD,
        name: 'Visa',
        currency: 'MYR',
        openingCents: -32_000,
        createdAt: 0,
      }),
    ) +
    csvLine(exportCells(t, names)) +
    csvLine(
      exportCells(
        {
          ...t,
          kind: 'income',
          amountCents: 500_000,
          categoryId: 's'.repeat(16),
          payee: '=HYPERLINK("x")',
          note: null,
          date: '2026-10-02',
        },
        names,
      ),
    ) +
    csvLine(
      exportCells(
        {
          ...t,
          kind: 'transfer',
          toAccountId: CARD,
          amountCents: 10_000,
          categoryId: null,
          payee: null,
          note: '@home',
          date: '2026-10-03',
        },
        names,
      ),
    );

  it('is known by its header', () => {
    const table = parseCsv(file);
    expect(isMahneeExport(table[0])).toBe(true);
    expect(isMahneeExport(['Date', 'Description', 'Amount'])).toBe(false);
    expect(isMahneeExport([...EXPORT_COLUMNS, 'Balance'])).toBe(false);
  });

  it('reads every line back as it was: opening balances, spending, income and transfers', () => {
    expect(readExportRows(parseCsv(file), NOW)).toEqual([
      {
        row: 2,
        kind: 'opening',
        date: '2026-01-01',
        account: 'Wallet',
        toAccount: null,
        cents: 10_000,
        category: null,
        parentCategory: null,
        payee: null,
        note: null,
      },
      {
        row: 3,
        kind: 'opening',
        date: '1970-01-01',
        account: 'Visa',
        toAccount: null,
        cents: -32_000,
        category: null,
        parentCategory: null,
        payee: null,
        note: null,
      },
      {
        row: 4,
        kind: 'expense',
        date: '2026-10-04',
        account: 'Wallet',
        toAccount: null,
        cents: 123_450,
        category: 'Coffee',
        parentCategory: 'Food',
        payee: 'Kopi, "Corner"\nSS2',
        note: '-RM5 off',
      },
      {
        row: 5,
        kind: 'income',
        date: '2026-10-02',
        account: 'Wallet',
        toAccount: null,
        cents: 500_000,
        category: 'Salary',
        parentCategory: null,
        payee: '=HYPERLINK("x")',
        note: null,
      },
      {
        row: 6,
        kind: 'transfer',
        date: '2026-10-03',
        account: 'Wallet',
        toAccount: 'Visa',
        cents: 10_000,
        category: null,
        parentCategory: null,
        payee: null,
        note: '@home',
      },
    ]);
  });

  it('says what is wrong with a line it cannot import', () => {
    const header = [...EXPORT_COLUMNS];
    const line = (kind: string, more: Partial<Record<string, string>> = {}) => {
      const cells: Record<string, string> = {
        Date: '2026-10-04',
        Kind: kind,
        Account: 'Wallet',
        Amount: '8.00',
        Category: 'Food',
        ...more,
      };
      return EXPORT_COLUMNS.map((c) => cells[c] ?? '');
    };
    const rows = readExportRows(
      [
        header,
        line('Lent'),
        line('Transfer'),
        line('Spent', { Amount: 'eight' }),
        line('Spent', { Account: '' }),
        line('Spent', { Date: '2026-02-31' }),
      ],
      NOW,
    );
    expect(rows.map((r) => r.problem)).toEqual([
      expect.stringMatching(/kind/i),
      expect.stringMatching(/account/i),
      expect.stringMatching(/amount/i),
      expect.stringMatching(/account/i),
      expect.stringMatching(/date|day/i),
    ]);
  });
});

describe("an export's repeating lines", () => {
  const HEADER = EXPORT_COLUMNS.join(',');
  /** A file of the header and these lines, as the export writes them */
  const fileOf = (...lines: string[]) =>
    parseCsv(`${CSV_BOM}${HEADER}\r\n${lines.map((l) => `${l}\r\n`).join('')}`);
  const ID = '1'.repeat(16);

  it('reads each as the item it repeats: what it records, how often, and its next due date', () => {
    const rows = readExportRows(
      fileOf(
        `2026-12-15,Repeating spent,Wallet,,1200.50,MYR,Coffee,Food,Rent,"Monthly, day 15",${ID}`,
        `2026-11-25,Repeating received,Wallet,,5000.00,MYR,Salary,,'=Employer,"Monthly, day 25",${ID}`,
        `2026-11-11,Repeating transfer,Wallet,Visa,300.00,MYR,,,,"Weekly, day 3",${ID}`,
        // On a shorter month's last day
        `2026-11-30,Repeating spent,Wallet,,10.00,MYR,Food,,Gym,"Monthly, day 31",${ID}`,
        // A next due date that has passed is read as written
        `2026-10-01,Repeating spent,Wallet,,10.00,MYR,Food,,,"Monthly, day 1",${ID}`,
      ),
      NOW,
    );
    expect(rows).toEqual([
      {
        row: 2,
        kind: 'expense',
        date: '2026-12-15',
        account: 'Wallet',
        toAccount: null,
        cents: 120_050,
        category: 'Coffee',
        parentCategory: 'Food',
        payee: 'Rent',
        note: null,
        repeat: { schedule: 'monthly', day: 15 },
      },
      {
        row: 3,
        kind: 'income',
        date: '2026-11-25',
        account: 'Wallet',
        toAccount: null,
        cents: 500_000,
        category: 'Salary',
        parentCategory: null,
        payee: '=Employer',
        note: null,
        repeat: { schedule: 'monthly', day: 25 },
      },
      {
        row: 4,
        kind: 'transfer',
        date: '2026-11-11',
        account: 'Wallet',
        toAccount: 'Visa',
        cents: 30_000,
        category: null,
        parentCategory: null,
        payee: null,
        note: null,
        repeat: { schedule: 'weekly', day: 3 },
      },
      {
        row: 5,
        kind: 'expense',
        date: '2026-11-30',
        account: 'Wallet',
        toAccount: null,
        cents: 1_000,
        category: 'Food',
        parentCategory: null,
        payee: 'Gym',
        note: null,
        repeat: { schedule: 'monthly', day: 31 },
      },
      {
        row: 6,
        kind: 'expense',
        date: '2026-10-01',
        account: 'Wallet',
        toAccount: null,
        cents: 1_000,
        category: 'Food',
        parentCategory: null,
        payee: null,
        note: null,
        repeat: { schedule: 'monthly', day: 1 },
      },
    ]);
  });

  it('says what is wrong with a day 0, an amount over the limit and a next due over a year ahead', () => {
    const rows = readExportRows(
      fileOf(
        `2026-12-01,Repeating spent,Wallet,,10.00,MYR,Food,,,"Monthly, day 0",${ID}`,
        `2026-11-09,Repeating spent,Wallet,,10.00,MYR,Food,,,"Weekly, day 0",${ID}`,
        `2026-12-01,Repeating spent,Wallet,,10000000.01,MYR,Food,,,"Monthly, day 1",${ID}`,
        // A year (366 days) from NOW is 7 November 2027: that day is read, the next isn't
        `2027-11-07,Repeating spent,Wallet,,10.00,MYR,Food,,,"Monthly, day 7",${ID}`,
        `2027-11-08,Repeating spent,Wallet,,10.00,MYR,Food,,,"Monthly, day 8",${ID}`,
      ),
      NOW,
    );
    expect(rows.map((r) => r.problem ?? null)).toEqual([
      "Can't read the schedule",
      "Can't read the schedule",
      'The amount is over 10,000,000',
      null,
      'Next due has to be within a year',
    ]);
  });

  it('reads an ordinary line as a transaction, not a repeating item', () => {
    const [spent] = readExportRows(
      fileOf(`2026-10-04,Spent,Wallet,,8.00,MYR,Food,,,"Monthly, day 1",${ID}`),
      NOW,
    );
    expect(spent).not.toHaveProperty('repeat');
    expect(spent).toMatchObject({ kind: 'expense', note: 'Monthly, day 1' });
  });

  it('says what is wrong with a repeating line it cannot import, and reads the rest', () => {
    const rows = readExportRows(
      fileOf(
        `2026-12-01,Repeating spent,Wallet,,10.00,MYR,Food,,,"Monthly, day 32",${ID}`,
        `2026-12-01,Repeating spent,Wallet,,10.00,MYR,Food,,,"Fortnightly, day 1",${ID}`,
        `2026-12-01,Repeating spent,Wallet,,10.00,MYR,Food,,,,${ID}`,
        `2026-11-09,Repeating spent,Wallet,,10.00,MYR,Food,,,"Weekly, day 8",${ID}`,
        // 2 December is not the 1st; 12 November 2026 is a Thursday, not a Wednesday
        `2026-12-02,Repeating spent,Wallet,,10.00,MYR,Food,,,"Monthly, day 1",${ID}`,
        `2026-11-12,Repeating transfer,Wallet,Visa,10.00,MYR,,,,"Weekly, day 3",${ID}`,
        `soon,Repeating spent,Wallet,,10.00,MYR,Food,,,"Monthly, day 1",${ID}`,
        `2026-12-01,Repeating spent,Wallet,,0.00,MYR,Food,,,"Monthly, day 1",${ID}`,
        `2026-12-01,Repeating spent,Wallet,,-10.00,MYR,Food,,,"Monthly, day 1",${ID}`,
        `2026-12-01,Repeating transfer,Wallet,,10.00,MYR,,,,"Monthly, day 1",${ID}`,
        `2026-12-01,Repeating spent,,,10.00,MYR,Food,,,"Monthly, day 1",${ID}`,
        `2026-12-01,Repeating,Wallet,,10.00,MYR,Food,,,"Monthly, day 1",${ID}`,
        `2026-12-01,Repeating spent,Wallet,,10.00,MYR,Food,,,"Monthly, day 1",${ID}`,
      ),
      NOW,
    );
    expect(rows.map((r) => r.problem ?? null)).toEqual([
      "Can't read the schedule",
      "Can't read the schedule",
      "Can't read the schedule",
      "Can't read the schedule",
      "The next due date isn't on the schedule",
      "The next due date isn't on the schedule",
      'Can\'t read the date "soon"',
      "Can't read the amount",
      "Can't read the amount",
      'No account named to move it to',
      'No account named',
      'Unknown kind of line',
      null,
    ]);
  });
});

describe('rows that look already saved', () => {
  const row = (
    more: Partial<{ accountId: string; date: string; cents: number; payee: string | null }> = {},
  ) => ({
    accountId: 'a'.repeat(16),
    date: '2026-11-05',
    cents: -800,
    payee: 'Kopi Corner',
    ...more,
  });

  it('compares payees trimmed and ignoring case; an empty payee only matches an empty one', () => {
    expect(payeeKey('  Kopi Corner ')).toBe(payeeKey('KOPI CORNER'));
    expect(payeeKey(null)).toBe(payeeKey(''));
    expect(payeeKey('Kopi Corner')).not.toBe(payeeKey(null));
  });

  it('is the same account, day, amount and payee', () => {
    const saved = [row({ payee: ' kopi corner' })];
    expect(looksSaved([row()], saved)).toEqual([true]);
    expect(looksSaved([row({ accountId: 'b'.repeat(16) })], saved)).toEqual([false]);
    expect(looksSaved([row({ date: '2026-11-06' })], saved)).toEqual([false]);
    expect(looksSaved([row({ cents: -801 })], saved)).toEqual([false]);
    // Money in is not the same as money out
    expect(looksSaved([row({ cents: 800 })], saved)).toEqual([false]);
    expect(looksSaved([row({ payee: null })], saved)).toEqual([false]);
    expect(looksSaved([row({ payee: null })], [row({ payee: '' })])).toEqual([true]);
  });

  it('matches each saved one once, so two alike in a file are both new against one saved', () => {
    expect(looksSaved([row(), row(), row({ cents: -500 })], [row()])).toEqual([true, false, false]);
    expect(looksSaved([row(), row()], [row(), row()])).toEqual([true, true]);
  });
});

describe('the limit', () => {
  it('is 5,000 rows a file', () => {
    expect(MAX_IMPORT_ROWS).toBe(5_000);
  });
});
