import { describe, expect, it } from 'vitest';
import type { Transaction } from './api';
import { parseCsv, readExportRows } from './csv-import';
import { EXPORT_COLUMNS, csvLine, exportCells } from './export';

// A time on entries in the export file (owner decision D20): "export puts it beside the
// date and import reads it if present". A file made before entries had times, with no Time
// column, still reads as it did. Names and figures are made up.

const WALLET = 'a'.repeat(16);
const FOOD = 'f'.repeat(16);
const names = {
  accounts: new Map([[WALLET, { name: 'Wallet', currency: 'MYR' }]]),
  categories: new Map([[FOOD, { name: 'Food', parentId: null }]]),
};
const coffee: Omit<Transaction, 'createdAt'> = {
  id: 'c'.repeat(16),
  kind: 'expense',
  accountId: WALLET,
  toAccountId: null,
  amountCents: 800,
  categoryId: FOOD,
  payee: 'Kiosk',
  note: null,
  date: '2026-11-05',
};
const NOW = Date.UTC(2026, 10, 6);

describe('writing a time', () => {
  it('has a Time column beside the Date', () => {
    expect(EXPORT_COLUMNS.slice(0, 3)).toEqual(['Date', 'Time', 'Kind']);
  });

  it("writes an entry's time beside its day", () => {
    expect(csvLine(exportCells({ ...coffee, time: '08:12' }, names))).toBe(
      `2026-11-05,08:12,Spent,Wallet,,8.00,MYR,Food,,Kiosk,,${'c'.repeat(16)}\r\n`,
    );
  });

  it('leaves it empty for an entry with none', () => {
    expect(csvLine(exportCells({ ...coffee, time: null }, names))).toBe(
      `2026-11-05,,Spent,Wallet,,8.00,MYR,Food,,Kiosk,,${'c'.repeat(16)}\r\n`,
    );
    expect(csvLine(exportCells(coffee, names))).toBe(
      `2026-11-05,,Spent,Wallet,,8.00,MYR,Food,,Kiosk,,${'c'.repeat(16)}\r\n`,
    );
  });
});

describe('reading a time', () => {
  const header = EXPORT_COLUMNS.join(',');

  it('reads the time when the file has one', () => {
    const [row] = readExportRows(
      parseCsv(`${header}\r\n2026-11-05,20:12,Spent,Wallet,,8.00,MYR,Food,,Kiosk,,x\r\n`),
      NOW,
    );
    expect(row).toMatchObject({ kind: 'expense', date: '2026-11-05', time: '20:12', cents: 800 });
  });

  it('reads no time from an empty cell', () => {
    const [row] = readExportRows(
      parseCsv(`${header}\r\n2026-11-05,,Spent,Wallet,,8.00,MYR,Food,,Kiosk,,x\r\n`),
      NOW,
    );
    expect(row).toMatchObject({ date: '2026-11-05', time: null, payee: 'Kiosk' });
  });

  it("says so for a time it can't read, and adds nothing from that line", () => {
    const rows = readExportRows(
      parseCsv(
        `${header}\r\n` +
          '2026-11-05,8.12pm,Spent,Wallet,,8.00,MYR,Food,,Kiosk,,x\r\n' +
          '2026-11-05,24:00,Spent,Wallet,,8.00,MYR,Food,,Kiosk,,x\r\n',
      ),
      NOW,
    );
    expect(rows).toEqual([
      { row: 2, problem: 'Can\'t read the time "8.12pm"' },
      { row: 3, problem: 'Can\'t read the time "24:00"' },
    ]);
  });

  it('reads a file made before entries had times, as it always did', () => {
    const old =
      'Date,Kind,Account,To account,Amount,Currency,Category,Parent category,Payee,Note,Id\r\n' +
      '2026-11-05,Spent,Wallet,,8.00,MYR,Food,,Kiosk,Two,x\r\n' +
      '2026-01-03,Opening balance,Wallet,,100.00,MYR,,,,,y\r\n';
    const [spent, opening] = readExportRows(parseCsv(old), NOW);
    expect(spent).toMatchObject({
      kind: 'expense',
      date: '2026-11-05',
      time: null,
      account: 'Wallet',
      cents: 800,
      category: 'Food',
      payee: 'Kiosk',
      note: 'Two',
    });
    expect(opening).toMatchObject({ kind: 'opening', account: 'Wallet', cents: 10_000 });
  });

  it('an opening balance has no time', () => {
    const [row] = readExportRows(
      parseCsv(`${header}\r\n2026-01-03,,Opening balance,Wallet,,100.00,MYR,,,,,y\r\n`),
      NOW,
    );
    expect(row).toMatchObject({ kind: 'opening', cents: 10_000, time: null });
  });
});
