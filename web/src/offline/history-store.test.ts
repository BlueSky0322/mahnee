import 'fake-indexeddb/auto';
import { describe, expect, test } from 'vitest';
import type { Transaction } from '@shared/api';
import type { Coverage } from './history-store';
import { changeEntries, keepAccountPage, readCoverage, readEntries } from './history-store';

// The history kept on the device, as two tabs write it: what's written never goes back

const EMAIL = 'ryan@example.com';
const CASH = 'a'.repeat(16);
const mine = () => true;

const entry = (n: number, t: Partial<Transaction> = {}): Transaction => ({
  id: n.toString(16).padStart(16, '0'),
  kind: 'expense',
  accountId: CASH,
  toAccountId: null,
  amountCents: 100,
  categoryId: null,
  payee: `Shop ${n}`,
  note: null,
  date: '2026-09-01',
  createdAt: n,
  ...t,
});

const coverage = (rows: number, pass = 1): Coverage => ({
  email: EMAIL,
  accountId: CASH,
  next: `cursor-${rows}`,
  oldest: '2026-09-01',
  newest: null,
  complete: false,
  held: false,
  rows,
  pass,
  verifiedAt: null,
  currency: 'MYR',
});

describe('two tabs writing', () => {
  test('a slower tab’s earlier progress never moves the download back', async () => {
    const page = { transactions: [entry(1)], nextBefore: 'x' };
    await keepAccountPage(EMAIL, CASH, null, page, coverage(400), mine, 0);
    await keepAccountPage(EMAIL, CASH, null, page, coverage(200), mine, 0);
    expect((await readCoverage(EMAIL)).map((c) => c.rows)).toEqual([400]);
    // A new pass from the top starts again, though
    await keepAccountPage(EMAIL, CASH, null, page, coverage(200, 2), mine, 0);
    expect((await readCoverage(EMAIL)).map((c) => c.rows)).toEqual([200]);
  });

  test('a page fetched before an entry was changed here leaves the change', async () => {
    const asked = Date.now();
    await changeEntries(EMAIL, new Map([[entry(2).id, entry(2, { payee: 'Changed here' })]]), mine);
    await keepAccountPage(
      EMAIL,
      CASH,
      null,
      { transactions: [entry(2)], nextBefore: null },
      null,
      mine,
      asked - 1,
    );
    const held = await readEntries(EMAIL, { by: 'account', accountId: CASH });
    expect(held.find((t) => t.id === entry(2).id)?.payee).toBe('Changed here');
  });
});
