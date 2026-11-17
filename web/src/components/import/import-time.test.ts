import { describe, expect, test } from 'vitest';
import type { Account } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { parseCsv, readExportRows } from '@shared/csv-import';
import { EXPORT_COLUMNS } from '@shared/export';
import { planExport } from './import-plan';

// Importing Mahnee's own export brings each entry's time with it, when the file has one
// (owner decision D20: "import reads it if present"). Names and figures are made up.

const wallet: Account = {
  id: 'a'.repeat(16),
  name: 'Wallet',
  kind: 'cash',
  currency: 'MYR',
  openingCents: 0,
  balanceCents: 0,
  position: 0,
  archived: false,
};
const categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
const NOW = Date.UTC(2026, 10, 6);

const planned = (file: string) =>
  planExport(readExportRows(parseCsv(file), NOW), [wallet], categories, [], '2026-11-06').rows.map(
    (r) => r.transaction,
  );

describe('importing an export with times', () => {
  test("each entry keeps the file's time, and one with none has none", () => {
    const [timed, plain] = planned(
      `${EXPORT_COLUMNS.join(',')}\r\n` +
        '2026-11-05,20:12,Spent,Wallet,,8.00,MYR,Food,,Kiosk,,x\r\n' +
        '2026-11-04,,Spent,Wallet,,5.00,MYR,Food,,Stall,,y\r\n',
    );
    expect(timed).toMatchObject({ date: '2026-11-05', time: '20:12', payee: 'Kiosk' });
    expect(plain).toMatchObject({ date: '2026-11-04', payee: 'Stall' });
    expect(plain?.time ?? null).toBeNull();
  });

  test('a file from before times reads with none', () => {
    const [only] = planned(
      'Date,Kind,Account,To account,Amount,Currency,Category,Parent category,Payee,Note,Id\r\n' +
        '2026-11-05,Spent,Wallet,,8.00,MYR,Food,,Kiosk,,x\r\n',
    );
    expect(only).toMatchObject({ date: '2026-11-05', payee: 'Kiosk', amountCents: 800 });
    expect(only?.time ?? null).toBeNull();
  });
});
