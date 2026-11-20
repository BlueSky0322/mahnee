// Other currencies, end to end against the real Worker and a fresh local database: the
// person's list of other currencies (Settings › Money), kept in their order, at most
// MAX_OTHER_CURRENCIES, each one the app can convert; and an entry typed in one of them,
// sent with that currency as the change's own (the same path as a change typed in a home
// currency since left), converted into the home currency at the rate on its own day and
// keeping what was typed: the currency, the amount and the rate, from which service, for
// when. Changing it back into the home currency lets go of what was typed.
//
// Rates come from the stand-in services (local-worker.ts), never the real ones.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CATEGORIES } from '../../shared/categories';
import type { Original } from '../../shared/api';
import type { LocalWorker } from './local-worker';
import { startLocalWorker } from './local-worker';

let api: LocalWorker;
let n = 0;
const person = (name: string) => `${name}${++n}@example.com`;

let ids = 0;
/** A fresh row id, as the app makes them: 16 hex characters */
const rowId = () => (++ids).toString(16).padStart(16, '7');
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;

beforeAll(async () => {
  api = await startLocalWorker();
}, 180_000);

afterAll(() => api?.stop(), 30_000);

let days = 0;
/** A day in 2025 no other test uses, so its rates are this test's own */
const freshDay = () => {
  const at = Date.UTC(2025, 2, 1) + days++ * 24 * 60 * 60 * 1000;
  return new Date(at).toISOString().slice(0, 10);
};

const send = (who: string, changes: unknown[], currencies?: (string | null)[]) =>
  api.call(who, 'POST', '/api/changes', {
    changes,
    ids: changes.map(() => rowId()),
    ...(currencies && { currencies }),
  });

const settings = (who: string, patch: Record<string, unknown>) =>
  api.call(who, 'PATCH', '/api/me', { settings: patch });

const me = async (who: string) =>
  (await api.call(who, 'GET', '/api/me')).data as {
    settings: { otherCurrencies: string[]; travelSense: boolean };
  };

/** Someone with a wallet, its id */
async function withWallet(name: string) {
  const who = person(name);
  const wallet = rowId();
  expect(
    await send(who, [
      {
        op: 'addAccount',
        account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 100_000 },
      },
    ]),
  ).toEqual({ status: 200, data: { ok: true } });
  return { who, wallet };
}

const spend = (accountId: string, amountCents: number, date: string) => ({
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
  },
});

/** The account's entries as the app reads them */
const entries = async (who: string, wallet: string) =>
  (await api.call(who, 'GET', `/api/transactions?account=${wallet}`)).data.transactions as {
    id: string;
    amountCents: number;
    original?: unknown;
  }[];

describe('the list of other currencies', () => {
  it('starts empty, with travel sense on', async () => {
    expect((await me(person('new'))).settings).toMatchObject({
      otherCurrencies: [],
      travelSense: true,
    });
  });

  it('is kept in the order given, and travel sense can be turned off', async () => {
    const who = person('list');
    expect((await settings(who, { otherCurrencies: ['THB', 'USD', 'VND'] })).status).toBe(200);
    expect((await settings(who, { travelSense: false })).status).toBe(200);
    expect((await me(who)).settings).toMatchObject({
      otherCurrencies: ['THB', 'USD', 'VND'],
      travelSense: false,
    });
    // Reordered, then one taken away
    await settings(who, { otherCurrencies: ['VND', 'THB'] });
    expect((await me(who)).settings.otherCurrencies).toEqual(['VND', 'THB']);
  });

  it.each([
    [
      'past the most',
      ['THB', 'USD', 'SGD', 'JPY', 'EUR', 'GBP', 'AUD', 'IDR', 'VND'],
      'Keep up to 8 other currencies',
    ],
    ['a currency it can’t convert', ['THB', 'XYZ'], 'Invalid otherCurrencies'],
    ['one twice', ['THB', 'THB'], 'Invalid otherCurrencies'],
    ['not a list', 'THB', 'Invalid otherCurrencies'],
  ])('is refused %s, keeping the list as it was', async (_why, list, error) => {
    const who = person('refused');
    await settings(who, { otherCurrencies: ['SGD'] });
    expect(await settings(who, { otherCurrencies: list })).toEqual({
      status: 400,
      data: { error },
    });
    expect((await me(who)).settings.otherCurrencies).toEqual(['SGD']);
  });
});

