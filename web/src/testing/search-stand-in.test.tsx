// @vitest-environment jsdom
import { describe, expect, test } from 'vitest';
import type { Transaction } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from './app';
import { fakeServer, renderApp, setupAppTests } from './app';

// The stand-in's GET /api/search keeps the real one's contract (worker/ledger/read.ts,
// worker/test/api.test.ts "searching transactions"): the kind filter and its refusals,
// what matches beyond each page and on its last day, and how many match outside the days
// asked for, so screen tests see what the Worker would answer.

setupAppTests();

const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [WALLET, BANK, VISA] = ['a', 'b', 'c'].map((c) => c.repeat(16));

/**
 * The Worker spec's history: one on each day from 1 to 9 September 2025
 *   1 Wallet 8.00 Food "Kopi Corner"; 2 Bank 8.50 Food, note "kopi with Mei"; 3 Visa 80.00 Transport;
 *   4 Wallet 8.00 Other; 5 Bank 1,000.00 Salary; 6 Bank to Wallet 50.00 transfer;
 *   7 Visa 12.00 Other "KOPI KING"; 8 Wallet 800.00 Other; 9 Bank 20.00 Other income "8 refund"
 */
function withHistory(): { server: FakeServer; t: string[] } {
  const server = fakeServer();
  for (const [i, account] of [WALLET, BANK, VISA].entries()) {
    server.accounts.push({
      id: account,
      name: ['Wallet', 'Bank', 'Visa'][i],
      kind: 'cash',
      currency: 'MYR',
      openingCents: 0,
      position: i,
      archived: false,
    });
  }
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  const rows: Partial<Transaction>[] = [
    { amountCents: 800, payee: 'Kopi Corner' },
    { accountId: BANK, amountCents: 850, note: 'kopi with Mei' },
    { accountId: VISA, amountCents: 8_000, categoryId: id('Transport') },
    { amountCents: 800, categoryId: id('Other') },
    { kind: 'income', accountId: BANK, amountCents: 100_000, categoryId: id('Salary') },
    {
      kind: 'transfer',
      accountId: BANK,
      toAccountId: WALLET,
      amountCents: 5_000,
      categoryId: null,
    },
    { accountId: VISA, amountCents: 1_200, categoryId: id('Other'), payee: 'KOPI KING' },
    { amountCents: 80_000, categoryId: id('Other') },
    {
      kind: 'income',
      accountId: BANK,
      amountCents: 2_000,
      categoryId: id('Other income'),
      note: '8 refund',
    },
  ];
  const t = rows.map((row, i) => {
    const x: Transaction = {
      id: (i + 1).toString(16).padStart(16, 'd'),
      kind: 'expense',
      accountId: WALLET,
      toAccountId: null,
      amountCents: 100,
      categoryId: id('Food'),
      payee: null,
      note: null,
      date: `2025-09-0${i + 1}`,
      createdAt: i + 1,
      ...row,
    };
    server.transactions.push(x);
    return x.id;
  });
  renderApp(server, '/?settings');
  return { server, t };
}

async function search(query: string) {
  const res = await fetch(`/api/search?${query}`);
  return { status: res.status, data: await res.json() };
}
const ids = async (query: string) =>
  ((await search(query)).data.transactions as { id: string }[]).map((x) => x.id);
const none = { entries: 0, spentCents: 0, receivedCents: 0 };

describe("the stand-in's search", () => {
  test('filters by kind and refuses kinds it does not know', async () => {
    const { t } = withHistory();
    expect(await ids('kind=expense')).toEqual([t[7], t[6], t[3], t[2], t[1], t[0]]);
    expect(await ids('kind=income')).toEqual([t[8], t[4]]);
    expect(await ids('kind=transfer')).toEqual([t[5]]);
    expect(await ids('kind=expense,income')).toEqual([...t].reverse().filter((x) => x !== t[5]));
    for (const query of ['kind=spending', 'kind=income,income']) {
      expect(await search(query)).toEqual({
        status: 400,
        data: { error: 'Give kinds from expense, income and transfer' },
      });
    }
  });

  test('says what matches beyond each page and on its last day, as the Worker does', async () => {
    const { server } = withHistory();
    const last = await search('');
    expect([last.data.rest, last.data.restOfLastDay]).toEqual([none, null]);
    // Three more on the 7th, newer that day than KOPI KING
    for (let i = 0; i < 3; i++) {
      server.transactions.push({
        ...server.transactions[0],
        id: (i + 1).toString(16).padStart(16, 'e'),
        amountCents: 100,
        date: '2025-09-07',
        createdAt: 100 + i,
      });
    }
    const res = await search('limit=3');
    expect(res.data.rest).toEqual({
      entries: 9,
      spentCents: 200 + 1_200 + 800 + 8_000 + 850 + 800,
      receivedCents: 100_000,
    });
    expect(res.data.restOfLastDay).toEqual({
      date: '2025-09-07',
      entries: 3,
      spentCents: 1_400,
      receivedCents: 0,
    });
    const other = await search(`category=${id('Other')}&limit=1`);
    expect([other.data.rest, other.data.restOfLastDay]).toEqual([
      { entries: 2, spentCents: 1_200 + 800, receivedCents: 0 },
      { date: '2025-09-08', ...none },
    ]);
  });

  test('says how many match outside the days asked for, on the first page only', async () => {
    withHistory();
    const days = 'from=2025-09-03&to=2025-09-07';
    expect((await search(days)).data.elsewhere).toBe(4);
    expect((await search(`q=kopi&${days}`)).data.elsewhere).toBe(2);
    expect((await search('from=2025-09-08')).data.elsewhere).toBe(7);
    expect((await search('to=2025-09-01')).data.elsewhere).toBe(8);
    expect('elsewhere' in (await search('q=kopi')).data).toBe(false);
    const first = await search(`${days}&limit=1`);
    const second = await search(`${days}&limit=1&before=${first.data.nextBefore}`);
    expect(second.status).toBe(200);
    expect('elsewhere' in second.data).toBe(false);
  });
});
