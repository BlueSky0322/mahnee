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
import { type ConvertJob, type FetchRate, convertStep, startStatements } from '../currency/convert';

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

/** The schema, someone in MYR with an account, a category and `count` entries */
function person(count: number) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of readdirSync(DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()) {
    db.exec(readFileSync(join(DIR, file), 'utf8'));
  }
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

  it('swaps in the most transactions an account can hold, and back exactly', async () => {
    const db = person(MAX_TRANSACTIONS_PER_ACCOUNT);
    const before = amounts(db);
    const there = await switchTo(db, 'USD', 1_000);
    const steps = await runAll(db, there, flat(0.25));
    expect(steps).toBe(MAX_TRANSACTIONS_PER_ACCOUNT / 200 + 1);
    const converted = amounts(db);
    expect(converted.every((a, i) => a.typed === before[i].cents)).toBe(true);
    expect(converted[0]).toEqual({ cents: 25, typed: 100 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversion_staged').get()).toEqual({ n: 0 });

    await runAll(db, await switchTo(db, 'MYR', 2_000), flat(4));
    expect(amounts(db)).toEqual(before);
  }, 240_000);
});
