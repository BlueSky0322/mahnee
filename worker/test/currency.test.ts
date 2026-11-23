// The home currency, end to end against the real Worker, its local queue and a fresh local
// database (owner decisions D2 to D5). Changing it is saved at once; every amount is then
// converted in the background through the mahnee-reconvert queue: each entry at its own
// day's rate, opening balances, budgets and scheduled items at the rate on the day of the
// switch. Each keeps what it was (currency, amount, rate), so changing back restores the
// exact amounts. Writes wait (503, kept by the app's outbox) until it's done, and a change
// typed in the old currency is converted when it comes. One amount past a limit refuses the
// whole change, nothing converted, and says which limit. A failed run is tried again.
//
// Rates come from the stand-in services (local-worker.ts), never the real ones. Each test
// has days of its own, so the rates the Worker keeps from other tests never get in the way.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES } from '../../shared/categories';
import { convertCents } from '../../shared/rates';
import type { LocalWorker } from './local-worker';
import { startLocalWorker } from './local-worker';

let api: LocalWorker;
let n = 0;
const person = (name: string) => `${name}${++n}@example.com`;

let ids = 0;
/** A fresh row id, as the app makes them: 16 hex characters */
const rowId = () => (++ids).toString(16).padStart(16, '6');
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [FOOD, BILLS] = [id('Food'), id('Bills')];

/** Today's rates, the same in every test: the Worker keeps them for hours */
const TODAY = { USD: 0.25, SGD: 0.3, THB: 7.5, IDR: 3500, JPY: 33, ZAR: 3.9 };

beforeAll(async () => {
  api = await startLocalWorker();
  for (const [to, rate] of Object.entries(TODAY)) api.rates.set('MYR', to, rate);
}, 180_000);

afterAll(() => api?.stop(), 30_000);

/** The 20th of next month, a bill's next due date within the year allowed */
const nextTwentieth = () => {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 20))
    .toISOString()
    .slice(0, 10);
};

let days = 0;
/** A day in 2025 no other test uses, so its rates are this test's own */
const freshDay = () => {
  const at = Date.UTC(2025, 0, 1) + days++ * 24 * 60 * 60 * 1000;
  return new Date(at).toISOString().slice(0, 10);
};

async function send(who: string, changes: unknown[], currencies?: (string | null)[]) {
  return api.call(who, 'POST', '/api/changes', {
    changes,
    ids: changes.map(() => rowId()),
    ...(currencies && { currencies }),
  });
}

async function saved(who: string, changes: unknown[], currencies?: (string | null)[]) {
  expect(await send(who, changes, currencies)).toEqual({ status: 200, data: { ok: true } });
}

const spend = (accountId: string, amountCents: number, date: string, more = {}) => ({
  op: 'addTransaction',
  transaction: {
    id: rowId(),
    kind: 'expense',
    accountId,
    toAccountId: null,
    amountCents,
    categoryId: FOOD,
    payee: null,
    note: null,
    date,
    ...more,
  },
});

/** Someone with a wallet (opening RM 1,000.00), two entries on days of their own, a budget and a bill */
async function someone(name = 'me') {
  const who = person(name);
  const wallet = rowId();
  const [first, second] = [freshDay(), freshDay()];
  const a = spend(wallet, 1_234, first);
  const b = spend(wallet, 5_001, second);
  const bill = rowId();
  await saved(who, [
    {
      op: 'addAccount',
      account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 100_000 },
    },
    a,
    b,
    {
      op: 'setBudget',
      categoryId: FOOD,
      fromMonth: '2025-01',
      amountCents: 60_000,
      carryOver: false,
    },
    {
      op: 'addRecurring',
      recurring: {
        id: bill,
        kind: 'expense',
        accountId: wallet,
        toAccountId: null,
        amountCents: 18_937,
        categoryId: BILLS,
        payee: 'TNB',
        schedule: 'monthly',
        day: 20,
        startDate: '2025-01-20',
        nextDue: nextTwentieth(),
      },
    },
  ]);
  return {
    who,
    wallet,
    bill,
    entries: [
      { id: a.transaction.id, day: first, cents: 1_234 },
      { id: b.transaction.id, day: second, cents: 5_001 },
    ],
  };
}

