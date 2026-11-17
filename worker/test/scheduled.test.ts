// Scheduled entries added on their day, end to end against the real Worker and a fresh
// local database (owner decisions D8 "Add on the day" and D19 "Ask once, then automatic").
// A cron trigger runs every 15 minutes; each run adds, for every person with a stored time
// zone, each occurrence their own day has reached, marked as from Scheduled (and, when the
// item's amount changes, as an amount to check). An occurrence is added once, whatever
// runs again or at the same time; missed runs are caught up from the item's next due
// date, at most 31 occurrences of one item and 200 entries in all in one run. Items that
// ask first (overdue when they were saved, or when 0009 ran) are left for Log it or Skip.
//
// Each run is fired at a fixed instant (the scheduled time the trigger is given), in 2025
// so every day it adds is one a transaction can be on. The days the job adds are worked out
// from that instant alone; the rule for asking first is worked out from the server's own
// clock, so its cases read today the same way (and wait out the minutes either side of a
// midnight, when the test's today and the server's could differ).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Recurring, Transaction } from '../../shared/api';
import { DEFAULT_CATEGORIES } from '../../shared/categories';
import { dayFor, nextAfter } from '../../shared/recurring';
import { dayIn } from '../../shared/scheduled';
import type { LocalWorker } from './local-worker';
import { startLocalWorker } from './local-worker';

let api: LocalWorker;
let n = 0;
const person = (name: string) => `${name}${++n}@example.com`;

beforeAll(async () => {
  api = await startLocalWorker();
}, 180_000);

afterAll(() => api?.stop(), 30_000);

// Every run adds for everyone in the database: what a test leaves running is stopped, so
// it can't take a later test's place in a run
afterEach(async () => {
  await api.sql('UPDATE recurring SET archived = 1 WHERE archived = 0');
});

let ids = 0;
/** A fresh row id, as the app makes them: 16 hex characters */
const rowId = () => (++ids).toString(16).padStart(16, '7');
const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const [BILLS, SALARY, FUN] = [id('Bills'), id('Salary'), id('Fun')];
const KL = 'Asia/Kuala_Lumpur';
const KATHMANDU = 'Asia/Kathmandu';
const LOS_ANGELES = 'America/Los_Angeles';
const CRON = '*/15 * * * *';

/** Runs the nightly job as the cron trigger does, scheduled for `instant` */
async function runAt(instant: string) {
  const res = await fetch(
    `${api.base}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(CRON)}&time=${Date.parse(instant)}`,
  );
  expect({ status: res.status, outcome: await res.text() }).toEqual({ status: 200, outcome: 'ok' });
}

/** Sends ledger changes as `who`, each saved or the test stops there */
async function send(who: string, changes: unknown[]) {
  const res = await api.call(who, 'POST', '/api/changes', {
    changes,
    ids: changes.map(() => rowId()),
  });
  expect(res).toEqual({ status: 200, data: { ok: true } });
}

async function refused(who: string, changes: unknown[]) {
  return api.call(who, 'POST', '/api/changes', { changes, ids: changes.map(() => rowId()) });
}

/** A person with a wallet of RM 1,000.00 (and a bank of RM 500.00), in `zone` when given */
async function someone(zone: string | null, name = 'me') {
  const who = person(name);
  const [wallet, bank] = [rowId(), rowId()];
  await send(who, [
    {
      op: 'addAccount',
      account: { id: wallet, name: 'Wallet', kind: 'cash', openingCents: 100_000 },
    },
    { op: 'addAccount', account: { id: bank, name: 'Bank', kind: 'bank', openingCents: 50_000 } },
  ]);
  if (zone != null) await saveZone(who, zone);
  return { who, wallet, bank };
}

async function saveZone(who: string, zone: string) {
  const res = await api.call(who, 'PATCH', '/api/me', { settings: { timeZone: zone } });
  expect(res.status).toBe(200);
}

/** A repeating item's change, a monthly bill from the wallet unless said otherwise */
function item(accountId: string, more: Partial<Recurring> = {}) {
  return {
    id: rowId(),
    kind: 'expense',
    accountId,
    toAccountId: null,
    amountCents: 18_937,
    categoryId: BILLS,
    payee: 'TNB',
    schedule: 'monthly',
    day: 20,
    startDate: '2025-10-20',
    nextDue: '2025-11-20',
    ...more,
  };
}

/**
 * Sets items up as items set up before their day are: added on their day, not asked about.
 * These days are in the past for the real server, which takes any item saved with its next
 * due date passed as one to ask about first (D19), so they're marked here as the database
 * would hold them.
 */
async function setUp(who: string, items: ReturnType<typeof item>[]) {
  await send(
    who,
    items.map((recurring) => ({ op: 'addRecurring', recurring })),
  );
  await api.sql('UPDATE recurring SET ask_first = 0 WHERE email = ?', who);
  return items;
}

