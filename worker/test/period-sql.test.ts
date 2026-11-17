// The Worker sums each month's figures in the database, so the database has to say which
// period a day is in exactly as the app does (shared/period.ts): the same answer for every
// day of four years, every start day there is (1 to 28, a pay's 29th and 30th, and 31 for
// "Last day of the month"). Run on SQLite, as D1 runs it.

import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { periodMonthOf } from '../../shared/period';
import { periodMonthSql } from '../ledger/period-sql';

const START_DAYS = [...Array.from({ length: 30 }, (_, i) => i + 1), 31];

function days(first: string, last: string) {
  const out: string[] = [];
  for (
    let at = Date.parse(`${first}T00:00:00Z`);
    at <= Date.parse(`${last}T00:00:00Z`);
    at += 86_400_000
  ) {
    out.push(new Date(at).toISOString().slice(0, 10));
  }
  return out;
}

describe('the period a day is in, worked out by the database', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE d (date TEXT NOT NULL)');
  const insert = db.prepare('INSERT INTO d (date) VALUES (?)');
  const all = days('2026-01-01', '2029-12-31');
  for (const day of all) insert.run(day);

  it.each(START_DAYS)('names the same period as the app, starting on day %i', (start) => {
    const rows = db
      .prepare(`SELECT date, ${periodMonthSql('date', '?1')} AS month FROM d ORDER BY date`)
      .all(start) as { date: string; month: string }[];
    expect(rows).toHaveLength(all.length);
    const wrong = rows.filter((r) => r.month !== periodMonthOf(r.date, start));
    expect(wrong).toEqual([]);
  });
});
