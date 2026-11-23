// Converting a person's amounts (convert.ts), step by step, on the real schema in SQLite
// with a small stand-in for D1 (prepare, bind, first, all, run and batch, a batch all or
// nothing). For what the end-to-end tests can't time: a stale step refusing after a newer
// change began, worked-out rows gone missing before the swap, and the largest history a
// person can have (100,000 transactions on an account) swapped in at once.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { MAX_TRANSACTIONS_PER_ACCOUNT } from '../../shared/ledger';
import { convertCents } from '../../shared/rates';
import {
  type ConvertJob,
  type FetchRate,
  MAX_RESTARTS,
  MAX_START_OVERS,
  PAGE,
  STALLED_MS,
  convertStep,
  restartIfStalled,
  startStatements,
} from '../currency/convert';

const DIR = resolve(__dirname, '../../migrations');
const ME = 'me@example.com';
const ACCOUNT = 'a000000000000001';
const FOOD = 'c000000000000001';

type Param = string | number | null;

/** What `fn` answers, or throws, as a promise does */
const later = <T>(fn: () => T) =>
  new Promise<T>((resolve, reject) => {
    try {
      resolve(fn());
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

/** D1 as convert.ts uses it, over one SQLite database */
function d1(db: DatabaseSync): D1Database {
  const statement = (sql: string, params: Param[] = []) => ({
    sql,
    params,
    bind: (...more: Param[]) => statement(sql, more),
    first: (column?: string) =>
      later(() => {
        const row = db.prepare(sql).get(...params) as Record<string, unknown> | undefined;
        return row == null ? null : column == null ? row : row[column];
      }),
    all: () => later(() => ({ results: db.prepare(sql).all(...params) })),
    run: () => later(() => ({ meta: { changes: Number(db.prepare(sql).run(...params).changes) } })),
  });
  return {
    prepare: (sql: string) => statement(sql),
    batch: (statements: ReturnType<typeof statement>[]) =>
      later(() => {
        db.exec('BEGIN');
        try {
          const results = statements.map((s) => {
            const prepared = db.prepare(s.sql);
            if (/^\s*SELECT/i.test(s.sql)) {
              return { results: prepared.all(...s.params), meta: { changes: 0 } };
            }
            return { results: [], meta: { changes: Number(prepared.run(...s.params).changes) } };
          });
          db.exec('COMMIT');
          return results;
        } catch (err) {
          db.exec('ROLLBACK');
          throw err;
        }
      }),
  } as unknown as D1Database;
}

/** The migrations, in order */
const MIGRATIONS = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const migrate = (db: DatabaseSync, file: string) => db.exec(readFileSync(join(DIR, file), 'utf8'));

/**
 * The schema (up to and including the migration numbered `upTo`, every one without), someone
 * in MYR with an account, a category and `count` entries
 */
function person(count: number, upTo = '9999') {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of MIGRATIONS.filter((f) => f.slice(0, 4) <= upTo)) migrate(db, file);
  db.prepare('INSERT INTO profiles (email, created_at, updated_at) VALUES (?, 1, 1)').run(ME);
  db.prepare('INSERT INTO user_settings (email, updated_at) VALUES (?, 1)').run(ME);
  db.prepare(
    `INSERT INTO accounts (email, id, name, kind, currency, opening_cents, position, created_at, updated_at)
     VALUES (?, ?, 'Wallet', 'cash', 'MYR', 100000, 0, 1, 1)`,
  ).run(ME, ACCOUNT);
  db.prepare(
    `INSERT INTO categories (email, id, name, kind, position, created_at, updated_at)
     VALUES (?, ?, 'Food', 'expense', 0, 1, 1)`,
  ).run(ME, FOOD);
  db.exec('BEGIN');
  const add = db.prepare(
    `INSERT INTO transactions (email, id, kind, account_id, amount_cents, category_id, date, created_at, updated_at)
     VALUES (?, ?, 'expense', ?, ?, ?, ?, 1, 1)`,
  );
  for (let i = 0; i < count; i++) {
    const day = new Date(Date.UTC(2020, 0, 1) + (i % 1500) * 86_400_000).toISOString();
    add.run(ME, i.toString(16).padStart(16, '0'), ACCOUNT, 100 + (i % 977), FOOD, day.slice(0, 10));
  }
  db.exec('COMMIT');
  return db;
}

/** Changes the currency as PATCH /api/me does, answering the job it queues */
async function switchTo(db: DatabaseSync, to: string, since: number): Promise<ConvertJob> {
  const from = (
    db.prepare('SELECT currency FROM user_settings WHERE email = ?').get(ME) as {
      currency: string;
    }
  ).currency;
  db.prepare('UPDATE user_settings SET currency = ? WHERE email = ?').run(to, ME);
  await d1(db).batch(startStatements(d1(db), ME, from, to, since));
  return { email: ME, since };
}

/** The same rate for every day, from Frankfurter */
const flat =
  (rate: number): FetchRate =>
  () =>
    Promise.resolve({ rate, source: 'frankfurter' as const, fetchedAt: 5 });

/** Runs steps until there are none, answering how many there were */
async function runAll(db: DatabaseSync, job: ConvertJob, fetchRate: FetchRate) {
  let steps = 1;
  while (await convertStep(d1(db), job, fetchRate)) steps++;
  return steps;
}

const amounts = (db: DatabaseSync) =>
  db
    .prepare('SELECT amount_cents AS cents, original_cents AS typed FROM transactions ORDER BY id')
    .all() as { cents: number; typed: number | null }[];

describe('converting, step by step', () => {
  it('a year and more of entries, 4,000 of them, takes a handful of steps, not one per 200', async () => {
    const db = person(4_000);
    const job = await switchTo(db, 'USD', 1_000);
    // Each step a page of entries; then the rest and the swap
    expect(await runAll(db, job, flat(0.25))).toBeLessThanOrEqual(3);
    expect(
      amounts(db).every(
        (a) => a.typed != null && a.cents === Math.max(1, convertCents(a.typed, 0.25)),
      ),
    ).toBe(true);
  });

  it("a stale step refused after a newer change began leaves the newer one's work alone", async () => {
    const db = person(3);
    const old = await switchTo(db, 'IDR', 1_000);
    let newer: ConvertJob | null = null;
    // While the old step fetches its rates, the person changes their mind; the old step's
    // rate then puts an amount past its limit
    const fetchRate: FetchRate = async () => {
      if (newer == null) {
        db.prepare("UPDATE user_settings SET currency = 'MYR' WHERE email = ?").run(ME);
        newer = await switchTo(db, 'USD', 2_000);
        db.prepare(
          `INSERT INTO conversion_staged (email, kind, key, cents) VALUES (?, 'transaction', ?, 1)`,
        ).run(ME, '0000000000000000');
      }
      return { rate: 1e9, source: 'frankfurter', fetchedAt: 5 };
    };
    expect(await convertStep(d1(db), old, fetchRate)).toBe(false);
    expect(db.prepare('SELECT since, phase FROM conversions').all()).toEqual([
      { since: 2_000, phase: 'converting' },
    ]);
    expect(db.prepare('SELECT currency FROM user_settings').get()).toEqual({ currency: 'USD' });
    expect(db.prepare('SELECT key FROM conversion_staged').all()).toEqual([
      { key: '0000000000000000' },
    ]);
  });

  it('starts over rather than swap in when a worked-out amount has gone missing', async () => {
    const db = person(3);
    const job = await switchTo(db, 'USD', 1_000);
    // The one page of transactions, worked out
    expect(await convertStep(d1(db), job, flat(0.5))).toBe(true);
    db.prepare("DELETE FROM conversion_staged WHERE key = '0000000000000001'").run();
    // Not swapped: back to the first transaction
    expect(await convertStep(d1(db), job, flat(0.5))).toBe(true);
    expect(amounts(db).map((a) => a.typed)).toEqual([null, null, null]);
    expect(db.prepare('SELECT after_date, after_id FROM conversions').get()).toEqual({
      after_date: '',
      after_id: '',
    });
    await runAll(db, job, flat(0.5));
    expect(amounts(db)).toEqual([
      { cents: 50, typed: 100 },
      { cents: 51, typed: 101 },
      { cents: 51, typed: 102 },
    ]);
  });

  it('a conversion under way as 0014 rebuilds its worked-out amounts starts over once, and finishes', async () => {
    const db = person(2 * PAGE + 50, '0013');
    // The columns (0015) this code reads, which land with 0014 in one deploy
    migrate(db, MIGRATIONS.find((f) => f.startsWith('0015'))!);
    const before = amounts(db);
    const job = await switchTo(db, 'USD', 1_000);
    // Two pages of three worked out, then the migration lands
    expect(await convertStep(d1(db), job, flat(0.5))).toBe(true);
    expect(await convertStep(d1(db), job, flat(0.5))).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversion_staged').get()).toEqual({
      n: 2 * PAGE,
    });
    migrate(db, MIGRATIONS.find((f) => f.startsWith('0014'))!);
    // 0015 follows it in the same deploy, adding back the column it gives worked-out amounts
    db.exec('ALTER TABLE conversion_staged ADD COLUMN rate_day TEXT');
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversion_staged').get()).toEqual({ n: 0 });

    let startOvers = 0;
    while (await convertStep(d1(db), job, flat(0.5))) {
      const row = db.prepare('SELECT start_overs FROM conversions').get() as
        | { start_overs: number }
        | undefined;
      startOvers = Math.max(startOvers, row?.start_overs ?? 0);
    }
    expect(startOvers).toBe(1);
    // Finished: every amount converted once, from what was typed, and nothing left over
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversions').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversion_staged').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT currency FROM accounts').get()).toEqual({ currency: 'USD' });
    expect(amounts(db)).toEqual(
      before.map(({ cents }) => ({ cents: Math.round(cents * 0.5), typed: cents })),
    );
  });

  it('gives the currency back when it keeps finding worked-out amounts gone, rather than loop', async () => {
    const db = person(3);
    const job = await switchTo(db, 'USD', 1_000);
    let steps = 0;
    while (steps < 20 && (await convertStep(d1(db), job, flat(0.5)))) {
      steps++;
      // Each time every transaction is worked out, one goes missing again
      const { n } = db
        .prepare("SELECT COUNT(*) AS n FROM conversion_staged WHERE kind = 'transaction'")
        .get() as { n: number };
      if (n === 3) db.prepare("DELETE FROM conversion_staged WHERE key = '0000000000000001'").run();
    }
    expect(steps).toBeLessThan(20);
    expect(db.prepare('SELECT phase, refused, start_overs FROM conversions').get()).toEqual({
      phase: 'refused',
      refused: 'rates',
      start_overs: MAX_START_OVERS,
    });
    expect(db.prepare('SELECT currency FROM user_settings').get()).toEqual({ currency: 'MYR' });
    expect(amounts(db).map((x) => x.typed)).toEqual([null, null, null]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversion_staged').get()).toEqual({ n: 0 });
  });

  /** Each later than the last by more than a stall */
  let clock = Date.now();
  /** The profile read restartStalled answers to, long after the last step: started again */
  const stalled = async (db: DatabaseSync) => {
    const queued: ConvertJob[] = [];
    clock += 10 * STALLED_MS;
    await restartIfStalled(d1(db), ME, (job) => Promise.resolve(void queued.push(job)), clock);
    return queued;
  };

  it('keeps converting through separate stalls, each followed by a step that moves on', async () => {
    const db = person(PAGE * (MAX_RESTARTS + 1) + 1);
    const job = await switchTo(db, 'USD', 1_000);
    for (let stall = 0; stall <= MAX_RESTARTS; stall++) {
      // Started again, and its step moves on through a page
      expect(await stalled(db)).toEqual([job]);
      expect(await convertStep(d1(db), job, flat(0.5))).toBe(true);
    }
    await runAll(db, job, flat(0.5));
    expect(db.prepare('SELECT * FROM conversions').all()).toEqual([]);
    expect(db.prepare('SELECT currency FROM user_settings').get()).toEqual({ currency: 'USD' });
    expect(amounts(db)[0]).toEqual({ cents: 50, typed: 100 });
  });

  it('gives the currency back once it has stalled too often in a row', async () => {
    const db = person(3);
    const job = await switchTo(db, 'USD', 1_000);
    for (let stall = 0; stall < MAX_RESTARTS; stall++) expect(await stalled(db)).toEqual([job]);
    expect(await stalled(db)).toEqual([]);
    expect(db.prepare('SELECT phase, refused FROM conversions').get()).toEqual({
      phase: 'refused',
      refused: 'rates',
    });
    expect(db.prepare('SELECT currency FROM user_settings').get()).toEqual({ currency: 'MYR' });
  });

  it('carries on in the next step when a step has asked for all the rates it may', async () => {
    const db = person(5);
    const job = await switchTo(db, 'USD', 1_000);
    // Two rates a step, then none until the next
    let asked = 0;
    const fewAStep: FetchRate = () =>
      Promise.resolve(
        asked++ < 2 ? { rate: 0.5, source: 'frankfurter' as const, fetchedAt: 5 } : null,
      );
    expect(await convertStep(d1(db), job, fewAStep)).toBe(true);
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversion_staged').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT after_id FROM conversions').get()).toEqual({
      after_id: '0000000000000001',
    });
    let steps = 1;
    do {
      asked = 0;
      steps++;
    } while (steps < 20 && (await convertStep(d1(db), job, fewAStep)));
    expect(db.prepare('SELECT * FROM conversions').all()).toEqual([]);
    expect(amounts(db)).toEqual([
      { cents: 50, typed: 100 },
      { cents: 51, typed: 101 },
      { cents: 51, typed: 102 },
      { cents: 52, typed: 103 },
      { cents: 52, typed: 104 },
    ]);
  });

  it('works out openings in many currencies over several steps, asking for each rate once', async () => {
    const db = person(0);
    const typedIn = ['AUD', 'CAD', 'CHF', 'CNY', 'DKK', 'EUR', 'GBP', 'HKD', 'JPY', 'SGD'];
    typedIn.forEach((currency, i) => {
      db.prepare(
        `INSERT INTO accounts (email, id, name, kind, currency, opening_cents, position, created_at,
           updated_at, original_currency, original_cents, rate, rate_source, rate_at)
         VALUES (?, ?, ?, 'cash', 'MYR', 100, ?, 1, 1, ?, 1000, 0.1, 'wise', 5)`,
      ).run(ME, `b${String(i).padStart(15, '0')}`, `In ${currency}`, i + 1, currency);
    });
    const job = await switchTo(db, 'USD', 1_000);
    // Three rates a step, as if the services could be asked only so often; each counted
    const asked = new Map<string, number>();
    let thisStep = 0;
    const fewAStep: FetchRate = (from) => {
      if (thisStep++ >= 3) return Promise.resolve(null);
      asked.set(from, (asked.get(from) ?? 0) + 1);
      return Promise.resolve({ rate: 2, source: 'frankfurter' as const, fetchedAt: 5 });
    };
    let steps = 0;
    let more = true;
    while (more && steps < 20) {
      thisStep = 0;
      steps++;
      more = await convertStep(d1(db), job, fewAStep);
    }
    // Each step went on from the last, never a retry: the wallet's and 10 more, 3 a step
    expect(steps).toBe(4);
    expect(db.prepare('SELECT * FROM conversions').all()).toEqual([]);
    expect([...asked.entries()].sort()).toEqual(['MYR', ...typedIn].sort().map((c) => [c, 1]));
    expect(
      db.prepare("SELECT DISTINCT opening_cents AS cents FROM accounts WHERE id LIKE 'b%'").all(),
    ).toEqual([{ cents: 2_000 }]);
    expect(db.prepare('SELECT currency FROM user_settings').get()).toEqual({ currency: 'USD' });
  });

  it.each([
    ['a transaction', 1],
    ['an opening balance', 0],
  ])('throws, for the queue to try again, when no rate at all can be had for %s', async (_, n) => {
    const db = person(n);
    const job = await switchTo(db, 'USD', 1_000);
    await expect(convertStep(d1(db), job, () => Promise.resolve(null))).rejects.toThrow(
      'No rate could be had',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversion_staged').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT phase FROM conversions').get()).toEqual({ phase: 'converting' });
  });

  it('swaps in the most transactions an account can hold, and back exactly', async () => {
    const db = person(MAX_TRANSACTIONS_PER_ACCOUNT);
    const before = amounts(db);
    const there = await switchTo(db, 'USD', 1_000);
    const steps = await runAll(db, there, flat(0.25));
    expect(steps).toBe(Math.ceil(MAX_TRANSACTIONS_PER_ACCOUNT / PAGE) + 1);
    const converted = amounts(db);
    expect(converted.every((a, i) => a.typed === before[i].cents)).toBe(true);
    expect(converted[0]).toEqual({ cents: 25, typed: 100 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversion_staged').get()).toEqual({ n: 0 });

    await runAll(db, await switchTo(db, 'MYR', 2_000), flat(4));
    expect(amounts(db)).toEqual(before);
  }, 240_000);
});