async function ledger(who: string) {
  const res = await api.call(who, 'GET', '/api/accounts');
  expect(res.status).toBe(200);
  return res.data as {
    accounts: { id: string; balanceCents: number }[];
    recurring?: Recurring[];
  };
}

const balanceOf = async (who: string, accountId: string) =>
  (await ledger(who)).accounts.find((a) => a.id === accountId)?.balanceCents;

const itemOf = async (who: string, itemId: string) =>
  (await ledger(who)).recurring?.find((r) => r.id === itemId);

/** Every transaction on an account, newest first */
async function entries(who: string, accountId: string): Promise<Transaction[]> {
  const res = await api.call(who, 'GET', `/api/transactions?account=${accountId}&limit=200`);
  expect(res.status).toBe(200);
  const page = res.data as { transactions: Transaction[]; nextBefore: string | null };
  if (page.nextBefore == null) return page.transactions;
  const more = await api.call(
    who,
    'GET',
    `/api/transactions?account=${accountId}&limit=200&before=${encodeURIComponent(page.nextBefore)}`,
  );
  return [...page.transactions, ...(more.data as { transactions: Transaction[] }).transactions];
}

const days = (list: Transaction[]) => list.map((t) => t.date).sort();

describe('the trigger', () => {
  it('runs the job every 15 minutes, as wrangler.jsonc sets it up for every deploy', () => {
    const config = readFileSync(resolve(__dirname, '../../wrangler.jsonc'), 'utf8');
    const crons = /"triggers"\s*:\s*\{\s*"crons"\s*:\s*\[([^\]]*)\]/.exec(config)?.[1];
    expect(
      crons
        ?.split(',')
        .map((c) => c.trim())
        .filter(Boolean),
    ).toEqual(['"*/15 * * * *"']);
  });
});

describe('the nightly job adds each scheduled entry on its day', () => {
  it('adds nothing before the person’s own midnight, then the entry, from Scheduled', async () => {
    const { who, wallet } = await someone(KL);
    const [tnb] = await setUp(who, [item(wallet)]);
    // 23:45 on November 19 in Kuala Lumpur
    await runAt('2025-11-19T15:45:00Z');
    expect(await entries(who, wallet)).toEqual([]);
    // Midnight: November 20 there, still November 19 in UTC
    await runAt('2025-11-19T16:00:00Z');
    const added = await entries(who, wallet);
    expect(added).toEqual([
      {
        id: expect.stringMatching(/^[0-9a-f]{16}$/),
        kind: 'expense',
        accountId: wallet,
        toAccountId: null,
        amountCents: 18_937,
        categoryId: BILLS,
        payee: 'TNB',
        note: null,
        date: '2025-11-20',
        time: null,
        createdAt: expect.any(Number),
        scheduled: { recurringId: tnb.id, due: '2025-11-20', toCheck: false },
      },
    ]);
    expect(await balanceOf(who, wallet)).toBe(100_000 - 18_937);
    expect(await itemOf(who, tnb.id)).toMatchObject({ nextDue: '2025-12-20', askFirst: false });
  });

  it('follows a zone a quarter of an hour off the hour: Kathmandu', async () => {
    const { who, wallet } = await someone(KATHMANDU);
    await setUp(who, [item(wallet)]);
    // 23:45 on November 19 in Kathmandu (UTC+5:45)
    await runAt('2025-11-19T18:00:00Z');
    expect(await entries(who, wallet)).toEqual([]);
    await runAt('2025-11-19T18:15:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-20']);
  });

  it('follows a zone behind UTC: Los Angeles, whose midnight is the next day in UTC', async () => {
    const { who, wallet } = await someone(LOS_ANGELES);
    await setUp(who, [item(wallet)]);
    // 23:59 on November 19 there (UTC-8): already November 20 in UTC
    await runAt('2025-11-20T07:59:00Z');
    expect(await entries(who, wallet)).toEqual([]);
    await runAt('2025-11-20T08:00:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-20']);
  });

  it('follows Los Angeles across the end of summer time (2 am, November 2, 2025)', async () => {
    const { who, wallet } = await someone(LOS_ANGELES);
    // Midnight on the 2nd is still summer time (UTC-7); on the 3rd, winter time (UTC-8)
    await setUp(who, [
      item(wallet, { schedule: 'weekly', day: 7, payee: 'Sunday', nextDue: '2025-11-02' }),
      item(wallet, { schedule: 'weekly', day: 1, payee: 'Monday', nextDue: '2025-11-03' }),
    ]);
    await runAt('2025-11-02T06:59:00Z');
    expect(await entries(who, wallet)).toEqual([]);
    await runAt('2025-11-02T07:00:00Z');
    expect((await entries(who, wallet)).map((t) => t.payee)).toEqual(['Sunday']);
    // 23:00 and 23:59 on the 2nd in winter time
    await runAt('2025-11-03T07:00:00Z');
    await runAt('2025-11-03T07:59:00Z');
    expect((await entries(who, wallet)).map((t) => t.payee)).toEqual(['Sunday']);
    await runAt('2025-11-03T08:00:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-02', '2025-11-03']);
  });

  it('adds income in and moves a transfer between the two accounts, exactly', async () => {
    const { who, wallet, bank } = await someone(KL);
    await setUp(who, [
      item(bank, {
        kind: 'income',
        categoryId: SALARY,
        payee: 'Acme',
        amountCents: 680_001,
        day: 25,
        nextDue: '2025-11-25',
      }),
      item(bank, {
        kind: 'transfer',
        toAccountId: wallet,
        categoryId: null,
        payee: 'Top-up',
        amountCents: 10_001,
        day: 25,
        nextDue: '2025-11-25',
      }),
    ]);
    await runAt('2025-11-24T16:00:00Z');
    expect(await balanceOf(who, bank)).toBe(50_000 + 680_001 - 10_001);
    expect(await balanceOf(who, wallet)).toBe(100_000 + 10_001);
  });

  it('adds a 31st on a shorter month’s last day', async () => {
    const { who, wallet } = await someone(KL);
    const [rent] = await setUp(who, [item(wallet, { day: 31, nextDue: '2025-11-30' })]);
    await runAt('2025-11-29T16:00:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-30']);
    expect(await itemOf(who, rent.id)).toMatchObject({ nextDue: '2025-12-31' });
  });

  it('marks an amount that changes as one to check', async () => {
    const { who, wallet } = await someone(KL);
    const [tnb] = await setUp(who, [item(wallet, { amountVaries: true })]);
    expect(await itemOf(who, tnb.id)).toMatchObject({ amountVaries: true });
    await runAt('2025-11-19T16:00:00Z');
    const [added] = await entries(who, wallet);
    expect(added.scheduled).toEqual({ recurringId: tnb.id, due: '2025-11-20', toCheck: true });
  });
});

