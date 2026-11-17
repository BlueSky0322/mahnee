// The month start day, end to end against the real Worker and a fresh local database
// (owner decision D7, "Every monthly figure"): a month's totals, its days, Tidy up, its
// budgets and what each earlier month left, and the last 12 months all run from the day
// the person's month starts on, worked out from their saved setting each time they're read
// (nothing stored is rewritten). A period is named for the month holding most of its
// days: from the 25th, "November" is October 25 to November 24. Payday follows the
// scheduled pay's day; with the pay stopped, the month goes back to its date.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES, OTHER_EXPENSE_ID } from '../../shared/categories';
import type { LocalWorker } from './local-worker';
import { startLocalWorker } from './local-worker';

let api: LocalWorker;
let n = 0;
const person = (name: string) => `${name}${++n}@example.com`;

beforeAll(async () => {
  api = await startLocalWorker();
}, 180_000);

afterAll(() => api?.stop(), 30_000);

let ids = 0;
/** A fresh row id, as the app makes them: 16 hex characters */
const rowId = () => (++ids).toString(16).padStart(16, 'f');
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [food, transport, salary] = [id('Food'), id('Transport'), id('Salary')];

/** Sends ledger changes as `who`, each saved or the test stops there */
async function send(who: string, changes: unknown[]) {
  const res = await api.call(who, 'POST', '/api/changes', {
    changes,
    ids: changes.map(() => rowId()),
  });
  expect(res).toEqual({ status: 200, data: { ok: true } });
}
async function save(who: string, settings: Record<string, unknown>) {
  const res = await api.call(who, 'PATCH', '/api/me', { settings });
  expect(res.status).toBe(200);
}
async function summary(who: string, month: string) {
  const res = await api.call(who, 'GET', `/api/summary?month=${month}`);
  expect(res.status).toBe(200);
  return res.data;
}

const spend = (
  accountId: string,
  date: string,
  amountCents: number,
  more: Record<string, unknown> = {},
) => ({
  op: 'addTransaction',
  transaction: {
    id: rowId(),
    kind: 'expense',
    accountId,
    amountCents,
    categoryId: food,
    payee: null,
    note: null,
    date,
    ...more,
  },
});

/**
 * A person with a wallet and spending either side of each edge of October 25 to
 * November 24, 2025: 1.00 on Oct 24, 2.00 on Oct 25, 4.00 on Nov 24, 8.00 on Nov 25, and
 * RM 30 of pay on Nov 1. In Other: 16.00 on Sep 24 and 32.00 on Sep 25.
 */
async function withEdges() {
  const me = person('me');
  const wallet = rowId();
  await send(me, [
    { op: 'addAccount', account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 0 } },
    spend(wallet, '2025-10-24', 100),
    spend(wallet, '2025-10-25', 200),
    spend(wallet, '2025-11-24', 400, { payee: 'Kopi' }),
    spend(wallet, '2025-11-25', 800),
    spend(wallet, '2025-11-01', 3_000, { kind: 'income', categoryId: salary }),
    spend(wallet, '2025-09-24', 1_600, { categoryId: OTHER_EXPENSE_ID }),
    spend(wallet, '2025-09-25', 3_200, { categoryId: OTHER_EXPENSE_ID }),
  ]);
  return { me, wallet };
}

