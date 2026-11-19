// The migrations, run in order on SQLite (as D1 runs them, with foreign keys on). 0007
// rebuilds the settings table for the redesign: it runs here on a database at the schema
// before it, holding rows, to show every row comes through, with each stored accent
// mapped to the redesign's and every new setting at the design's default.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';
import { HOME_CURRENCIES } from '../../shared/rates';

const DIR = resolve(__dirname, '../../migrations');
const files = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();
const before0007 = files.filter((f) => f < '0007');
const SETTINGS_MIGRATION = '0007_settings.sql';

function database(migrations: string[]) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const file of migrations) db.exec(readFileSync(join(DIR, file), 'utf8'));
  return db;
}

const T = 1_700_000_000_000;

/** Today's rows: six people, one with each accent there was, and one with only a name */
function seedToday(db: DatabaseSync) {
  const accents = ['blurple', 'blue', 'teal', 'green', 'amber', 'rose'];
  for (const [i, accent] of accents.entries()) {
    const email = `${accent}@example.com`;
    db.prepare('INSERT INTO profiles (email, created_at, updated_at) VALUES (?, ?, ?)').run(
      email,
      T,
      T,
    );
    db.prepare(
      `INSERT INTO user_settings (email, theme, accent, rate_preference, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(email, ['dark', 'light', 'auto'][i % 3], accent, i % 2 ? 'ecb' : 'wise', T + i);
  }
  db.prepare(
    'INSERT INTO profiles (email, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)',
  ).run('named@example.com', 'Named', T, T);
  const owner = 'teal@example.com';
  db.prepare(
    `INSERT INTO accounts (email, id, name, kind, currency, opening_cents, position, created_at, updated_at)
     VALUES (?, 'a000000000000001', 'Wallet', 'cash', 'MYR', 1000, 0, ?, ?)`,
  ).run(owner, T, T);
  db.prepare(
    `INSERT INTO categories (email, id, name, kind, position, created_at, updated_at)
     VALUES (?, 'c000000000000001', 'Food', 'expense', 0, ?, ?)`,
  ).run(owner, T, T);
  for (let d = 1; d <= 3; d++) {
    db.prepare(
      `INSERT INTO transactions (email, id, kind, account_id, amount_cents, category_id, payee, date, created_at, updated_at)
       VALUES (?, ?, 'expense', 'a000000000000001', ?, 'c000000000000001', 'Shop', ?, ?, ?)`,
    ).run(owner, `b00000000000000${d}`, 1234 * d, `2026-11-0${d}`, T + d, T + d);
  }
}

const all = (db: DatabaseSync, sql: string, ...params: (string | number | null)[]) =>
  db.prepare(sql).all(...params) as Record<string, unknown>[];

/** SQLite's code for a broken rule: a CHECK, foreign key, NOT NULL or a trigger's refusal */
const SQLITE_CONSTRAINT = 19;

/** Whether the database takes `sql`, or refuses it for breaking a rule */
function takes(db: DatabaseSync, sql: string, ...params: (string | number | null)[]) {
  try {
    db.prepare(sql).run(...params);
    return true;
  } catch (err) {
    const code = (err as { errcode?: unknown }).errcode;
    if (typeof code === 'number' && (code & 0xff) === SQLITE_CONSTRAINT) return false;
    throw err;
  }
}

describe('the migrations', () => {
  it('number each one once, in order, with 0007 for the settings', () => {
    const numbers = files.map((f) => f.slice(0, 4));
    expect(numbers).toEqual(numbers.map((_, i) => String(i + 1).padStart(4, '0')));
    expect(files).toContain(SETTINGS_MIGRATION);
  });

  it('build an empty database from nothing', () => {
    const db = database(files);
    const tables = all(db, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name");
    expect(tables.map((t) => t.name)).toEqual(
      expect.arrayContaining(['user_settings', 'transactions', 'imports']),
    );
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});

describe('0007, on a database holding rows', () => {
  const migrated = () => {
    const db = database(before0007);
    seedToday(db);
    db.exec(readFileSync(join(DIR, SETTINGS_MIGRATION), 'utf8'));
    return db;
  };

  it('keeps every settings row, its theme, rate source and time, and maps the accent', () => {
    const rows = all(
      migrated(),
      'SELECT email, theme, accent, rate_preference, updated_at FROM user_settings ORDER BY updated_at',
    );
    expect(rows).toEqual([
      {
        email: 'blurple@example.com',
        theme: 'dark',
        accent: 'cobalt',
        rate_preference: 'wise',
        updated_at: T,
      },
      {
        email: 'blue@example.com',
        theme: 'light',
        accent: 'cobalt',
        rate_preference: 'ecb',
        updated_at: T + 1,
      },
      {
        email: 'teal@example.com',
        theme: 'auto',
        accent: 'cobalt',
        rate_preference: 'wise',
        updated_at: T + 2,
      },
      {
        email: 'green@example.com',
        theme: 'dark',
        accent: 'green',
        rate_preference: 'ecb',
        updated_at: T + 3,
      },
      {
        email: 'amber@example.com',
        theme: 'light',
        accent: 'cobalt',
        rate_preference: 'wise',
        updated_at: T + 4,
      },
      {
        email: 'rose@example.com',
        theme: 'auto',
        accent: 'cobalt',
        rate_preference: 'ecb',
        updated_at: T + 5,
      },
    ]);
  });

  it("gives every existing row the design's defaults for the new settings", () => {
    const rows = all(
      migrated(),
      `SELECT week_start, month_start_mode, month_start_day, month_start_pay_id, start_screen,
         home_density, start_with, default_account_id, suggest_as_you_type, ask_for_time,
         expense_colour, carry_over_default, daily_reminder, reminder_time,
         scheduled_reminder_days, time_zone
       FROM user_settings`,
    );
    expect(rows).toHaveLength(6);
    for (const row of rows) {
      expect(row).toEqual({
        week_start: 'monday',
        month_start_mode: 'date',
        month_start_day: 1,
        month_start_pay_id: null,
        start_screen: 'home',
        home_density: 'everything',
        start_with: 'amount',
        default_account_id: null,
        suggest_as_you_type: 1,
        ask_for_time: 0,
        expense_colour: 'ink',
        carry_over_default: 1,
        daily_reminder: 1,
        reminder_time: '21:00',
        scheduled_reminder_days: 1,
        time_zone: null,
      });
    }
  });

  it('keeps every profile, account and transaction, the transactions with no time or import', () => {
    const db = migrated();
    expect(all(db, 'SELECT email, display_name FROM profiles ORDER BY email')).toHaveLength(7);
    expect(all(db, 'SELECT id FROM accounts')).toEqual([{ id: 'a000000000000001' }]);
    expect(
      all(db, 'SELECT id, amount_cents, date, time, import_id FROM transactions ORDER BY id'),
    ).toEqual([
      {
        id: 'b000000000000001',
        amount_cents: 1234,
        date: '2026-11-01',
        time: null,
        import_id: null,
      },
      {
        id: 'b000000000000002',
        amount_cents: 2468,
        date: '2026-11-02',
        time: null,
        import_id: null,
      },
      {
        id: 'b000000000000003',
        amount_cents: 3702,
        date: '2026-11-03',
        time: null,
        import_id: null,
      },
    ]);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('deletes a profile with its settings, as before', () => {
    const db = migrated();
    db.prepare("DELETE FROM profiles WHERE email = 'green@example.com'").run();
    expect(all(db, "SELECT email FROM user_settings WHERE email = 'green@example.com'")).toEqual(
      [],
    );
  });
});

describe('the rules 0007 holds in the database too', () => {
  const ME = 'teal@example.com';
  // Each test starts from a fresh copy; within one, the cases run in order on one row
  let db: DatabaseSync;
  beforeEach(() => {
    const d = database(before0007);
    seedToday(d);
    d.exec(readFileSync(join(DIR, SETTINGS_MIGRATION), 'utf8'));
    // A pay and a second person's account and pay
    d.prepare(
      "INSERT INTO profiles (email, created_at, updated_at) VALUES ('them@example.com', 1, 1)",
    ).run();
    d.prepare(
      `INSERT INTO accounts (email, id, name, kind, currency, opening_cents, position, created_at, updated_at)
       VALUES ('them@example.com', 'a0000000000000ff', 'Theirs', 'bank', 'MYR', 0, 0, 1, 1)`,
    ).run();
    for (const [email, id, account] of [
      [ME, 'd000000000000001', 'a000000000000001'],
      ['them@example.com', 'd0000000000000ff', 'a0000000000000ff'],
    ]) {
      d.prepare(
        `INSERT INTO recurring (email, id, kind, account_id, amount_cents, category_id, payee, schedule, day, start_date, next_due, position, created_at, updated_at)
         VALUES (?, ?, 'transfer', ?, 100, NULL, 'Pay', 'monthly', 25, '2025-10-25', '2026-11-25', 0, 1, 1)`,
      ).run(email, id, account);
    }
    db = d;
  });

  const setting = (column: string, value: string | number | null) =>
    takes(db, `UPDATE user_settings SET ${column} = ? WHERE email = ?`, value, ME);

  it.each<[string, (string | number | null)[], (string | number | null)[]]>([
    [
      'accent',
      ['cobalt', 'green', 'plum', 'rust', 'graphite'],
      ['blurple', 'teal', 'Cobalt', null],
    ],
    ['week_start', ['monday', 'sunday'], ['saturday', null]],
    // A number written as text ('1') is stored as the number, by the column's type
    ['month_start_day', [1, 15, 28, 31], [0, 29, 30, 32, 1.5, null]],
    ['start_screen', ['home', 'activity', 'plan'], ['accounts', null]],
    ['home_density', ['essentials', 'everything'], ['compact', null]],
    ['start_with', ['amount', 'category'], ['payee', null]],
    ['suggest_as_you_type', [0, 1], [2, 'yes', null]],
    ['ask_for_time', [0, 1], [2, null]],
    ['expense_colour', ['ink', 'red'], ['blue', null]],
    ['carry_over_default', [0, 1], [-1, null]],
    ['daily_reminder', [0, 1], [2, null]],
    [
      'reminder_time',
      ['00:00', '07:45', '23:59'],
      ['24:00', '9:00', '21:60', '21:00:00', 2100, null],
    ],
    ['scheduled_reminder_days', [null, 1, 7], [0, 8, 1.5]],
    [
      'time_zone',
      [null, 'UTC', 'Asia/Kathmandu', 'America/Argentina/Buenos_Aires', 'Etc/GMT+5'],
      ['', '+05:45', 'Asia/Kuala Lumpur', `Asia/${'x'.repeat(60)}`],
    ],
  ])('%s takes what the API takes, and nothing else', (column, good, bad) => {
    expect(good.filter((v) => !setting(column, v))).toEqual([]);
    expect(bad.filter((v) => setting(column, v))).toEqual([]);
  });

  it('month starts on payday only with a pay of your own', () => {
    expect(setting('month_start_mode', 'weekly')).toBe(false);
    expect(setting('month_start_mode', 'payday')).toBe(false);
    expect(setting('month_start_pay_id', 'd0000000000000ff')).toBe(false);
    expect(setting('month_start_pay_id', 'd000000000000009')).toBe(false);
    expect(setting('month_start_pay_id', 'd000000000000001')).toBe(true);
    expect(setting('month_start_mode', 'payday')).toBe(true);
    expect(setting('month_start_pay_id', null)).toBe(false);
    expect(setting('month_start_mode', 'date')).toBe(true);
  });

  it('uses only one of your own accounts by default', () => {
    expect(setting('default_account_id', 'a0000000000000ff')).toBe(false);
    expect(setting('default_account_id', 'a000000000000009')).toBe(false);
    expect(setting('default_account_id', 'a000000000000001')).toBe(true);
    expect(setting('default_account_id', null)).toBe(true);
  });

  it('takes a time of day on a transaction, or none', () => {
    const time = (value: string | number | null) =>
      takes(db, "UPDATE transactions SET time = ? WHERE id = 'b000000000000001'", value);
    expect([null, '00:00', '08:12', '23:59'].filter((v) => !time(v))).toEqual([]);
    expect(['24:00', '8:12', '08:60', '08:12:00', 812, ''].filter((v) => time(v))).toEqual([]);
  });

  it('records an import, and marks transactions with only your own imports', () => {
    const record = (
      email: string,
      id: string,
      fileName: string,
      account: string | null,
      added = 38,
      skipped = 4,
    ) =>
      takes(
        db,
        `INSERT INTO imports (email, id, file_name, account_id, added_count, skipped_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1)`,
        email,
        id,
        fileName,
        account,
        added,
        skipped,
      );
    expect(record(ME, 'e000000000000001', 'bank-oct.csv', 'a000000000000001')).toBe(true);
    // A Mahnee export goes into every account it names, so none is recorded
    expect(record(ME, 'e000000000000002', 'mahnee-export.csv', null)).toBe(true);
    expect(record('them@example.com', 'e0000000000000ff', 'theirs.csv', 'a0000000000000ff')).toBe(
      true,
    );

    expect(record(ME, 'e000000000000003', 'x.csv', 'a0000000000000ff')).toBe(false);
    expect(record(ME, 'not-an-id', 'x.csv', null)).toBe(false);
    expect(record(ME, 'e000000000000004', '', null)).toBe(false);
    expect(record(ME, 'e000000000000005', 'x'.repeat(256), null)).toBe(false);
    expect(record(ME, 'e000000000000006', 'x.csv', null, -1)).toBe(false);
    expect(record(ME, 'e000000000000007', 'x.csv', null, 5001)).toBe(false);
    expect(record(ME, 'e000000000000008', 'x.csv', null, 0, 5001)).toBe(false);

    const mark = (importId: string | null) =>
      takes(db, "UPDATE transactions SET import_id = ? WHERE id = 'b000000000000002'", importId);
    expect(mark('e000000000000001')).toBe(true);
    expect(mark(null)).toBe(true);
    expect(mark('e0000000000000ff')).toBe(false);
    expect(mark('e000000000000009')).toBe(false);
    const add = (importId: string) =>
      takes(
        db,
        `INSERT INTO transactions (email, id, kind, account_id, amount_cents, category_id, date, import_id, created_at, updated_at)
         VALUES (?, ?, 'expense', 'a000000000000001', 100, 'c000000000000001', '2026-11-05', ?, 1, 1)`,
        ME,
        `f0000000000000${importId.slice(-2)}`,
        importId,
      );
    expect(add('e000000000000002')).toBe(true);
    expect(add('e0000000000000ff')).toBe(false);
  });

  it('lets an import go, its entries kept with no import named', () => {
    db.prepare(
      `INSERT INTO imports (email, id, file_name, account_id, added_count, skipped_count, created_at)
       VALUES (?, 'e000000000000001', 'bank-oct.csv', 'a000000000000001', 2, 0, 1)`,
    ).run(ME);
    db.prepare(
      "UPDATE transactions SET import_id = 'e000000000000001' WHERE id IN ('b000000000000001', 'b000000000000002')",
    ).run();
    db.prepare("DELETE FROM imports WHERE id = 'e000000000000001'").run();
    expect(all(db, 'SELECT id, import_id FROM transactions ORDER BY id')).toEqual([
      { id: 'b000000000000001', import_id: null },
      { id: 'b000000000000002', import_id: null },
      { id: 'b000000000000003', import_id: null },
    ]);
  });

  it('deletes a profile with a default account, a pay and an import, and all it holds', () => {
    expect(setting('default_account_id', 'a000000000000001')).toBe(true);
    expect(setting('month_start_pay_id', 'd000000000000001')).toBe(true);
    expect(setting('month_start_mode', 'payday')).toBe(true);
    db.prepare(
      `INSERT INTO imports (email, id, file_name, account_id, added_count, skipped_count, created_at)
       VALUES (?, 'e000000000000001', 'bank-oct.csv', 'a000000000000001', 3, 0, 1)`,
    ).run(ME);
    db.prepare("UPDATE transactions SET import_id = 'e000000000000001'").run();
    db.prepare('DELETE FROM profiles WHERE email = ?').run(ME);
    for (const table of ['user_settings', 'accounts', 'recurring', 'transactions', 'imports']) {
      expect(all(db, `SELECT * FROM ${table} WHERE email = ?`, ME)).toEqual([]);
    }
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });
});

// 0008 keeps the day an account was archived ("archived Jun 2" on Accounts). Accounts
// archived before it have no day kept: updated_at moves with any edit, so it isn't taken
// for one.
describe('0008, the day an account was archived', () => {
  const ARCHIVED_MIGRATION = '0008_account_archived_at.sql';
  const OWNER = 'teal@example.com';
  const migrated = () => {
    const db = database(before0007);
    seedToday(db);
    db.exec(readFileSync(join(DIR, SETTINGS_MIGRATION), 'utf8'));
    db.prepare(
      `INSERT INTO accounts (email, id, name, kind, currency, opening_cents, position, archived, created_at, updated_at)
       VALUES (?, 'a000000000000002', 'Old', 'ewallet', 'MYR', 0, 1, 1, ?, ?)`,
    ).run(OWNER, T, T + 9);
    db.exec(readFileSync(join(DIR, ARCHIVED_MIGRATION), 'utf8'));
    return db;
  };

  it('is the next migration after the settings', () => {
    expect(files).toContain(ARCHIVED_MIGRATION);
  });

  it('keeps every account as it was, with no day for any, archived or not', () => {
    expect(
      all(
        migrated(),
        'SELECT id, name, archived, archived_at, updated_at FROM accounts ORDER BY id',
      ),
    ).toEqual([
      { id: 'a000000000000001', name: 'Wallet', archived: 0, archived_at: null, updated_at: T },
      { id: 'a000000000000002', name: 'Old', archived: 1, archived_at: null, updated_at: T + 9 },
    ]);
  });

  it('takes a day only on an archived account, as a whole number of ms', () => {
    const db = migrated();
    const set = (id: string, archived: number, at: unknown) =>
      takes(
        db,
        'UPDATE accounts SET archived = ?, archived_at = ? WHERE id = ?',
        archived,
        at as number,
        id,
      );
    expect(set('a000000000000002', 1, T + 20)).toBe(true);
    expect(set('a000000000000001', 0, T + 20)).toBe(false);
    expect(set('a000000000000002', 1, 'Aug 14')).toBe(false);
    expect(set('a000000000000002', 1, 1.5)).toBe(false);
    expect(set('a000000000000002', 0, null)).toBe(true);
  });
});

// 0009 is Scheduled (owner decisions D8 and D19): each item says whether its amount
// changes (added for the person to check) and whether it asks first (Log it or Skip on
// Home); each transaction can say which scheduled occurrence it came from and whether its
// amount is still to check. Items already overdue on the day it runs (its own date, UTC)
// keep asking, one last time; every other item is added on its day from then on.
describe('0009, Scheduled', () => {
  const SCHEDULED_MIGRATION = '0009_scheduled.sql';
  const OWNER = 'teal@example.com';
  const ITEM = 'e000000000000001';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

  /** Today's rows, 0007 and 0008, and repeating items due before, on and after the day it runs */
  const migrated = () => {
    // Today's rows go in at the schema they were written for, then 0007 and 0008 run
    const db = database(before0007);
    seedToday(db);
    for (const file of files.filter((f) => f >= '0007' && f < '0009')) {
      db.exec(readFileSync(join(DIR, file), 'utf8'));
    }
    const now = Date.now();
    const [yesterday, today, tomorrow] = [-1, 0, 1].map((d) => utcDay(now + d * DAY_MS));
    const item = (id: string, nextDue: string, archived: number) =>
      db
        .prepare(
          `INSERT INTO recurring (email, id, kind, account_id, amount_cents, category_id, payee,
                                  schedule, day, start_date, next_due, position, archived,
                                  created_at, updated_at)
           VALUES (?, ?, 'expense', 'a000000000000001', 5490, 'c000000000000001', 'Netflix',
                   'weekly', 1, '2026-01-05', ?, ?, ?, ?, ?)`,
        )
        .run(OWNER, id, nextDue, Number(id.slice(-1)), archived, T, T);
    item('e000000000000001', '2026-01-05', 0);
    item('e000000000000002', yesterday, 0);
    item('e000000000000003', today, 0);
    item('e000000000000004', tomorrow, 0);
    item('e000000000000005', '2026-01-05', 1);
    // Running, on an account since archived: it asks first once the account is back
    db.prepare(
      `INSERT INTO accounts (email, id, name, kind, currency, opening_cents, position, archived, created_at, updated_at)
       VALUES (?, 'a000000000000003', 'Old', 'bank', 'MYR', 0, 2, 1, ?, ?)`,
    ).run(OWNER, T, T);
    db.prepare(
      `INSERT INTO recurring (email, id, kind, account_id, amount_cents, category_id, payee,
                              schedule, day, start_date, next_due, position, created_at, updated_at)
       VALUES (?, 'e000000000000006', 'expense', 'a000000000000003', 100, 'c000000000000001',
               'Old loan', 'monthly', 5, '2026-01-05', '2026-01-05', 6, ?, ?)`,
    ).run(OWNER, T, T);
    db.exec(readFileSync(join(DIR, SCHEDULED_MIGRATION), 'utf8'));
    return { db, ranOn: today, after: utcDay(Date.now()) };
  };

  /** Migrated on one day from start to end (tried again once if it ran across midnight UTC) */
  const migratedOnOneDay = () => {
    const first = migrated();
    return first.ranOn === first.after ? first : migrated();
  };

  it('is the next migration after the archived day', () => {
    expect(files).toContain(SCHEDULED_MIGRATION);
    expect(files.indexOf(SCHEDULED_MIGRATION)).toBe(
      files.indexOf('0008_account_archived_at.sql') + 1,
    );
  });

  it('asks first about every running item due on or before the day it runs, and no other', () => {
    const { db } = migratedOnOneDay();
    expect(all(db, 'SELECT id, amount_varies, ask_first FROM recurring ORDER BY id')).toEqual([
      { id: 'e000000000000001', amount_varies: 0, ask_first: 1 },
      { id: 'e000000000000002', amount_varies: 0, ask_first: 1 },
      { id: 'e000000000000003', amount_varies: 0, ask_first: 1 },
      // Due tomorrow in UTC, though maybe today in a zone ahead of UTC: not overdue, so the
      // job adds it on its day
      { id: 'e000000000000004', amount_varies: 0, ask_first: 0 },
      { id: 'e000000000000005', amount_varies: 0, ask_first: 0 },
      { id: 'e000000000000006', amount_varies: 0, ask_first: 1 },
    ]);
  });

  it('keeps every transaction as it was, none from Scheduled and none to check', () => {
    const { db } = migratedOnOneDay();
    expect(
      all(
        db,
        'SELECT id, amount_cents, recurring_id, recurring_due, to_check FROM transactions ORDER BY id',
      ),
    ).toEqual([
      {
        id: 'b000000000000001',
        amount_cents: 1234,
        recurring_id: null,
        recurring_due: null,
        to_check: 0,
      },
      {
        id: 'b000000000000002',
        amount_cents: 2468,
        recurring_id: null,
        recurring_due: null,
        to_check: 0,
      },
      {
        id: 'b000000000000003',
        amount_cents: 3702,
        recurring_id: null,
        recurring_due: null,
        to_check: 0,
      },
    ]);
    expect(all(db, 'PRAGMA foreign_key_check')).toEqual([]);
  });

  it('takes only 0 or 1 for whether an amount changes and whether to ask first', () => {
    const { db } = migratedOnOneDay();
    const set = (column: string, value: unknown) =>
      takes(db, `UPDATE recurring SET ${column} = ? WHERE id = ?`, value as number, ITEM);
    for (const column of ['amount_varies', 'ask_first']) {
      expect(set(column, 1)).toBe(true);
      expect(set(column, 0)).toBe(true);
      expect(set(column, 2)).toBe(false);
      // Whole numbers only: not a fraction, nor words
      expect(set(column, 1.5)).toBe(false);
      expect(set(column, 'yes')).toBe(false);
      expect(set(column, null)).toBe(false);
    }
  });

  it('links a transaction only to its own person’s item, with the day it was due', () => {
    const { db } = migratedOnOneDay();
    const mark = (id: string, recurringId: unknown, due: unknown, toCheck: unknown) =>
      takes(
        db,
        'UPDATE transactions SET recurring_id = ?, recurring_due = ?, to_check = ? WHERE id = ?',
        recurringId as string,
        due as string,
        toCheck as number,
        id,
      );
    expect(mark('b000000000000001', ITEM, '2026-01-05', 1)).toBe(true);
    expect(mark('b000000000000001', ITEM, '2026-01-05', 0)).toBe(true);
    // An item the person doesn't have, or someone else's
    expect(mark('b000000000000002', 'e00000000000000f', '2026-01-05', 0)).toBe(false);
    db.prepare(
      `INSERT INTO accounts (email, id, name, kind, currency, opening_cents, position, created_at, updated_at)
       VALUES ('blue@example.com', 'a000000000000009', 'Theirs', 'cash', 'MYR', 0, 0, ?, ?)`,
    ).run(T, T);
    db.prepare(
      `INSERT INTO categories (email, id, name, kind, position, created_at, updated_at)
       VALUES ('blue@example.com', 'c000000000000009', 'Bills', 'expense', 0, ?, ?)`,
    ).run(T, T);
    db.prepare(
      `INSERT INTO recurring (email, id, kind, account_id, amount_cents, category_id, payee,
                              schedule, day, start_date, next_due, position, created_at, updated_at)
       VALUES ('blue@example.com', 'e000000000000009', 'expense', 'a000000000000009', 100,
               'c000000000000009', 'Theirs', 'monthly', 1, '2026-01-01', '2026-12-01', 0, ?, ?)`,
    ).run(T, T);
    expect(mark('b000000000000002', 'e000000000000009', '2026-01-05', 0)).toBe(false);
    // A due day goes with an item, and neither without the other
    expect(mark('b000000000000002', ITEM, null, 0)).toBe(false);
    expect(mark('b000000000000002', null, '2026-01-05', 0)).toBe(false);
    expect(mark('b000000000000002', ITEM, 'Jan 5', 0)).toBe(false);
    // Only an entry from Scheduled is to check, and only 0 or 1
    expect(mark('b000000000000002', null, null, 1)).toBe(false);
    expect(mark('b000000000000002', ITEM, '2026-01-05', 2)).toBe(false);
    // A new transaction is held to the same rules as a changed one
    const add = (id: string, recurringId: string | null, due: string | null, toCheck: number) =>
      takes(
        db,
        `INSERT INTO transactions (email, id, kind, account_id, amount_cents, category_id, date,
                                   recurring_id, recurring_due, to_check, created_at, updated_at)
         VALUES (?, ?, 'expense', 'a000000000000001', 5490, 'c000000000000001', '2026-01-05',
                 ?, ?, ?, ?, ?)`,
        OWNER,
        id,
        recurringId,
        due,
        toCheck,
        T,
        T,
      );
    expect(add('b000000000000010', ITEM, '2026-01-05', 1)).toBe(true);
    expect(add('b000000000000011', 'e000000000000009', '2026-01-05', 0)).toBe(false);
    expect(add('b000000000000012', null, null, 0)).toBe(true);
  });
});

describe('0010, profile pictures', () => {
  const PICTURES_MIGRATION = '0010_profile_pictures.sql';
  const ME = 'teal@example.com';
  const migrated = () => {
    const db = database(before0007);
    seedToday(db);
    for (const file of files.filter((f) => f >= '0007')) {
      db.exec(readFileSync(join(DIR, file), 'utf8'));
    }
    return db;
  };
  const picture = (
    db: DatabaseSync,
    source: string,
    type: string,
    data: Uint8Array | string,
    url: string | null,
    email = ME,
  ) => {
    try {
      db.prepare(
        `INSERT INTO profile_pictures (email, source, content_type, data, version, google_url)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(email, source, type, data, T, url);
      return true;
    } catch (err) {
      const code = (err as { errcode?: unknown }).errcode;
      if (typeof code === 'number' && (code & 0xff) === SQLITE_CONSTRAINT) return false;
      throw err;
    }
  };

  it('is the next migration after Scheduled', () => {
    expect(files.indexOf(PICTURES_MIGRATION)).toBe(files.indexOf('0009_scheduled.sql') + 1);
  });

  it('keeps every profile, each showing its Google picture until told otherwise', () => {
    const db = migrated();
    expect(all(db, 'SELECT DISTINCT google_picture FROM profiles')).toEqual([
      { google_picture: 1 },
    ]);
    expect(all(db, 'SELECT count(*) AS n FROM profiles')).toEqual([{ n: 7 }]);
  });

  it('takes a small image of a known type, one of each source, from an account that exists', () => {
    const db = migrated();
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 1]);
    expect(picture(db, 'upload', 'image/webp', bytes, null)).toBe(true);
    expect(
      picture(db, 'google', 'image/jpeg', bytes, 'https://lh3.googleusercontent.com/a/x'),
    ).toBe(true);
    // One of each
    expect(picture(db, 'upload', 'image/webp', bytes, null)).toBe(false);
    // Only these sources and types, as bytes, and not too large
    expect(picture(db, 'gravatar', 'image/webp', bytes, null)).toBe(false);
    expect(picture(db, 'upload', 'image/gif', bytes, null, 'blue@example.com')).toBe(false);
    expect(picture(db, 'upload', 'image/webp', 'text', null, 'blue@example.com')).toBe(false);
    expect(
      picture(db, 'upload', 'image/webp', new Uint8Array(65537), null, 'blue@example.com'),
    ).toBe(false);
    // A Google picture says where it came from; a chosen one doesn't
    expect(picture(db, 'google', 'image/jpeg', bytes, null, 'blue@example.com')).toBe(false);
    expect(picture(db, 'upload', 'image/jpeg', bytes, 'https://x', 'blue@example.com')).toBe(false);
    // Only for someone with a profile
    expect(picture(db, 'upload', 'image/webp', bytes, null, 'nobody@example.com')).toBe(false);
    // And it goes with the profile
    db.prepare('DELETE FROM profiles WHERE email = ?').run(ME);
    expect(all(db, 'SELECT count(*) AS n FROM profile_pictures')).toEqual([{ n: 0 }]);
  });

  it('shows the Google picture or the initial, and nothing else', () => {
    const db = migrated();
    expect(takes(db, 'UPDATE profiles SET google_picture = 0 WHERE email = ?', ME)).toBe(true);
    expect(takes(db, 'UPDATE profiles SET google_picture = 2 WHERE email = ?', ME)).toBe(false);
    expect(takes(db, "UPDATE profiles SET google_picture = 'yes' WHERE email = ?", ME)).toBe(false);
  });
});