describe('the main currency and the list', () => {
  it('refuses the main currency in the list, keeping the list as it was', async () => {
    const who = person('main');
    await settings(who, { otherCurrencies: ['THB'] });
    expect(await settings(who, { otherCurrencies: ['THB', 'MYR'] })).toEqual({
      status: 400,
      data: { error: 'MYR is your main currency' },
    });
    // Nor one sent as the new main currency beside it
    expect(await settings(who, { currency: 'SGD', otherCurrencies: ['SGD'] })).toEqual({
      status: 400,
      data: { error: 'SGD is your main currency' },
    });
    expect((await me(who)).settings.otherCurrencies).toEqual(['THB']);
  });

  it('drops a listed currency once it becomes the main one, keeping the others in order', async () => {
    const who = person('switch');
    await settings(who, { otherCurrencies: ['THB', 'USD', 'SGD'] });
    expect((await settings(who, { currency: 'USD' })).status).toBe(200);
    const until = Date.now() + 60_000;
    let profile = await api.call(who, 'GET', '/api/me');
    while (profile.data.conversion != null && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 200));
      profile = await api.call(who, 'GET', '/api/me');
    }
    expect(profile.data.settings).toMatchObject({
      currency: 'USD',
      otherCurrencies: ['THB', 'SGD'],
    });
  }, 70_000);
});