describe('a month starting on a day other than the 1st', () => {
  it('sums the month from its start day to the day before the next, with its days and Tidy up', async () => {
    const { me } = await withEdges();
    await save(me, { monthStartDay: 25 });
    expect(await summary(me, '2025-11')).toEqual({
      month: '2025-11',
      firstDay: '2025-10-25',
      lastDay: '2025-11-24',
      incomeCents: 3_000,
      spentCents: 600,
      leftCents: 2_400,
      spentByCategory: [{ categoryId: food, cents: 600, entries: 2 }],
      incomeByCategory: [{ categoryId: salary, cents: 3_000, entries: 1 }],
      spentByDay: [
        { date: '2025-10-25', cents: 200 },
        { date: '2025-11-24', cents: 400 },
      ],
      // From the start of the period before (September 25 to October 24) to this one's end
      tidyUp: { from: '2025-09-25', entries: 1, categoryIds: [OTHER_EXPENSE_ID] },
    });
    // The days either side are in the periods either side
    expect(await summary(me, '2025-10')).toMatchObject({
      firstDay: '2025-09-25',
      lastDay: '2025-10-24',
      spentCents: 3_300,
    });
    expect(await summary(me, '2025-12')).toMatchObject({
      firstDay: '2025-11-25',
      lastDay: '2025-12-24',
      spentCents: 800,
    });
  });

  it('is the calendar month from the 1st, as before, and says so', async () => {
    const { me } = await withEdges();
    expect(await summary(me, '2025-11')).toMatchObject({
      firstDay: '2025-11-01',
      lastDay: '2025-11-30',
      spentCents: 1_200,
      tidyUp: { from: '2025-10-01', entries: 0 },
    });
  });

  it('starts each month on its last day with Last day of the month', async () => {
    const { me } = await withEdges();
    await save(me, { monthStartDay: 31 });
    expect(await summary(me, '2025-11')).toMatchObject({
      firstDay: '2025-10-31',
      lastDay: '2025-11-29',
      spentCents: 1_200,
    });
    // February has 28 days in 2026: March starts on its last
    expect(await summary(me, '2026-03')).toMatchObject({
      firstDay: '2026-02-28',
      lastDay: '2026-03-30',
    });
  });

  it('re-buckets at read time: back on the 1st, the same entries add up as before', async () => {
    const { me } = await withEdges();
    const before = await summary(me, '2025-11');
    await save(me, { monthStartDay: 25 });
    expect(await summary(me, '2025-11')).toMatchObject({ spentCents: 600 });
    await save(me, { monthStartDay: 1 });
    expect(await summary(me, '2025-11')).toEqual(before);
  });

  it("follows each person's own setting", async () => {
    const { me } = await withEdges();
    const { me: someoneElse } = await withEdges();
    await save(someoneElse, { monthStartDay: 25 });
    expect(await summary(me, '2025-11')).toMatchObject({
      firstDay: '2025-11-01',
      spentCents: 1_200,
    });
    expect(await summary(someoneElse, '2025-11')).toMatchObject({
      firstDay: '2025-10-25',
      spentCents: 600,
    });
  });
});

describe('a month starting on payday', () => {
  it("runs from the pay's day, and goes back to its date once the pay stops", async () => {
    const { me, wallet } = await withEdges();
    const pay = rowId();
    await send(me, [
      {
        op: 'addRecurring',
        recurring: {
          id: pay,
          kind: 'income',
          accountId: wallet,
          toAccountId: null,
          amountCents: 500_000,
          categoryId: salary,
          payee: 'Acme',
          schedule: 'monthly',
          day: 20,
          startDate: '2025-01-20',
        },
      },
    ]);
    await save(me, { monthStartMode: 'payday', monthStartPayId: pay });
    // From the 20th, named for the month it ends in
    expect(await summary(me, '2025-11')).toMatchObject({
      firstDay: '2025-10-20',
      lastDay: '2025-11-19',
      spentCents: 300,
    });
    // The pay moved to the 25th moves the month with it
    await send(me, [{ op: 'updateRecurring', id: pay, day: 25, nextDue: '2025-12-25' }]);
    expect(await summary(me, '2025-11')).toMatchObject({
      firstDay: '2025-10-25',
      lastDay: '2025-11-24',
    });
    await send(me, [{ op: 'archiveRecurring', id: pay, archived: true }]);
    expect(await summary(me, '2025-11')).toMatchObject({
      firstDay: '2025-11-01',
      lastDay: '2025-11-30',
      spentCents: 1_200,
    });
  });
});

describe('a month starting on a pay late in the month', () => {
  async function onPay(day: number) {
    const { me, wallet } = await withEdges();
    const pay = rowId();
    await send(me, [
      {
        op: 'addRecurring',
        recurring: {
          id: pay,
          kind: 'income',
          accountId: wallet,
          toAccountId: null,
          amountCents: 500_000,
          categoryId: salary,
          payee: 'Acme',
          schedule: 'monthly',
          day,
          startDate: '2025-01-01',
        },
      },
    ]);
    await save(me, { monthStartMode: 'payday', monthStartPayId: pay });
    return me;
  }

  it('on the 31st, starts each month on its last day', async () => {
    const me = await onPay(31);
    expect(await summary(me, '2025-11')).toMatchObject({
      firstDay: '2025-10-31',
      lastDay: '2025-11-29',
    });
  });

  it('on the 30th, starts February on its last day', async () => {
    const me = await onPay(30);
    expect(await summary(me, '2026-03')).toMatchObject({
      firstDay: '2026-02-28',
      lastDay: '2026-03-29',
    });
  });
});