describe('each occurrence is added once', () => {
  it('whatever runs again, at the same time or later', async () => {
    const { who, wallet } = await someone(KL);
    const [tnb] = await setUp(who, [item(wallet)]);
    await runAt('2025-11-19T16:00:00Z');
    // The same run again, as a retry would
    await runAt('2025-11-19T16:00:00Z');
    // Two at once, as overlapping runs would
    await Promise.all([runAt('2025-11-19T16:15:00Z'), runAt('2025-11-19T16:15:00Z')]);
    // A later run on the same day
    await runAt('2025-11-20T03:00:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-20']);
    expect(await balanceOf(who, wallet)).toBe(100_000 - 18_937);
    expect(await itemOf(who, tnb.id)).toMatchObject({ nextDue: '2025-12-20' });
  });

  it('even when the entry it added was deleted since', async () => {
    const { who, wallet } = await someone(KL);
    await setUp(who, [item(wallet)]);
    await runAt('2025-11-19T16:00:00Z');
    const [added] = await entries(who, wallet);
    await send(who, [{ op: 'removeTransaction', id: added.id }]);
    await runAt('2025-11-19T16:15:00Z');
    expect(await entries(who, wallet)).toEqual([]);
  });

  it('when the person moves to another time zone and back', async () => {
    const { who, wallet } = await someone(KL);
    await setUp(who, [item(wallet)]);
    await runAt('2025-11-19T16:00:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-20']);
    // Now in Los Angeles, where it is still November 19: nothing again, nothing lost
    await saveZone(who, LOS_ANGELES);
    await runAt('2025-11-19T16:15:00Z');
    await runAt('2025-11-20T16:00:00Z');
    await runAt('2025-12-20T07:45:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-20']);
    // December 20 begins in Los Angeles
    await runAt('2025-12-20T08:00:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-20', '2025-12-20']);
    // Back in Kuala Lumpur, a day ahead: still once each
    await saveZone(who, KL);
    await runAt('2025-12-20T08:15:00Z');
    await runAt('2025-12-20T16:00:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-20', '2025-12-20']);
  });

  it('for each person on their own, though their items share an id', async () => {
    const [me, them] = [await someone(KL, 'me'), await someone(KL, 'them')];
    const shared = rowId();
    await setUp(me.who, [item(me.wallet, { id: shared, amountCents: 1_111 })]);
    await setUp(them.who, [item(them.wallet, { id: shared, amountCents: 2_222 })]);
    await runAt('2025-11-19T16:00:00Z');
    expect((await entries(me.who, me.wallet)).map((t) => t.amountCents)).toEqual([1_111]);
    expect((await entries(them.who, them.wallet)).map((t) => t.amountCents)).toEqual([2_222]);
  });
});