describe('an entry typed in another currency', () => {
  it('is converted at its own day’s rate, keeping the currency, amount and rate typed', async () => {
    const { who, wallet } = await withWallet('thb');
    const day = freshDay();
    api.rates.setOn(day, 'THB', 'MYR', 0.1275);
    const entry = spend(wallet, 12_000, day);
    expect(await send(who, [entry], ['THB'])).toEqual({ status: 200, data: { ok: true } });
    expect(await entries(who, wallet)).toEqual([
      expect.objectContaining({
        id: entry.transaction.id,
        amountCents: 1_530,
        original: {
          currency: 'THB',
          cents: 12_000,
          rate: 0.1275,
          source: 'frankfurter',
          at: Date.parse(`${day}T12:00:00Z`),
          day,
        },
      }),
    ]);
    // The balance moves by the converted amount, in the home currency
    const ledger = await api.call(who, 'GET', '/api/accounts');
    expect(ledger.data.accounts[0].balanceCents).toBe(100_000 - 1_530);
  });

  it('changes amount and currency when edited, and lets go of them typed in the home currency', async () => {
    const { who, wallet } = await withWallet('edit');
    const [day, later] = [freshDay(), freshDay()];
    api.rates.setOn(day, 'THB', 'MYR', 0.125);
    api.rates.setOn(later, 'THB', 'MYR', 0.13);
    api.rates.setOn(later, 'USD', 'MYR', 4.5);
    const entry = spend(wallet, 8_000, day);
    const id = entry.transaction.id;
    await send(who, [entry], ['THB']);
    // A new amount and day: converted at the new day's rate
    expect(
      await send(who, [{ op: 'updateTransaction', id, amountCents: 10_000, date: later }], ['THB']),
    ).toEqual({ status: 200, data: { ok: true } });
    expect((await entries(who, wallet))[0]).toMatchObject({
      amountCents: 1_300,
      original: { currency: 'THB', cents: 10_000, rate: 0.13 },
    });
    // Another currency, the day it's on
    await send(who, [{ op: 'updateTransaction', id, amountCents: 2_000 }], ['USD']);
    expect((await entries(who, wallet))[0]).toMatchObject({
      amountCents: 9_000,
      original: { currency: 'USD', cents: 2_000, rate: 4.5 },
    });
    // The same figure typed in ringgit: what it was typed as goes
    await send(who, [{ op: 'updateTransaction', id, amountCents: 9_000 }], ['MYR']);
    const [after] = await entries(who, wallet);
    expect(after.amountCents).toBe(9_000);
    expect(after.original).toBeUndefined();
  });

  it('in a currency the ECB doesn’t publish, takes Wise’s closest earlier day, saying which', async () => {
    const { who, wallet } = await withWallet('dong');
    const [earlier, , day] = [freshDay(), freshDay(), freshDay()];
    api.rates.setOn(earlier, 'VND', 'MYR', 0.00018, 'wise');
    await send(who, [spend(wallet, 50_000_000, day)], ['VND']);
    expect((await entries(who, wallet))[0]).toMatchObject({
      amountCents: 9_000,
      original: {
        currency: 'VND',
        cents: 50_000_000,
        rate: 0.00018,
        source: 'wise',
        at: Date.parse(`${earlier}T12:00:00Z`),
      },
    });
  });

  it('asks the services about each day once in a batch, whichever entry it is for', async () => {
    const { who, wallet } = await withWallet('twd');
    const days = Array.from({ length: 8 }, () => freshDay());
    // Only Wise, and only the first of these days, has a rate
    api.rates.setOn(days[0], 'TWD', 'MYR', 0.14, 'wise');
    const before = api.rates.asked('TWD', 'MYR');
    const [first, second] = [spend(wallet, 1_000, days[6]), spend(wallet, 2_000, days[7])];
    expect(await send(who, [first, second], ['TWD', 'TWD'])).toEqual({
      status: 200,
      data: { ok: true },
    });
    // The first asks both services about its day and the 6 before; the second only about
    // its own day, finding the same rate
    expect(api.rates.asked('TWD', 'MYR') - before).toBe(14 + 2);
    const saved = (await entries(who, wallet)).map((t) => t.original as Original);
    expect(saved.sort((a, b) => a.cents - b.cents)).toEqual(
      [1_000, 2_000].map((cents) => ({
        currency: 'TWD',
        cents,
        rate: 0.14,
        source: 'wise',
        at: Date.parse(`${days[0]}T12:00:00Z`),
        day: days[0],
      })),
    );
  });

  it('is refused in a currency the app can’t convert, and nothing is saved', async () => {
    const { who, wallet } = await withWallet('unknown');
    expect(await send(who, [spend(wallet, 1_000, freshDay())], ['XYZ'])).toEqual({
      status: 400,
      data: { error: 'Send the currency each change was typed in, one each' },
    });
    expect(await entries(who, wallet)).toEqual([]);
  });

  it('is refused when it would come to more than an entry can be in the home currency', async () => {
    const { who, wallet } = await withWallet('large');
    const day = freshDay();
    api.rates.setOn(day, 'EUR', 'MYR', 4.9);
    expect(await send(who, [spend(wallet, 900_000_000, day)], ['EUR'])).toEqual({
      status: 400,
      data: { error: 'An amount is more than 0 and up to 10,000,000' },
    });
    expect(await entries(who, wallet)).toEqual([]);
  });

  it('may be typed past 10,000,000 when what it comes to fits, as a hotel bill in rupiah', async () => {
    const { who, wallet } = await withWallet('rupiah');
    const day = freshDay();
    api.rates.setOn(day, 'IDR', 'MYR', 0.00028);
    const entry = spend(wallet, 1_500_000_000, day);
    expect(await send(who, [entry], ['IDR'])).toEqual({ status: 200, data: { ok: true } });
    expect((await entries(who, wallet))[0]).toMatchObject({
      amountCents: 420_000,
      original: { currency: 'IDR', cents: 1_500_000_000, rate: 0.00028 },
    });
  });

  it('is refused typed past its own most, naming it, and nothing is saved', async () => {
    const { who, wallet } = await withWallet('most');
    const day = freshDay();
    api.rates.setOn(day, 'VND', 'MYR', 0.00018);
    expect(await send(who, [spend(wallet, 100_000_000_001, day)], ['VND'])).toEqual({
      status: 400,
      data: { error: 'An amount typed in VND can be up to 1,000,000,000' },
    });
    expect(await entries(who, wallet)).toEqual([]);
  });
});