const me = async (who: string) => {
  const res = await api.call(who, 'GET', '/api/me');
  expect(res.status).toBe(200);
  return res.data as {
    settings: { currency: string };
    conversion: { from: string; to: string; since: number; refused: string | null } | null;
  };
};

const change = (who: string, currency: string) =>
  api.call(who, 'PATCH', '/api/me', { settings: { currency } });

/** Waits until a conversion has finished, either way, and answers the profile then */
async function finished(who: string) {
  const until = Date.now() + 60_000;
  for (;;) {
    const profile = await me(who);
    if (profile.conversion == null || profile.conversion.refused != null) return profile;
    if (Date.now() > until) throw new Error('Still converting after a minute');
    await new Promise((r) => setTimeout(r, 200));
  }
}

const amountOf = async (who: string, table: string, where: string, ...params: string[]) =>
  (await api.sql(
    `SELECT ${table === 'accounts' ? 'opening_cents' : 'amount_cents'} AS cents, original_currency AS currency,
       original_cents AS originalCents, rate, rate_at AS rateAt
     FROM ${table} WHERE email = ? AND ${where}`,
    who,
    ...params,
  )) as {
    cents: number;
    currency: string | null;
    originalCents: number | null;
    rate: number | null;
  }[];

const entry = (who: string, entryId: string) => amountOf(who, 'transactions', 'id = ?', entryId);

