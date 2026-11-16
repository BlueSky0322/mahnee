// The migrations, run in order on SQLite (as D1 runs them, with foreign keys on). 0007
// rebuilds the settings table for the redesign: it runs here on a database at the schema
// before it, holding rows, to show every row comes through, with each stored accent
// mapped to the redesign's and every new setting at the design's default.

import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { beforeEach, describe, expect, it } from 'vitest';

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