describe('the last 12 months', () => {
  it('are 12 periods ending at the one asked, each summed as its own month is', async () => {
    const { me } = await withEdges();
    await save(me, { monthStartDay: 25 });
    const res = await api.call(me, 'GET', '/api/summary/trend?month=2025-11');
    expect(res.status).toBe(200);
    const months = res.data.months as Record<string, unknown>[];
    expect(months.map((m) => m.month)).toEqual([
      '2024-12',
      '2025-01',
      '2025-02',
      '2025-03',
      '2025-04',
      '2025-05',
      '2025-06',
      '2025-07',
      '2025-08',
      '2025-09',
      '2025-10',
      '2025-11',
    ]);
    expect(months[0]).toMatchObject({ firstDay: '2024-11-25', lastDay: '2024-12-24' });
    expect(months[9]).toMatchObject({
      firstDay: '2025-08-25',
      lastDay: '2025-09-24',
      spentCents: 1_600,
    });
    expect(months[10]).toMatchObject({
      firstDay: '2025-09-25',
      lastDay: '2025-10-24',
      spentCents: 3_300,
    });
    // The month itself, as GET /api/summary sums it, without its days, Tidy up and budgets
    const { spentByDay: _days, tidyUp: _tidy, ...month } = await summary(me, '2025-11');
    expect(months[11]).toEqual(month);
  });
});