describe('0011, the home currency', () => {
  const CURRENCY_MIGRATION = '0011_currency.sql';
  const OWNER = 'teal@example.com';

  /** Today's rows, every migration before 0011, then 0011 */
  const migrated = () => {
    const db = database(before0007);
    seedToday(db);
    for (const file of files.filter((f) => f >= '0007')) {
      db.exec(readFileSync(join(DIR, file), 'utf8'));
    }
    return db;
  };

  it('is the next migration after the profile pictures', () => {
    expect(files.indexOf(CURRENCY_MIGRATION)).toBe(files.indexOf('0010_profile_pictures.sql') + 1);
  });

  it('keeps everyone in MYR, every amount as typed and nothing converting', () => {
    const db = migrated();
    expect(all(db, 'SELECT DISTINCT currency FROM user_settings')).toEqual([{ currency: 'MYR' }]);
    expect(
      all(db, 'SELECT amount_cents, original_currency, original_cents, rate FROM transactions'),
    ).toEqual(
      [1234, 2468, 3702].map((cents) => ({
        amount_cents: cents,
        original_currency: null,
        original_cents: null,
        rate: null,
      })),
    );
    expect(all(db, 'SELECT * FROM conversions')).toEqual([]);
  });

  it('takes as the home currency only those the app offers', () => {
    const db = migrated();
    const setting = (value: string | null) =>
      takes(db, 'UPDATE user_settings SET currency = ? WHERE email = ?', value, OWNER);
    expect(HOME_CURRENCIES.filter((c) => !setting(c))).toEqual([]);
    expect(['XYZ', 'myr', 'TWD', '', null].filter((c) => setting(c))).toEqual([]);
  });

  it('keeps what an amount was typed as whole, or not at all', () => {
    const db = migrated();
    const typed = (...values: (string | number | null)[]) =>
      takes(
        db,
        `UPDATE transactions SET original_currency = ?, original_cents = ?, rate = ?,
           rate_source = ?, rate_at = ? WHERE email = ? AND id = 'b000000000000001'`,
        ...values,
        OWNER,
      );
    expect(typed('MYR', 1234, 0.25, 'frankfurter', T)).toBe(true);
    expect(typed(null, null, null, null, null)).toBe(true);
    expect(typed('MYR', null, 0.25, 'frankfurter', T)).toBe(false);
    expect(typed('MYR', 1234, null, 'frankfurter', T)).toBe(false);
    expect(typed('MYR', 1234, 0.25, 'xe', T)).toBe(false);
    expect(typed('MYR', 1234, 0, 'wise', T)).toBe(false);
    expect(typed('myr', 1234, 0.25, 'wise', T)).toBe(false);
  });

  it('lets go of what an amount was typed as once it is changed, but not while converting', () => {
    const db = migrated();
    const typedAs = () =>
      all(
        db,
        `SELECT amount_cents, original_currency, original_cents FROM transactions
         WHERE id = 'b000000000000001'`,
      )[0];
    // Converting: the conversion is what changes it
    db.prepare(
      `INSERT INTO conversions (email, from_currency, to_currency, since, phase, touched_at)
       VALUES (?, 'USD', 'SGD', ?, 'converting', ?)`,
    ).run(OWNER, T, T);
    db.prepare(
      `UPDATE transactions SET amount_cents = 309, original_currency = 'MYR', original_cents = 1234,
         rate = 0.25, rate_source = 'wise', rate_at = ? WHERE id = 'b000000000000001'`,
    ).run(T);
    db.prepare("UPDATE transactions SET amount_cents = 420 WHERE id = 'b000000000000001'").run();
    expect(typedAs()).toEqual({
      amount_cents: 420,
      original_currency: 'MYR',
      original_cents: 1234,
    });
    // Done: a change the person makes is typed in the home currency
    db.prepare('DELETE FROM conversions').run();
    db.prepare("UPDATE transactions SET note = 'x' WHERE id = 'b000000000000001'").run();
    expect(typedAs()).toMatchObject({ original_currency: 'MYR' });
    db.prepare("UPDATE transactions SET amount_cents = 500 WHERE id = 'b000000000000001'").run();
    expect(typedAs()).toEqual({ amount_cents: 500, original_currency: null, original_cents: null });
  });

  it('deletes a profile with its conversion and what was worked out', () => {
    const db = migrated();
    db.prepare(
      `INSERT INTO conversions (email, from_currency, to_currency, since, phase, touched_at)
       VALUES (?, 'MYR', 'USD', ?, 'converting', ?)`,
    ).run(OWNER, T, T);
    db.prepare(
      `INSERT INTO conversion_staged (email, kind, key, cents) VALUES (?, 'transaction', 'x', 1)`,
    ).run(OWNER);
    db.prepare('DELETE FROM profiles WHERE email = ?').run(OWNER);
    expect(all(db, 'SELECT email FROM conversions')).toEqual([]);
    expect(all(db, 'SELECT email FROM conversion_staged')).toEqual([]);
  });
});