describe('changes made between runs', () => {
  it('a raised amount is what is added next, and the entry already added keeps its own', async () => {
    const { who, wallet } = await someone(KL);
    const [tnb] = await setUp(who, [item(wallet)]);
    await runAt('2025-11-19T16:00:00Z');
    await send(who, [{ op: 'updateRecurring', id: tnb.id, amountCents: 20_001 }]);
    await runAt('2025-12-19T16:00:00Z');
    await runAt('2025-12-19T16:15:00Z');
    expect((await entries(who, wallet)).map((t) => [t.date, t.amountCents]).sort()).toEqual([
      ['2025-11-20', 18_937],
      ['2025-12-20', 20_001],
    ]);
  });

  it('a day skipped by moving the next due date on is never added; the new day is', async () => {
    const { who, wallet } = await someone(KL);
    const [tnb] = await setUp(who, [item(wallet)]);
    await send(who, [{ op: 'updateRecurring', id: tnb.id, nextDue: '2025-12-20' }]);
    // A day in the past for the real server, so it's saved as asking first: set up as the
    // person's device would have it before that day
    await api.sql('UPDATE recurring SET ask_first = 0 WHERE email = ?', who);
    await runAt('2025-11-19T16:00:00Z');
    expect(await entries(who, wallet)).toEqual([]);
    await runAt('2025-12-19T16:00:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-12-20']);
  });

  it('an entry deleted and its day moved back is asked about, not added again or retried', async () => {
    const { who, wallet } = await someone(KL);
    const [tnb] = await setUp(who, [item(wallet)]);
    await runAt('2025-11-19T16:00:00Z');
    const [added] = await entries(who, wallet);
    await send(who, [
      { op: 'removeTransaction', id: added.id },
      { op: 'updateRecurring', id: tnb.id, nextDue: '2025-11-20' },
    ]);
    expect(await itemOf(who, tnb.id)).toMatchObject({ nextDue: '2025-11-20', askFirst: true });
    await runAt('2025-11-19T16:15:00Z');
    await runAt('2025-11-20T16:00:00Z');
    expect(await entries(who, wallet)).toEqual([]);
    expect(await itemOf(who, tnb.id)).toMatchObject({ nextDue: '2025-11-20', askFirst: true });
  });

  it('an entry brought back with Undo is not added a second time', async () => {
    const { who, wallet } = await someone(KL);
    await setUp(who, [item(wallet)]);
    await runAt('2025-11-19T16:00:00Z');
    const [added] = await entries(who, wallet);
    await send(who, [{ op: 'removeTransaction', id: added.id }]);
    const { createdAt: _createdAt, ...back } = added;
    await send(who, [{ op: 'addTransaction', transaction: back }]);
    await runAt('2025-11-19T16:15:00Z');
    await runAt('2025-11-20T03:00:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-20']);
  });
});

describe('missed runs are caught up, in bounded runs', () => {
  it('adds every occurrence missed since its next due date, each on its own day', async () => {
    const { who, wallet } = await someone(KL);
    // Mondays, next due October 6; the run is at the start of Tuesday, November 4
    const [gym] = await setUp(who, [
      item(wallet, {
        schedule: 'weekly',
        day: 1,
        payee: 'Gym',
        amountCents: 3_000,
        nextDue: '2025-10-06',
      }),
    ]);
    await runAt('2025-11-03T16:00:00Z');
    expect(days(await entries(who, wallet))).toEqual([
      '2025-10-06',
      '2025-10-13',
      '2025-10-20',
      '2025-10-27',
      '2025-11-03',
    ]);
    expect(await balanceOf(who, wallet)).toBe(100_000 - 5 * 3_000);
    expect(await itemOf(who, gym.id)).toMatchObject({ nextDue: '2025-11-10' });
  });

  it('adds at most 31 of one item in a run, and the rest in the next', async () => {
    const { who, wallet } = await someone(KL);
    // 46 Mondays from January 6 to November 17
    const [gym] = await setUp(who, [
      item(wallet, {
        schedule: 'weekly',
        day: 1,
        payee: 'Gym',
        amountCents: 100,
        nextDue: '2025-01-06',
      }),
    ]);
    await runAt('2025-11-17T16:00:00Z');
    const first = days(await entries(who, wallet));
    expect(first).toHaveLength(31);
    expect([first[0], first[30]]).toEqual(['2025-01-06', '2025-08-04']);
    expect(await itemOf(who, gym.id)).toMatchObject({ nextDue: '2025-08-11' });
    await runAt('2025-11-17T16:15:00Z');
    const all = days(await entries(who, wallet));
    expect(all).toHaveLength(46);
    expect(new Set(all).size).toBe(46);
    expect(all[45]).toBe('2025-11-17');
    expect(await itemOf(who, gym.id)).toMatchObject({ nextDue: '2025-11-24' });
  });

  it('adds at most 200 entries in a run, and the rest in the runs after', async () => {
    const { who, wallet } = await someone(KL);
    // Seven weekly items, 46 Mondays each: 322 in all
    const items = await setUp(
      who,
      Array.from({ length: 7 }, (_, i) =>
        item(wallet, {
          schedule: 'weekly',
          day: 1,
          payee: `Item ${i}`,
          amountCents: 100,
          nextDue: '2025-01-06',
        }),
      ),
    );
    await runAt('2025-11-17T16:00:00Z');
    const first = await entries(who, wallet);
    expect(first).toHaveLength(200);
    for (const r of items) {
      expect(first.filter((t) => t.scheduled?.recurringId === r.id).length).toBeLessThanOrEqual(31);
    }
    for (const minute of ['15', '30', '45']) await runAt(`2025-11-17T16:${minute}:00Z`);
    const all = await entries(who, wallet);
    expect(all).toHaveLength(322);
    expect(new Set(all.map((t) => `${t.scheduled?.recurringId}:${t.date}`)).size).toBe(322);
    expect(await balanceOf(who, wallet)).toBe(100_000 - 322 * 100);
  });
});