describe('changing the home currency', () => {
  it('is saved at once, then every amount is converted at its own rate, keeping what it was', async () => {
    const { who, wallet, bill, entries } = await someone();
    const other = await someone('other');
    const [rateA, rateB] = [0.2, 0.22];
    api.rates.setOn(entries[0].day, 'MYR', 'USD', rateA);
    api.rates.setOn(entries[1].day, 'MYR', 'USD', rateB);

    const res = await change(who, 'USD');
    expect(res.status).toBe(200);
    expect(res.data.settings.currency).toBe('USD');
    expect(res.data.conversion).toEqual({
      from: 'MYR',
      to: 'USD',
      since: expect.any(Number),
      refused: null,
      // Nothing worked out yet, of every one of the person's entries
      progress: { done: 0, total: entries.length },
    });

    expect((await finished(who)).conversion).toBeNull();
    expect(await entry(who, entries[0].id)).toEqual([
      {
        cents: 247,
        currency: 'MYR',
        originalCents: 1_234,
        rate: rateA,
        rateAt: expect.any(Number),
      },
    ]);
    expect(await entry(who, entries[1].id)).toEqual([
      {
        cents: 1_100,
        currency: 'MYR',
        originalCents: 5_001,
        rate: rateB,
        rateAt: expect.any(Number),
      },
    ]);
    // Opening balances, budgets and scheduled items at the rate on the day of the switch
    expect(await amountOf(who, 'accounts', 'id = ?', wallet)).toEqual([
      expect.objectContaining({
        cents: 25_000,
        currency: 'MYR',
        originalCents: 100_000,
        rate: TODAY.USD,
      }),
    ]);
    expect(await amountOf(who, 'budgets', 'category_id = ?', FOOD)).toEqual([
      expect.objectContaining({ cents: 15_000, currency: 'MYR', originalCents: 60_000 }),
    ]);
    expect(await amountOf(who, 'recurring', 'id = ?', bill)).toEqual([
      expect.objectContaining({ cents: 4_734, currency: 'MYR', originalCents: 18_937 }),
    ]);
    // The balance the app reads is the converted one, and the account says its currency
    const ledger = await api.call(who, 'GET', '/api/accounts');
    expect(ledger.data.accounts).toEqual([
      expect.objectContaining({ id: wallet, currency: 'USD', balanceCents: 25_000 - 247 - 1_100 }),
    ]);

    // Someone else's are never touched
    expect((await me(other.who)).settings.currency).toBe('MYR');
    expect(await entry(other.who, other.entries[0].id)).toEqual([
      { cents: 1_234, currency: null, originalCents: null, rate: null, rateAt: null },
    ]);
  });

  it('changed back, restores the exact amounts', async () => {
    const { who, wallet, bill, entries } = await someone();
    api.rates.setOn(entries[0].day, 'MYR', 'JPY', 33.333);
    api.rates.setOn(entries[1].day, 'MYR', 'JPY', 31.7);
    expect((await change(who, 'JPY')).status).toBe(200);
    expect((await finished(who)).conversion).toBeNull();
    expect((await entry(who, entries[0].id))[0].cents).toBe(41_133);

    expect((await change(who, 'MYR')).status).toBe(200);
    const profile = await finished(who);
    expect(profile.conversion).toBeNull();
    expect(profile.settings.currency).toBe('MYR');
    for (const { id: entryId, cents } of entries) {
      expect(await entry(who, entryId)).toEqual([
        { cents, currency: null, originalCents: null, rate: null, rateAt: null },
      ]);
    }
    expect((await amountOf(who, 'accounts', 'id = ?', wallet))[0]).toMatchObject({
      cents: 100_000,
      currency: null,
    });
    expect((await amountOf(who, 'budgets', 'category_id = ?', FOOD))[0]).toMatchObject({
      cents: 60_000,
      currency: null,
    });
    expect((await amountOf(who, 'recurring', 'id = ?', bill))[0]).toMatchObject({
      cents: 18_937,
      currency: null,
    });
  });

  // An import that kept the balance changed the opening balance by what its older rows come
  // to (RM 10.01 here); its Undo after a change of currency puts the opening balance exactly
  // where it would be on its own: converted from what was typed, never from the converted sum
  // less the converted change (USD 250.00 off by a cent here: 252.51 less 2.50, not 250.00)
  async function keptByImport(name: string) {
    const who = person(name);
    const [bank, alone, mine] = [rowId(), rowId(), rowId()];
    const day = freshDay();
    await saved(who, [
      {
        op: 'addAccount',
        account: { id: bank, name: 'Bank', kind: 'bank', openingCents: 100_001 },
      },
      // The same opening balance, never imported into: what the other should come to
      {
        op: 'addAccount',
        account: { id: alone, name: 'Alone', kind: 'bank', openingCents: 100_001 },
      },
      {
        op: 'addImport',
        import: { id: mine, fileName: 'bank.csv', accountId: bank, addedCount: 2, skippedCount: 0 },
      },
      { op: 'updateAccount', id: bank, openingCents: 101_002, importId: mine },
      { ...spend(bank, 500, day), importId: mine },
      { ...spend(bank, 501, day), importId: mine },
    ]);
    return { who, bank, alone, mine, day };
  }
  const opening = async (who: string, accountId: string) =>
    (await amountOf(who, 'accounts', 'id = ?', accountId))[0];

  it('converts what an import changed an opening balance by, so Undo puts it back exactly', async () => {
    const { who, bank, alone, mine, day } = await keptByImport('kept');
    api.rates.setOn(day, 'MYR', 'USD', 0.25);
    await change(who, 'USD');
    expect((await finished(who)).conversion).toBeNull();
    expect(await opening(who, bank)).toMatchObject({ cents: 25_251, originalCents: 101_002 });
    expect(
      await api.sql(
        `SELECT opening_change_cents AS cents, opening_change_currency AS currency,
           opening_change_typed_cents AS typed FROM imports WHERE email = ? AND id = ?`,
        who,
        mine,
      ),
    ).toEqual([{ cents: 250, currency: 'MYR', typed: 1_001 }]);

    await saved(who, [{ op: 'undoImport', id: mine }]);
    const alone_ = await opening(who, alone);
    expect(alone_).toEqual({
      cents: 25_000,
      currency: 'MYR',
      originalCents: 100_001,
      rate: TODAY.USD,
      rateAt: expect.any(Number),
    });
    expect(await opening(who, bank)).toEqual(alone_);

    // And back to MYR, exactly as typed
    await change(who, 'MYR');
    expect((await finished(who)).conversion).toBeNull();
    expect(await opening(who, bank)).toMatchObject({ cents: 100_001, currency: null });
  });

  it('MYR to USD and back, then Undo of the import puts the opening balance back exactly', async () => {
    const { who, bank, mine, day } = await keptByImport('round');
    api.rates.setOn(day, 'MYR', 'USD', 0.25);
    await change(who, 'USD');
    expect((await finished(who)).conversion).toBeNull();
    await change(who, 'MYR');
    expect((await finished(who)).conversion).toBeNull();
    expect(await opening(who, bank)).toMatchObject({ cents: 101_002, currency: null });

    await saved(who, [{ op: 'undoImport', id: mine }]);
    expect(await opening(who, bank)).toEqual({
      cents: 100_001,
      currency: null,
      originalCents: null,
      rate: null,
      rateAt: null,
    });
  });

  it('an amount changed since is typed in the new currency, so it converts back at its rate', async () => {
    const { who, entries } = await someone();
    api.rates.setOn(entries[0].day, 'MYR', 'USD', 0.21);
    api.rates.setOn(entries[1].day, 'MYR', 'USD', 0.23);
    api.rates.setOn(entries[0].day, 'USD', 'MYR', 4.5);
    await change(who, 'USD');
    await finished(who);

    await saved(who, [{ op: 'updateTransaction', id: entries[0].id, amountCents: 500 }], ['USD']);
    expect(await entry(who, entries[0].id)).toEqual([
      { cents: 500, currency: null, originalCents: null, rate: null, rateAt: null },
    ]);

    await change(who, 'MYR');
    await finished(who);
    expect(await entry(who, entries[0].id)).toEqual([
      { cents: 2_250, currency: 'USD', originalCents: 500, rate: 4.5, rateAt: expect.any(Number) },
    ]);
    // The one left alone is exactly as typed
    expect((await entry(who, entries[1].id))[0]).toMatchObject({ cents: 5_001, currency: null });
  });

  it('holds writes while converting, and converts a change typed in the old currency', async () => {
    const { who, wallet, entries } = await someone();
    const day = freshDay();
    for (const [d, rate] of [
      [entries[0].day, 7.1],
      [entries[1].day, 7.2],
      [day, 7.4],
    ] as const) {
      api.rates.setOn(d, 'MYR', 'THB', rate);
    }
    const held = api.rates.hold('MYR', 'THB');
    expect((await change(who, 'THB')).status).toBe(200);
    await held.reached;

    // Made while converting: kept by the app and sent again
    const late = spend(wallet, 1_000, day);
    const waiting = await send(who, [late], ['MYR']);
    expect(waiting).toEqual({
      status: 503,
      data: { error: expect.stringContaining('THB'), code: 'converting' },
    });
    expect(await entry(who, late.transaction.id)).toEqual([]);
    // And the currency can't change again until it's done
    const again = await change(who, 'USD');
    expect(again.status).toBe(409);
    expect((await me(who)).settings.currency).toBe('THB');

    held.release();
    expect((await finished(who)).conversion).toBeNull();
    await saved(who, [late], ['MYR']);
    expect(await entry(who, late.transaction.id)).toEqual([
      {
        cents: 7_400,
        currency: 'MYR',
        originalCents: 1_000,
        rate: 7.4,
        rateAt: expect.any(Number),
      },
    ]);
    // One typed in the new currency is saved as typed
    const typed = spend(wallet, 900, day);
    await saved(who, [typed], ['THB']);
    expect((await entry(who, typed.transaction.id))[0]).toMatchObject({
      cents: 900,
      currency: null,
    });
  });

  it('tries again when the rate services are down, and finishes once they are back', async () => {
    const { who, entries } = await someone();
    api.rates.setOn(entries[0].day, 'MYR', 'SGD', 0.31);
    api.rates.setOn(entries[1].day, 'MYR', 'SGD', 0.32);
    api.rates.down('frankfurter', true);
    api.rates.down('wise', true);
    try {
      const asked = api.rates.asked('MYR', 'SGD');
      expect((await change(who, 'SGD')).status).toBe(200);
      const until = Date.now() + 30_000;
      // Tried, then tried again
      while (api.rates.asked('MYR', 'SGD') < asked + 9) {
        if (Date.now() > until) throw new Error('Not tried again');
        await new Promise((r) => setTimeout(r, 100));
      }
      expect((await me(who)).conversion).toMatchObject({ from: 'MYR', to: 'SGD', refused: null });
      expect((await entry(who, entries[0].id))[0]).toMatchObject({ cents: 1_234, currency: null });
    } finally {
      api.rates.down('frankfurter', false);
      api.rates.down('wise', false);
    }
    expect((await finished(who)).conversion).toBeNull();
    expect((await entry(who, entries[0].id))[0]).toMatchObject({ cents: 383, currency: 'MYR' });
  }, 60_000);

  it('is refused when an entry would go past the most an amount can be, and says so', async () => {
    const { who, wallet, entries } = await someone();
    const big = spend(wallet, 400_000_000, freshDay());
    await saved(who, [big]);
    for (const { day } of entries) api.rates.setOn(day, 'MYR', 'IDR', 3_400);
    api.rates.setOn(big.transaction.date, 'MYR', 'IDR', 3_500);

    expect((await change(who, 'IDR')).status).toBe(200);
    const profile = await finished(who);
    expect(profile.settings.currency).toBe('MYR');
    expect(profile.conversion).toEqual({
      from: 'MYR',
      to: 'IDR',
      since: expect.any(Number),
      refused: 'amount',
    });
    // Nothing was converted
    expect((await entry(who, big.transaction.id))[0]).toMatchObject({
      cents: 400_000_000,
      currency: null,
    });
    expect((await entry(who, entries[0].id))[0]).toMatchObject({ cents: 1_234, currency: null });
    expect((await amountOf(who, 'accounts', 'id = ?', wallet))[0]).toMatchObject({
      cents: 100_000,
      currency: null,
    });
    // Writes go through again
    await saved(who, [spend(wallet, 100, entries[0].day)]);
  });

  it('is refused when an opening balance would go past its limit, naming that limit', async () => {
    const who = person('rich');
    const wallet = rowId();
    await saved(who, [
      {
        op: 'addAccount',
        account: { id: wallet, name: 'Savings', kind: 'bank', openingCents: 500_000 },
      },
    ]);
    expect((await change(who, 'IDR')).status).toBe(200);
    const profile = await finished(who);
    expect(profile.settings.currency).toBe('MYR');
    expect(profile.conversion).toMatchObject({ to: 'IDR', refused: 'opening' });
    expect((await amountOf(who, 'accounts', 'id = ?', wallet))[0]).toMatchObject({
      cents: 500_000,
      currency: null,
    });
  });

  it('takes only the currencies it can convert into', async () => {
    const who = person('picky');
    const res = await change(who, 'XYZ');
    expect(res).toEqual({ status: 400, data: { error: 'Invalid currency' } });
    expect((await me(who)).settings.currency).toBe('MYR');
  });

  it('starts everyone on MYR, with nothing converting', async () => {
    const profile = await me(person('new'));
    expect(profile.settings.currency).toBe('MYR');
    expect(profile.conversion).toBeNull();
  });

  it('MYR to USD to SGD and back to MYR restores every amount exactly, and no one else is touched', async () => {
    const { who, wallet, bill, entries } = await someone();
    const other = await someone('other');
    for (const [day, usd, sgd] of [
      [entries[0].day, 0.21, 0.29],
      [entries[1].day, 0.22, 0.28],
    ] as const) {
      api.rates.setOn(day, 'MYR', 'USD', usd);
      api.rates.setOn(day, 'MYR', 'SGD', sgd);
    }
    await change(who, 'USD');
    expect((await finished(who)).conversion).toBeNull();
    await change(who, 'SGD');
    expect((await finished(who)).conversion).toBeNull();
    // Converted from what was typed (MYR), not from the USD in between
    expect(await entry(who, entries[0].id)).toEqual([
      { cents: 358, currency: 'MYR', originalCents: 1_234, rate: 0.29, rateAt: expect.any(Number) },
    ]);
    await change(who, 'MYR');
    expect((await finished(who)).settings.currency).toBe('MYR');
    for (const { id: entryId, cents } of entries) {
      expect(await entry(who, entryId)).toEqual([
        { cents, currency: null, originalCents: null, rate: null, rateAt: null },
      ]);
    }
    expect((await amountOf(who, 'accounts', 'id = ?', wallet))[0]).toMatchObject({
      cents: 100_000,
      currency: null,
    });
    expect((await amountOf(who, 'recurring', 'id = ?', bill))[0]).toMatchObject({
      cents: 18_937,
      currency: null,
    });
    // The other person's, all along
    expect((await me(other.who)).settings.currency).toBe('MYR');
    for (const { id: entryId, cents } of other.entries) {
      expect(await entry(other.who, entryId)).toEqual([
        { cents, currency: null, originalCents: null, rate: null, rateAt: null },
      ]);
    }
    expect(await api.sql('SELECT * FROM conversion_staged WHERE email = ?', who)).toEqual([]);
  });

  it.each([
    ['budget', 300_000, 18_937],
    ['scheduled', 60_000, 300_000],
  ])('is refused when a %s would go past its limit', async (limit, budgetCents, billCents) => {
    const who = person(limit);
    const wallet = rowId();
    const bill = rowId();
    await saved(who, [
      {
        op: 'addAccount',
        account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 1_000 },
      },
      {
        op: 'setBudget',
        categoryId: FOOD,
        fromMonth: '2025-01',
        amountCents: budgetCents,
        carryOver: false,
      },
      {
        op: 'addRecurring',
        recurring: {
          id: bill,
          kind: 'expense',
          accountId: wallet,
          toAccountId: null,
          amountCents: billCents,
          categoryId: BILLS,
          payee: 'TNB',
          schedule: 'monthly',
          day: 20,
          startDate: '2025-01-20',
          nextDue: nextTwentieth(),
        },
      },
    ]);
    expect((await change(who, 'IDR')).status).toBe(200);
    const profile = await finished(who);
    expect(profile.settings.currency).toBe('MYR');
    expect(profile.conversion).toMatchObject({ to: 'IDR', refused: limit });
    expect((await amountOf(who, 'budgets', 'category_id = ?', FOOD))[0]).toMatchObject({
      cents: budgetCents,
      currency: null,
    });
    expect((await amountOf(who, 'recurring', 'id = ?', bill))[0]).toMatchObject({
      cents: billCents,
      currency: null,
    });
  });

  it('gives the currency back once every try has failed, nothing converted', async () => {
    const { who, wallet, entries } = await someone();
    api.rates.down('frankfurter', true);
    api.rates.down('wise', true);
    try {
      expect((await change(who, 'USD')).status).toBe(200);
      const { since } = (await me(who)).conversion!;
      // A failed try notes when the next is due, so it isn't taken for stalled meanwhile
      const until = Date.now() + 30_000;
      for (;;) {
        const [row] = (await api.sql(
          'SELECT touched_at AS touchedAt FROM conversions WHERE email = ?',
          who,
        )) as { touchedAt: number }[];
        if (row.touchedAt > since) break;
        if (Date.now() > until) throw new Error('No try noted');
        await new Promise((r) => setTimeout(r, 100));
      }
      // Every try fails: the person gets MYR back, and says why
      const profile = await finished(who);
      expect(profile.settings.currency).toBe('MYR');
      expect(profile.conversion).toEqual({ from: 'MYR', to: 'USD', since, refused: 'rates' });
    } finally {
      api.rates.down('frankfurter', false);
      api.rates.down('wise', false);
    }
    expect((await entry(who, entries[0].id))[0]).toMatchObject({ cents: 1_234, currency: null });
    expect(await api.sql('SELECT * FROM conversion_staged WHERE email = ?', who)).toEqual([]);
    // Writes go through again
    await saved(who, [spend(wallet, 100, entries[0].day)]);
  }, 90_000);

  it('gives the currency back once a stalled one has been started again too often', async () => {
    const { who, entries } = await someone();
    const held = api.rates.hold('MYR', 'NOK');
    try {
      await change(who, 'NOK');
      await held.reached;
      await api.sql('UPDATE conversions SET touched_at = 0, restarts = 3 WHERE email = ?', who);
      // Reading the profile notices it
      await me(who);
      const profile = await finished(who);
      expect(profile.settings.currency).toBe('MYR');
      expect(profile.conversion).toMatchObject({ to: 'NOK', refused: 'rates' });
      expect((await entry(who, entries[0].id))[0]).toMatchObject({ cents: 1_234, currency: null });
    } finally {
      held.release();
    }
  });

  it('a step run twice, once more for a stall, converts each amount once', async () => {
    const { who, entries } = await someone();
    api.rates.setOn(entries[0].day, 'MYR', 'DKK', 1.5);
    api.rates.setOn(entries[1].day, 'MYR', 'DKK', 1.6);
    api.rates.set('MYR', 'DKK', 1.55);
    const held = api.rates.hold('MYR', 'DKK');
    await change(who, 'DKK');
    await held.reached;
    // Taken for stalled while its step waits: started again alongside it
    await api.sql('UPDATE conversions SET touched_at = 0 WHERE email = ?', who);
    await me(who);
    const until = Date.now() + 10_000;
    while (
      (
        (await api.sql('SELECT restarts FROM conversions WHERE email = ?', who)) as {
          restarts: number;
        }[]
      )[0]?.restarts !== 1
    ) {
      if (Date.now() > until) throw new Error('Not started again');
      await new Promise((r) => setTimeout(r, 100));
    }
    held.release();
    expect((await finished(who)).conversion).toBeNull();
    expect(await entry(who, entries[0].id)).toEqual([
      {
        cents: 1_851,
        currency: 'MYR',
        originalCents: 1_234,
        rate: 1.5,
        rateAt: expect.any(Number),
      },
    ]);
    expect((await entry(who, entries[1].id))[0]).toMatchObject({ cents: 8_002 });
  }, 60_000);

  it('converts each change in a batch by the currency it says, one that says none as typed', async () => {
    const { who, wallet, entries } = await someone();
    const day = freshDay();
    api.rates.setOn(entries[0].day, 'MYR', 'USD', 0.24);
    api.rates.setOn(entries[1].day, 'MYR', 'USD', 0.24);
    api.rates.setOn(day, 'MYR', 'USD', 0.2);
    await change(who, 'USD');
    await finished(who);
    const typedInRinggit = spend(wallet, 10_000, day);
    const saysNone = spend(wallet, 500, day);
    await saved(who, [typedInRinggit, saysNone], ['MYR', null]);
    expect((await entry(who, typedInRinggit.transaction.id))[0]).toMatchObject({
      cents: 2_000,
      currency: 'MYR',
      originalCents: 10_000,
    });
    expect((await entry(who, saysNone.transaction.id))[0]).toMatchObject({
      cents: 500,
      currency: null,
    });
  });

  it("uses today's rate for a day no service has one for, and says when it was from", async () => {
    const { who, entries } = await someone();
    await change(who, 'ZAR');
    expect((await finished(who)).conversion).toBeNull();
    const [row] = await entry(who, entries[0].id);
    expect(row).toMatchObject({ cents: 4_813, currency: 'MYR', rate: TODAY.ZAR });
    const rateAt = (row as unknown as { rateAt: number }).rateAt;
    // Its rate is today's, as rate_at says, not one for the entry's own day
    expect(new Date(rateAt).toISOString().slice(0, 10)).toBe(new Date().toISOString().slice(0, 10));
    expect(entries[0].day < new Date().toISOString().slice(0, 10)).toBe(true);
  });
});