describe('0012, other currencies', () => {
  const OWNER = 'teal@example.com';

  /** Today's rows, then every migration from 0007 on */
  const migrated = () => {
    const db = database(before0007);
    seedToday(db);
    for (const file of files.filter((f) => f >= '0007')) {
      db.exec(readFileSync(join(DIR, file), 'utf8'));
    }
    return db;
  };

  it('starts everyone with none, and travel sense on', () => {
    const db = migrated();
    expect(all(db, 'SELECT DISTINCT other_currencies, travel_sense FROM user_settings')).toEqual([
      { other_currencies: '[]', travel_sense: 1 },
    ]);
  });

  it('takes a list of up to 8, and travel sense on or off', () => {
    const db = migrated();
    const list = (value: string) =>
      takes(db, 'UPDATE user_settings SET other_currencies = ? WHERE email = ?', value, OWNER);
    const codes = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => `C${i}X`));
    expect([list(codes(0)), list(codes(8)), list(codes(9))]).toEqual([true, true, false]);
    expect([list('THB'), list('{"a":1}'), list('[')]).toEqual([false, false, false]);
    const travel = (value: number | string) =>
      takes(db, 'UPDATE user_settings SET travel_sense = ? WHERE email = ?', value, OWNER);
    expect([travel(0), travel(1), travel(2), travel('yes')]).toEqual([true, true, false, false]);
  });
});