describe('budgets', () => {
  const budget = (fromMonth: string, amountCents: number, carryOver: boolean) => ({
    op: 'setBudget',
    categoryId: transport,
    fromMonth,
    amountCents,
    carryOver,
  });

  it('carry over what each period left, not each calendar month', async () => {
    const { me, wallet } = await withEdges();
    await save(me, { monthStartDay: 25 });
    await send(me, [
      budget('2025-10', 10_000, true),
      // October (September 25 to October 24)
      spend(wallet, '2025-10-20', 3_000, { categoryId: transport }),
      // November (October 25 to November 24)
      spend(wallet, '2025-10-26', 5_000, { categoryId: transport }),
    ]);
    const november = await summary(me, '2025-11');
    expect(november.budgets).toEqual([
      { categoryId: transport, amountCents: 10_000, carryOver: true, lastMonthLeftCents: 7_000 },
    ]);
    expect(november.spentByCategory).toContainEqual({
      categoryId: transport,
      cents: 5_000,
      entries: 1,
    });
    expect((await summary(me, '2025-12')).budgets).toEqual([
      { categoryId: transport, amountCents: 10_000, carryOver: true, lastMonthLeftCents: 12_000 },
    ]);
  });

  it('keep the month they were set from when the start day changes, and the chain follows the new days', async () => {
    const { me, wallet } = await withEdges();
    await send(me, [
      budget('2025-10', 10_000, true),
      spend(wallet, '2025-10-20', 3_000, { categoryId: transport }),
      spend(wallet, '2025-10-26', 5_000, { categoryId: transport }),
    ]);
    const kept = () =>
      api.sql(
        'SELECT category_id, from_month, amount_cents, carry_over FROM budgets WHERE email = ?',
        me,
      );
    const row = await kept();
    // From the 1st: October spent 80.00 of 100.00
    const calendar = await summary(me, '2025-11');
    expect(calendar.budgets).toEqual([
      { categoryId: transport, amountCents: 10_000, carryOver: true, lastMonthLeftCents: 2_000 },
    ]);
    // From the 25th: October (September 25 to October 24) spent 30.00, November has the 50.00
    await save(me, { monthStartDay: 25 });
    const november = await summary(me, '2025-11');
    expect(november.budgets).toEqual([
      { categoryId: transport, amountCents: 10_000, carryOver: true, lastMonthLeftCents: 7_000 },
    ]);
    expect(november.spentByCategory).toContainEqual({
      categoryId: transport,
      cents: 5_000,
      entries: 1,
    });
    // Nothing kept was rewritten, and back on the 1st every figure is as it was
    expect(await kept()).toEqual(row);
    await save(me, { monthStartDay: 1 });
    expect(await summary(me, '2025-11')).toEqual(calendar);
  });

  it('set from December is in force from December, whichever day the month starts', async () => {
    const { me } = await withEdges();
    await save(me, { monthStartDay: 25 });
    await send(me, [budget('2025-12', 10_000, false)]);
    for (const start of [25, 1]) {
      await save(me, { monthStartDay: start });
      expect(await summary(me, '2025-11')).not.toHaveProperty('budgets');
      expect((await summary(me, '2025-12')).budgets).toEqual([
        { categoryId: transport, amountCents: 10_000, carryOver: false, lastMonthLeftCents: 0 },
      ]);
    }
  });

  it('carry over to the cent across the edges, an overspent month carrying what it overspent', async () => {
    const { me, wallet } = await withEdges();
    await save(me, { monthStartDay: 25 });
    await send(me, [
      budget('2025-10', 10_000, true),
      {
        op: 'setBudget',
        categoryId: food,
        fromMonth: '2025-10',
        amountCents: 1_000,
        carryOver: true,
      },
      // October (September 25 to October 24): 3.33 and 10.01 on Transport
      spend(wallet, '2025-09-25', 333, { categoryId: transport }),
      spend(wallet, '2025-10-24', 1_001, { categoryId: transport }),
      // November: 49.99 on Transport
      spend(wallet, '2025-10-25', 4_999, { categoryId: transport }),
      // October on Food: the 1.00 on Oct 24 and 4.01 more, of 10.00
      spend(wallet, '2025-10-01', 401),
    ]);
    const lines = (await summary(me, '2025-11')).budgets as {
      categoryId: string;
      lastMonthLeftCents: number;
    }[];
    expect(lines.find((b) => b.categoryId === transport)!.lastMonthLeftCents).toBe(8_666);
    // Food: 10.00 less October's 1.00 and 4.01 = 4.99 left
    expect(lines.find((b) => b.categoryId === food)!.lastMonthLeftCents).toBe(499);
    const december = (await summary(me, '2025-12')).budgets as typeof lines;
    // Transport: 100.00 + 86.66 - 49.99
    expect(december.find((b) => b.categoryId === transport)!.lastMonthLeftCents).toBe(13_667);
    // Food: 10.00 + 4.99 - 6.00 (2.00 on Oct 25, 4.00 on Nov 24) = 8.99
    expect(december.find((b) => b.categoryId === food)!.lastMonthLeftCents).toBe(899);
  });

  it('carry an overspent month into the next as less to spend', async () => {
    const { me, wallet } = await withEdges();
    await save(me, { monthStartDay: 25 });
    await send(me, [
      budget('2025-10', 1_000, true),
      spend(wallet, '2025-10-24', 1_501, { categoryId: transport }),
    ]);
    expect((await summary(me, '2025-11')).budgets).toEqual([
      { categoryId: transport, amountCents: 1_000, carryOver: true, lastMonthLeftCents: -501 },
    ]);
  });

  // A smoke test on the real clock: whether the period after this calendar month is today's
  // depends on the date it runs (from the 15th on, with tomorrow in UTC); the rule itself is
  // pinned with a fixed clock in shared/period.test.ts
  it('can be set from the period today is in, and not the one after', async () => {
    const { me } = await withEdges();
    await save(me, { monthStartDay: 16 });
    // Tomorrow in UTC, the latest a person's own today can be
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    // From the 16th, a period is named for the month it ends in: the 16th on is next month's
    const monthAfter = (month: string) => {
      const [y, m] = month.split('-').map(Number);
      return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    };
    const current =
      Number(tomorrow.slice(8)) >= 16 ? monthAfter(tomorrow.slice(0, 7)) : tomorrow.slice(0, 7);
    const after = monthAfter(current);
    await send(me, [budget(current, 10_000, false)]);
    expect((await summary(me, current)).budgets).toEqual([
      { categoryId: transport, amountCents: 10_000, carryOver: false, lastMonthLeftCents: 0 },
    ]);
    const refused = await api.call(me, 'POST', '/api/changes', {
      changes: [budget(after, 10_000, false)],
      ids: [rowId()],
    });
    expect(refused.status).toBe(400);
  });
});

describe('the last month there is', () => {
  // A month's days can run into the month after it, so the last month that can be asked
  // for is 9998-12; 9999-12 is refused as any month that isn't one is, never a failure
  it.each([1, 15, 16, 31])(
    'refuses 9999-12 and answers 9998-12, the month starting on day %i',
    async (start) => {
      const me = person('me');
      await save(me, { monthStartDay: start });
      for (const path of ['/api/summary?month=9999-12', '/api/summary/trend?month=9999-12']) {
        expect(await api.call(me, 'GET', path)).toEqual({
          status: 400,
          data: { error: 'Give a month from 2000, like 2026-11' },
        });
      }
      expect((await api.call(me, 'GET', '/api/summary?month=9998-12')).status).toBe(200);
      expect((await api.call(me, 'GET', '/api/summary/trend?month=9998-12')).status).toBe(200);
    },
  );
});
