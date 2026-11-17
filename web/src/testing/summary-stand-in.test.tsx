// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import type { Transaction } from '@shared/api';
import { PENDING_CHANGES_HEADER } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { fakeServer, renderApp, setupAppTests } from './app';

// The stand-in's GET /api/summary keeps the real one's contract (worker/ledger/summary.ts,
// worker/test/api.test.ts "a month's totals"): spending by day, entries per category with
// a lone entry's payee, and Tidy up's count since the first of the month before, so
// screen tests see what the Worker would answer.

setupAppTests();

const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, TRANSPORT, OTHER, SALARY] = ['Food', 'Transport', 'Other', 'Salary'].map(id);
const ODD_JOBS = 'f'.repeat(16);
const [WALLET, BANK] = ['a'.repeat(16), 'b'.repeat(16)];

let n = 0;
const entry = (t: Partial<Transaction>): Transaction => ({
  id: (++n).toString(16).padStart(16, 'c'),
  kind: 'expense',
  accountId: WALLET,
  toAccountId: null,
  amountCents: 100,
  categoryId: FOOD,
  payee: null,
  note: null,
  date: '2025-10-14',
  createdAt: n,
  ...t,
});

async function read(path: string) {
  const res = await fetch(path, { headers: { [PENDING_CHANGES_HEADER]: '' } });
  expect(res.status).toBe(200);
  return res.json();
}
const summaryOf = (month: string) => read(`/api/summary?month=${month}`);

describe("the stand-in's month totals", () => {
  test('answer days, entries, payees and Tidy up as the Worker does', async () => {
    const server = fakeServer();
    server.categories = [
      ...DEFAULT_CATEGORIES.map((c) => ({ ...c })),
      {
        id: ODD_JOBS,
        name: 'Odd jobs',
        kind: 'expense',
        parentId: OTHER,
        position: 0,
        archived: false,
      },
    ];
    server.transactions = [
      entry({ amountCents: 800, date: '2025-10-02', payee: 'Kopi Corner' }),
      entry({ amountCents: 200, date: '2025-10-02', payee: 'Kopi Corner' }),
      entry({ amountCents: 120, date: '2025-10-04', categoryId: TRANSPORT, payee: 'Grab' }),
      entry({ amountCents: 5_000, kind: 'income', categoryId: SALARY, payee: 'Acme' }),
      entry({ amountCents: 40_000, kind: 'transfer', toAccountId: BANK, categoryId: null }),
      // Tidy up: the first of September and the end of October count
      entry({ categoryId: OTHER, date: '2025-09-01' }),
      entry({ categoryId: ODD_JOBS, date: '2025-10-31' }),
      entry({ categoryId: OTHER, date: '2025-08-31' }),
      entry({ categoryId: OTHER, date: '2025-11-01' }),
    ];
    renderApp(server);

    const october = await summaryOf('2025-10');
    expect(october).toEqual({
      month: '2025-10',
      firstDay: '2025-10-01',
      lastDay: '2025-10-31',
      incomeCents: 5_000,
      spentCents: 1_220,
      leftCents: 3_780,
      spentByCategory: [
        { categoryId: FOOD, cents: 1_000, entries: 2 },
        { categoryId: TRANSPORT, cents: 120, entries: 1, payee: 'Grab' },
        { categoryId: ODD_JOBS, cents: 100, entries: 1 },
      ],
      incomeByCategory: [{ categoryId: SALARY, cents: 5_000, entries: 1, payee: 'Acme' }],
      spentByDay: [
        { date: '2025-10-02', cents: 1_000 },
        { date: '2025-10-04', cents: 120 },
        { date: '2025-10-31', cents: 100 },
      ],
      tidyUp: { from: '2025-09-01', entries: 2, categoryIds: [OTHER, ODD_JOBS] },
    });
    // A month with nothing in it still says where Tidy up starts
    expect(await summaryOf('2025-07')).toMatchObject({
      spentByDay: [],
      tidyUp: { from: '2025-06-01', entries: 0, categoryIds: [OTHER, ODD_JOBS] },
    });

    // The 12 months carry the same rows, lone payee included, and never the month's own
    // days or Tidy up
    const trend = await read('/api/summary/trend?month=2025-10');
    expect(trend.months).toHaveLength(12);
    const { spentByDay: _days, tidyUp: _tidyUp, ...octoberTotals } = october;
    expect(trend.months[11]).toEqual(octoberTotals);
    expect(trend.months[10]).toEqual({
      month: '2025-09',
      firstDay: '2025-09-01',
      lastDay: '2025-09-30',
      incomeCents: 0,
      spentCents: 100,
      leftCents: -100,
      spentByCategory: [{ categoryId: OTHER, cents: 100, entries: 1 }],
      incomeByCategory: [],
    });
    for (const month of trend.months) {
      expect('spentByDay' in month).toBe(false);
      expect('tidyUp' in month).toBe(false);
    }
  });
});