describe('who and what the job leaves alone', () => {
  it('a person with no time zone, until the app sends one', async () => {
    const { who, wallet } = await someone(null);
    await setUp(who, [item(wallet)]);
    await runAt('2025-11-20T06:00:00Z');
    expect(await entries(who, wallet)).toEqual([]);
    await saveZone(who, KL);
    await runAt('2025-11-20T06:15:00Z');
    expect(days(await entries(who, wallet))).toEqual(['2025-11-20']);
  });

  it('a stopped item and one on an archived account, which keep their next due date', async () => {
    const { who, wallet, bank } = await someone(KL);
    const [stopped, onArchived] = await setUp(who, [item(wallet), item(bank)]);
    await send(who, [
      { op: 'archiveRecurring', id: stopped.id, archived: true },
      { op: 'archiveAccount', id: bank, archived: true },
    ]);
    await runAt('2025-11-19T16:00:00Z');
    expect(await entries(who, wallet)).toEqual([]);
    expect(await entries(who, bank)).toEqual([]);
    expect(await itemOf(who, stopped.id)).toMatchObject({ nextDue: '2025-11-20' });
    expect(await itemOf(who, onArchived.id)).toMatchObject({ nextDue: '2025-11-20' });
  });

  it('a transfer into an archived account, without holding back the person\u2019s others', async () => {
    const { who, wallet, bank } = await someone(KL);
    const [transfer, tnb] = await setUp(who, [
      item(wallet, { kind: 'transfer', toAccountId: bank, categoryId: null, payee: 'Save' }),
      item(wallet),
    ]);
    await send(who, [{ op: 'archiveAccount', id: bank, archived: true }]);
    await runAt('2025-11-19T16:00:00Z');
    expect((await entries(who, wallet)).map((t) => t.payee)).toEqual(['TNB']);
    expect(await itemOf(who, transfer.id)).toMatchObject({ nextDue: '2025-11-20' });
    expect(await itemOf(who, tnb.id)).toMatchObject({ nextDue: '2025-12-20' });
  });

  it('an account brought back after its items\u2019 days passed: they ask first', async () => {
    const { who, wallet, bank } = await someone(KL);
    const [onBank] = await setUp(who, [item(bank)]);
    await send(who, [{ op: 'archiveAccount', id: bank, archived: true }]);
    await runAt('2025-11-19T16:00:00Z');
    await send(who, [{ op: 'archiveAccount', id: bank, archived: false }]);
    expect(await itemOf(who, onBank.id)).toMatchObject({ nextDue: '2025-11-20', askFirst: true });
    await runAt('2025-11-19T16:15:00Z');
    expect(await entries(who, bank)).toEqual([]);
    expect(await entries(who, wallet)).toEqual([]);
  });

  it('a category brought back after its items\u2019 days passed: they ask first', async () => {
    const { who, wallet } = await someone(KL);
    const [fun] = await setUp(who, [item(wallet, { categoryId: FUN, payee: 'Netflix' })]);
    await send(who, [{ op: 'archiveCategory', id: FUN, archived: true }]);
    await runAt('2025-11-19T16:00:00Z');
    await send(who, [{ op: 'archiveCategory', id: FUN, archived: false }]);
    expect(await itemOf(who, fun.id)).toMatchObject({ nextDue: '2025-11-20', askFirst: true });
    await runAt('2025-11-19T16:15:00Z');
    expect(await entries(who, wallet)).toEqual([]);
  });

  it('a person whose entries can\u2019t be saved at all holds back no one else', async () => {
    const broken = await someone(KL, 'broken');
    const other = await someone(KL, 'other');
    // Broken is due first (oldest), and saving anything for them fails outright
    await setUp(broken.who, [item(broken.wallet, { nextDue: '2025-11-19', day: 19 })]);
    await setUp(other.who, [item(other.wallet)]);
    // A failure that isn't a refusal, for their rows only: malformed JSON, read as it runs
    await api.sql(
      `CREATE TRIGGER poisoned BEFORE INSERT ON transactions WHEN NEW.email = '${broken.who}'
       BEGIN SELECT json('not json'); END`,
    );
    try {
      const res = await fetch(
        `${api.base}/cdn-cgi/local/scheduled?cron=${encodeURIComponent(CRON)}&time=${Date.parse('2025-11-19T16:00:00Z')}`,
      );
      // The run says it failed, so the cron shows it, after adding everyone else's
      expect({ status: res.status, outcome: await res.text() }).toEqual({
        status: 500,
        outcome: 'exception',
      });
      expect(days(await entries(other.who, other.wallet))).toEqual(['2025-11-20']);
      expect(await entries(broken.who, broken.wallet)).toEqual([]);
    } finally {
      await api.sql('DROP TRIGGER IF EXISTS poisoned');
    }
  });

  it('items that can\u2019t be added take none of a run\u2019s 200 from anyone else', async () => {
    const stuck = await someone(KL, 'stuck');
    const other = await someone(KL, 'other');
    // 7 x 46 missed Mondays, all older than anyone else's, in a category since archived
    const items = await setUp(
      stuck.who,
      Array.from({ length: 7 }, (_, i) =>
        item(stuck.wallet, {
          schedule: 'weekly',
          day: 1,
          categoryId: FUN,
          payee: `Stuck ${i}`,
          amountCents: 100,
          nextDue: '2025-01-06',
        }),
      ),
    );
    await send(stuck.who, [{ op: 'archiveCategory', id: FUN, archived: true }]);
    await setUp(other.who, [item(other.wallet)]);
    await runAt('2025-11-19T16:00:00Z');
    expect(days(await entries(other.who, other.wallet))).toEqual(['2025-11-20']);
    expect(await entries(stuck.who, stuck.wallet)).toEqual([]);
    for (const r of items) {
      expect(await itemOf(stuck.who, r.id)).toMatchObject({ nextDue: '2025-01-06' });
    }
  });

  it('an item that can’t be added, without holding back the person’s others or anyone else', async () => {
    const me = await someone(KL, 'me');
    const them = await someone(KL, 'them');
    const [fun, tnb] = await setUp(me.who, [
      item(me.wallet, { categoryId: FUN, payee: 'Netflix' }),
      item(me.wallet),
    ]);
    await setUp(them.who, [item(them.wallet)]);
    // Fun archived: an entry can't go in it
    await send(me.who, [{ op: 'archiveCategory', id: FUN, archived: true }]);
    await runAt('2025-11-19T16:00:00Z');
    expect((await entries(me.who, me.wallet)).map((t) => t.payee)).toEqual(['TNB']);
    expect(await itemOf(me.who, fun.id)).toMatchObject({ nextDue: '2025-11-20' });
    expect(await itemOf(me.who, tnb.id)).toMatchObject({ nextDue: '2025-12-20' });
    expect(days(await entries(them.who, them.wallet))).toEqual(['2025-11-20']);
  });
});