describe('the rates of a year of days, asked as ranges', () => {
  /** Fresh days from the next Monday on: `count` of them, Monday first */
  const fromMonday = (count: number) => {
    let day = freshDay();
    while (new Date(`${day}T12:00:00Z`).getUTCDay() !== 1) day = freshDay();
    return [day, ...Array.from({ length: count - 1 }, () => freshDay())];
  };

  /**
   * The ECB has Monday to Friday of the first week and the Monday after, then nothing for
   * eleven days, then day 19; Wise has day 12 in the gap. Each entry: its day, the amount
   * typed (whole cents) and the rate and day it must be converted at.
   */
  function rateDays(to: string) {
    const d = fromMonday(20);
    const ecb: Record<number, number> = { 0: 0.191, 1: 0.192, 2: 0.193, 3: 0.194, 4: 0.195 };
    Object.assign(ecb, { 7: 0.197, 19: 0.199 });
    for (const [i, rate] of Object.entries(ecb))
      api.rates.setOn(d[+i], 'MYR', to, rate, 'frankfurter');
    api.rates.setOn(d[12], 'MYR', to, 0.188, 'wise');
    const entries = [
      { day: d[2], cents: 12_345, rate: 0.193, from: d[2] },
      // Saturday and Sunday: Friday's
      { day: d[5], cents: 999, rate: 0.195, from: d[4] },
      { day: d[6], cents: 1, rate: 0.195, from: d[4] },
      { day: d[7], cents: 250_000_01, rate: 0.197, from: d[7] },
      // A week and a day after the ECB's last: Wise's on day 12
      { day: d[15], cents: 7_777, rate: 0.188, from: d[12] },
      { day: d[19], cents: 33, rate: 0.199, from: d[19] },
    ];
    return entries;
  }

  async function convertAll(to: string) {
    const entries = rateDays(to);
    const who = person('ranges');
    const wallet = rowId();
    const added = entries.map((e) => spend(wallet, e.cents, e.day));
    await saved(who, [
      { op: 'addAccount', account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 0 } },
      ...added,
    ]);
    const before = api.rates.asked('MYR', to);
    expect((await change(who, to)).status).toBe(200);
    expect((await finished(who)).conversion).toBeNull();
    return {
      who,
      entries,
      ids: added.map((a) => a.transaction.id),
      asked: api.rates.asked('MYR', to) - before,
    };
  }

  it('converts each entry at its day’s rate, in whole cents, asking each service once', async () => {
    api.rates.set('MYR', 'CHF', 0.18);
    const { who, entries, ids, asked } = await convertAll('CHF');
    for (const [i, e] of entries.entries()) {
      const [row] = await entry(who, ids[i]);
      // Exactly what shared/rates.ts makes of it: a cent at the least
      expect(row).toMatchObject({
        cents: Math.max(1, convertCents(e.cents, e.rate)),
        currency: 'MYR',
        originalCents: e.cents,
        rate: e.rate,
        rateAt: Date.parse(`${e.from}T12:00:00Z`),
      });
    }
    // One range from the ECB, one from Wise for the days the ECB had nothing close to, and
    // today's rate for the opening balance; a day at a time it was a dozen or more
    expect(asked).toBe(3);
  });

  it('a range that fails is asked a day at a time, and comes to the same', async () => {
    api.rates.set('MYR', 'HUF', 67);
    const entries = rateDays('HUF');
    api.rates.downOn([entries[0].day]);
    try {
      const who = person('ranges-down');
      const wallet = rowId();
      const added = entries.map((e) => spend(wallet, e.cents, e.day));
      await saved(who, [
        {
          op: 'addAccount',
          account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 0 },
        },
        ...added,
      ]);
      expect((await change(who, 'HUF')).status).toBe(200);
      expect((await finished(who)).conversion).toBeNull();
      for (const [i, e] of entries.entries()) {
        const [row] = await entry(who, added[i].transaction.id);
        expect(row).toMatchObject({
          cents: Math.max(1, convertCents(e.cents, e.rate)),
          rate: e.rate,
        });
      }
    } finally {
      api.rates.downOn([]);
    }
  });
});