describe('items that ask first (D19)', () => {
  // These read today from the real clock, as the server does: never within two minutes of
  // midnight in Kuala Lumpur (16:00 UTC) or in UTC, when the two could read different days
  beforeAll(async () => {
    const nearMidnight = () => {
      const minute = (Date.now() / 60_000) % (24 * 60);
      return [0, 16 * 60, 24 * 60].some((m) => Math.abs(minute - m) < 2);
    };
    while (nearMidnight()) await new Promise((r) => setTimeout(r, 10_000));
  }, 300_000);

  /** The server's today in Kuala Lumpur, and days either side of it on the same weekday */
  const today = () => dayIn(KL, Date.now())!;
  const weeksFrom = (day: string, weeks: number) => {
    let at = day;
    for (let i = 0; i < Math.abs(weeks); i++) {
      at =
        weeks > 0
          ? nextAfter('weekly', dayFor('weekly', day), at)
          : new Date(Date.parse(`${at}T00:00:00Z`) - 7 * 86_400_000).toISOString().slice(0, 10);
    }
    return at;
  };
  const weekly = (accountId: string, nextDue: string) =>
    item(accountId, {
      schedule: 'weekly',
      day: dayFor('weekly', nextDue),
      startDate: weeksFrom(today(), -3),
      nextDue,
    });

  it('one saved with its next due date passed asks first, and the job leaves it', async () => {
    const { who, wallet } = await someone(KL);
    const overdue = weekly(wallet, weeksFrom(today(), -1));
    const ahead = weekly(wallet, weeksFrom(today(), 1));
    await send(who, [
      { op: 'addRecurring', recurring: overdue },
      { op: 'addRecurring', recurring: ahead },
    ]);
    expect(await itemOf(who, overdue.id)).toMatchObject({ askFirst: true, amountVaries: false });
    expect(await itemOf(who, ahead.id)).toMatchObject({ askFirst: false });
    await runAt(new Date().toISOString());
    expect(await entries(who, wallet)).toEqual([]);
  });

  it('keeps asking after Log it or Skip while still overdue, and stops once past today', async () => {
    const { who, wallet } = await someone(KL);
    const twoBack = weeksFrom(today(), -2);
    const r = weekly(wallet, twoBack);
    await send(who, [{ op: 'addRecurring', recurring: r }]);
    const log = (due: string) => ({
      op: 'logRecurring',
      id: r.id,
      due,
      transaction: {
        id: rowId(),
        kind: 'expense',
        accountId: wallet,
        toAccountId: null,
        amountCents: r.amountCents,
        categoryId: BILLS,
        payee: 'TNB',
        note: null,
        date: due,
      },
    });
    await send(who, [log(twoBack)]);
    expect(await itemOf(who, r.id)).toMatchObject({
      nextDue: weeksFrom(today(), -1),
      askFirst: true,
    });
    await send(who, [{ op: 'skipRecurring', id: r.id, due: weeksFrom(today(), -1) }]);
    expect(await itemOf(who, r.id)).toMatchObject({ nextDue: today(), askFirst: true });
    await send(who, [log(today())]);
    expect(await itemOf(who, r.id)).toMatchObject({
      nextDue: weeksFrom(today(), 1),
      askFirst: false,
    });
    // Log it's entry is from Scheduled too, with nothing to check
    const logged = (await entries(who, wallet)).find((t) => t.date === today());
    expect(logged?.scheduled).toEqual({ recurringId: r.id, due: today(), toCheck: false });
    // Undo (moving it back) asks again: nothing is guessed about a bill that may be unpaid
    await send(who, [{ op: 'updateRecurring', id: r.id, nextDue: today() }]);
    expect(await itemOf(who, r.id)).toMatchObject({ askFirst: true });
  });

  it('a person with no time zone yet: their today is UTC\u2019s', async () => {
    const { who, wallet } = await someone(null);
    const utcToday = new Date().toISOString().slice(0, 10);
    const day = (d: number) =>
      new Date(Date.parse(`${utcToday}T00:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
    const yesterday = weekly(wallet, day(-1));
    const tomorrow = weekly(wallet, day(1));
    await send(who, [
      { op: 'addRecurring', recurring: yesterday },
      { op: 'addRecurring', recurring: tomorrow },
    ]);
    expect(await itemOf(who, yesterday.id)).toMatchObject({ askFirst: true });
    expect(await itemOf(who, tomorrow.id)).toMatchObject({ askFirst: false });
  });

  it('one brought back with its next due date passed asks first; one still ahead does not', async () => {
    const { who, wallet } = await someone(KL);
    const passed = weekly(wallet, weeksFrom(today(), 1));
    const ahead = weekly(wallet, weeksFrom(today(), 2));
    await send(who, [
      { op: 'addRecurring', recurring: passed },
      { op: 'addRecurring', recurring: ahead },
    ]);
    await send(who, [
      { op: 'archiveRecurring', id: passed.id, archived: true },
      { op: 'archiveRecurring', id: ahead.id, archived: true },
    ]);
    // While stopped, its day came and went
    await api.sql(
      'UPDATE recurring SET next_due = ? WHERE email = ? AND id = ?',
      weeksFrom(today(), -1),
      who,
      passed.id,
    );
    await send(who, [
      { op: 'archiveRecurring', id: passed.id, archived: false },
      { op: 'archiveRecurring', id: ahead.id, archived: false },
    ]);
    expect(await itemOf(who, passed.id)).toMatchObject({ askFirst: true });
    expect(await itemOf(who, ahead.id)).toMatchObject({ askFirst: false });
  });
});

describe('what the app reads and changes', () => {
  it('saves whether an amount changes, and refuses anything but yes or no', async () => {
    const { who, wallet } = await someone(KL);
    // Next week by the server's clock, on its schedule, so it's added on its day
    const ahead = weeksAhead();
    const tnb = item(wallet, { schedule: 'weekly', day: dayFor('weekly', ahead), nextDue: ahead });
    await send(who, [{ op: 'addRecurring', recurring: tnb }]);
    expect(await itemOf(who, tnb.id)).toMatchObject({ amountVaries: false });
    await send(who, [{ op: 'updateRecurring', id: tnb.id, amountVaries: true }]);
    expect(await itemOf(who, tnb.id)).toMatchObject({ amountVaries: true });
    for (const amountVaries of ['yes', 1, null]) {
      expect(await refused(who, [{ op: 'updateRecurring', id: tnb.id, amountVaries }])).toEqual({
        status: 400,
        data: { error: 'Say whether the amount changes' },
      });
      expect(
        await refused(who, [
          { op: 'addRecurring', recurring: { ...tnb, id: rowId(), amountVaries } },
        ]),
      ).toEqual({ status: 400, data: { error: 'Say whether the amount changes' } });
    }
  });

  it('clears an amount to check once confirmed or changed, and never sets one', async () => {
    const { who, wallet } = await someone(KL);
    await setUp(who, [
      item(wallet, { schedule: 'weekly', day: 1, nextDue: '2025-11-03', amountVaries: true }),
    ]);
    await runAt('2025-11-10T16:00:00Z');
    const [second, first] = await entries(who, wallet);
    expect([first.scheduled?.toCheck, second.scheduled?.toCheck]).toEqual([true, true]);
    // Confirmed as it is
    await send(who, [{ op: 'updateTransaction', id: first.id, toCheck: false }]);
    // Changed to what the bill came to
    await send(who, [{ op: 'updateTransaction', id: second.id, amountCents: 20_450 }]);
    const after = await entries(who, wallet);
    expect(after.map((t) => [t.date, t.amountCents, t.scheduled?.toCheck])).toEqual([
      ['2025-11-10', 20_450, false],
      ['2025-11-03', 18_937, false],
    ]);
    expect(await refused(who, [{ op: 'updateTransaction', id: first.id, toCheck: true }])).toEqual({
      status: 400,
      data: { error: 'An amount is checked, never unchecked' },
    });
  });

  it('adds an entry back from Scheduled (Undo), but only for the person’s own item', async () => {
    const me = await someone(KL, 'me');
    const them = await someone(KL, 'them');
    const [tnb] = await setUp(me.who, [item(me.wallet, { amountVaries: true })]);
    await runAt('2025-11-19T16:00:00Z');
    const [added] = await entries(me.who, me.wallet);
    await send(me.who, [{ op: 'removeTransaction', id: added.id }]);
    const { createdAt: _createdAt, ...back } = added;
    await send(me.who, [{ op: 'addTransaction', transaction: back }]);
    expect((await entries(me.who, me.wallet))[0].scheduled).toEqual({
      recurringId: tnb.id,
      due: '2025-11-20',
      toCheck: true,
    });
    expect(
      await refused(them.who, [
        { op: 'addTransaction', transaction: { ...back, id: rowId(), accountId: them.wallet } },
      ]),
    ).toEqual({ status: 404, data: { error: 'Repeating item not found' } });
  });

  it('counts each item’s entries in the month, with those to check, and finds them', async () => {
    const { who, wallet } = await someone(KL);
    const [rent, tnb] = await setUp(who, [
      item(wallet, { payee: 'Rent', amountCents: 120_000, day: 1, nextDue: '2025-11-01' }),
      item(wallet, { amountVaries: true, day: 3, nextDue: '2025-11-03' }),
    ]);
    await send(who, [
      {
        op: 'addTransaction',
        transaction: {
          id: rowId(),
          kind: 'expense',
          accountId: wallet,
          toAccountId: null,
          amountCents: 900,
          categoryId: BILLS,
          payee: 'Kiosk',
          note: null,
          date: '2025-11-02',
        },
      },
    ]);
    await runAt('2025-11-02T16:00:00Z');
    const [tnbEntry] = (await entries(who, wallet)).filter((t) => t.payee === 'TNB');
    const summary = await api.call(who, 'GET', '/api/summary?month=2025-11');
    expect(summary.data.fromScheduled).toEqual([
      { recurringId: rent.id, entries: 1, firstDate: '2025-11-01', toCheck: [] },
      {
        recurringId: tnb.id,
        entries: 1,
        firstDate: '2025-11-03',
        toCheck: [{ id: tnbEntry.id, date: '2025-11-03', amountCents: 18_937 }],
      },
    ]);
    const october = await api.call(who, 'GET', '/api/summary?month=2025-10');
    expect(october.data.fromScheduled).toBeUndefined();
    const found = await api.call(
      who,
      'GET',
      '/api/search?scheduled=1&from=2025-11-01&to=2025-11-30',
    );
    expect(found.status).toBe(200);
    expect((found.data.transactions as Transaction[]).map((t) => t.payee).sort()).toEqual([
      'Rent',
      'TNB',
    ]);
  });
});

describe('the month start day', () => {
  it('counts entries from Scheduled in the person\u2019s month: from the 25th', async () => {
    const { who, wallet } = await someone(KL);
    const res = await api.call(who, 'PATCH', '/api/me', { settings: { monthStartDay: 25 } });
    expect(res.status).toBe(200);
    const [rent, phone] = await setUp(who, [
      item(wallet, { payee: 'Rent', day: 25, nextDue: '2025-10-25' }),
      item(wallet, { payee: 'Phone', day: 24, nextDue: '2025-11-24' }),
    ]);
    // November 25 in Kuala Lumpur: Rent on October 25 and November 25, Phone on November 24
    await runAt('2025-11-24T16:00:00Z');
    const november = await api.call(who, 'GET', '/api/summary?month=2025-11');
    expect(november.data.fromScheduled).toEqual([
      { recurringId: rent.id, entries: 1, firstDate: '2025-10-25', toCheck: [] },
      { recurringId: phone.id, entries: 1, firstDate: '2025-11-24', toCheck: [] },
    ]);
    const december = await api.call(who, 'GET', '/api/summary?month=2025-12');
    expect(december.data.fromScheduled).toEqual([
      { recurringId: rent.id, entries: 1, firstDate: '2025-11-25', toCheck: [] },
    ]);
  });
});

/** A day within the coming year, on a schedule's own day: next week, by the server's clock */
function weeksAhead() {
  const today = dayIn(KL, Date.now())!;
  return nextAfter('weekly', dayFor('weekly', today), today);
}
