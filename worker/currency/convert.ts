// Converting a person's amounts after their home currency changes (owner decisions D2 to D5),
// in the background, a step at a time (convert-queue.ts runs each step from the
// mahnee-reconvert queue). Each transaction converts at the rate on its own day; opening
// balances, budgets and scheduled items at the rate on the day of the switch. Each keeps what
// it was typed as: one already converted is converted again from that, a plain one becomes
// "typed in the old currency", and one typed in the new currency is plain again, exactly as
// typed, so changing back restores the exact amounts.
//
// Every converted amount is worked out first (conversion_staged), a page of transactions per
// step, checking each against its limit; the last step works out the accounts, budgets and
// scheduled items and swaps everything in at once. So one amount past its limit refuses the
// whole change with nothing converted, naming the limit, and amounts never show in two
// currencies at once. The person's writes wait meanwhile (changes.ts answers 503), so what's
// worked out stays true until it's swapped in. Every step is checked against the conversion
// it was for (since), so one for an older change, or run twice, does nothing.

import {
  CONVERSION_LIMITS,
  type ConversionLimit,
  type Conversion,
  type FetchedRateSource,
} from '../../shared/api';
import { MAX_TRANSACTION_CENTS } from '../../shared/ledger';
import { convertCents, convertSignedCents, rateDay } from '../../shared/rates';
import type { Rate } from './exchange-rates';

/** One conversion's next step, sent to the queue */
export interface ConvertJob {
  email: string;
  /** conversions.since of the change it's for; an older one's job does nothing */
  since: number;
}

/** Transactions worked out in one step: few enough rates to fetch within one run */
export const PAGE = 200;
/** A conversion that hasn't moved on for this long is started again when the person reads it */
export const STALLED_MS = 2 * 60 * 1000;
/** Budget rows worked out in one statement, well within D1's statement size */
const CHUNK = 500;

/** The rate from one currency into another for a day (2026-11-05) */
export type FetchRate = (from: string, to: string, day: string) => Promise<Rate>;

/** An amount as it is now, and what it was typed as, if it was converted before */
interface Amount {
  key: string;
  cents: number;
  originalCurrency: string | null;
  originalCents: number | null;
  /** The day whose rate converts it */
  day: string;
}

/** An amount in the new currency, with what it was typed as (all null when typed in it) */
type Staged = [
  key: string,
  cents: number,
  originalCurrency: string | null,
  originalCents: number | null,
  rate: number | null,
  rateSource: FetchedRateSource | null,
  rateAt: number | null,
];

/** How an amount is converted and how large it may be once it is */
const RULES: Record<ConversionLimit, { signed: boolean }> = {
  // An entry's, budget's or scheduled item's amount is above zero
  amount: { signed: false },
  budget: { signed: false },
  scheduled: { signed: false },
  // An opening balance goes either way
  opening: { signed: true },
};

/** Converts amounts into `to`, or names the limit one of them would go past */
async function stage(
  amounts: Amount[],
  limit: ConversionLimit,
  from: string,
  to: string,
  rateOf: (currency: string, day: string) => Promise<Rate>,
): Promise<Staged[] | ConversionLimit> {
  const { signed } = RULES[limit];
  const staged: Staged[] = [];
  for (const a of amounts) {
    // What it was typed as: its own original, or (plain) the currency it's in now
    const typedIn = a.originalCurrency ?? from;
    const typed = a.originalCents ?? a.cents;
    if (typedIn === to) {
      staged.push([a.key, typed, null, null, null, null, null]);
      continue;
    }
    const { rate, source, fetchedAt } = await rateOf(typedIn, a.day);
    // An amount above zero stays above zero: a cent at the least
    const cents = signed ? convertSignedCents(typed, rate) : Math.max(1, convertCents(typed, rate));
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_TRANSACTION_CENTS) return limit;
    staged.push([a.key, cents, typedIn, typed, rate, source, fetchedAt]);
  }
  return staged;
}

/** Rates fetched once per currency and day within a step */
function rateKeeper(to: string, fetchRate: FetchRate) {
  const kept = new Map<string, Promise<Rate>>();
  return (currency: string, day: string) => {
    const key = `${currency} ${day}`;
    let rate = kept.get(key);
    if (rate == null) {
      rate = fetchRate(currency, to, day);
      kept.set(key, rate);
    }
    return rate;
  };
}

/** The person's conversion as conversions holds it */
interface ConversionRow {
  from: string;
  to: string;
  since: number;
  phase: 'converting' | 'refused';
  afterDate: string;
  afterId: string;
  touchedAt: number;
  refused: ConversionLimit | null;
}

const SELECT_CONVERSION = `SELECT from_currency AS "from", to_currency AS "to", since, phase,
    after_date AS afterDate, after_id AS afterId, touched_at AS touchedAt, refused
  FROM conversions WHERE email = ?`;

export const readConversionRow = (db: D1Database, email: string) =>
  db.prepare(SELECT_CONVERSION).bind(email).first<ConversionRow>();

/** The conversion as the profile says it */
export const conversionOf = (row: ConversionRow | null): Conversion | null =>
  row == null
    ? null
    : {
        from: row.from,
        to: row.to,
        since: row.since,
        refused: CONVERSION_LIMITS.includes(row.refused as ConversionLimit) ? row.refused : null,
      };

/** Only while the conversion `since` names is still under way; binds email then since */
const STILL = `EXISTS (SELECT 1 FROM conversions
  WHERE email = ?1 AND since = ?2 AND phase = 'converting')`;

/**
 * Starts converting into `to` from `from`: written in the same batch as the new currency.
 * Anything worked out for an earlier change goes.
 */
export const startStatements = (
  db: D1Database,
  email: string,
  from: string,
  to: string,
  since: number,
) => [
  db.prepare('DELETE FROM conversion_staged WHERE email = ?').bind(email),
  db
    .prepare(
      `INSERT OR REPLACE INTO conversions
         (email, from_currency, to_currency, since, phase, touched_at)
       VALUES (?1, ?2, ?3, ?4, 'converting', ?4)`,
    )
    .bind(email, from, to, since),
];

/** Keeps amounts worked out, for the swap at the end */
function stageStatements(
  db: D1Database,
  email: string,
  since: number,
  kind: string,
  staged: Staged[],
) {
  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < staged.length; i += CHUNK) {
    statements.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO conversion_staged
             (email, kind, key, cents, original_currency, original_cents, rate, rate_source, rate_at)
           SELECT ?1, ?3, json_extract(value, '$[0]'), json_extract(value, '$[1]'),
             json_extract(value, '$[2]'), json_extract(value, '$[3]'), json_extract(value, '$[4]'),
             json_extract(value, '$[5]'), json_extract(value, '$[6]')
           FROM json_each(?4) WHERE ${STILL}`,
        )
        .bind(email, since, kind, JSON.stringify(staged.slice(i, i + CHUNK))),
    );
  }
  return statements;
}

/** Puts every worked-out amount of `kind` into `table`, matched by `match` */
const swap = (db: D1Database, email: string, since: number, kind: string, table: string) => {
  const amount = table === 'accounts' ? 'opening_cents' : 'amount_cents';
  const match =
    table === 'budgets'
      ? `budgets.category_id || '/' || budgets.from_month = s.key`
      : `${table}.id = s.key`;
  return db
    .prepare(
      `UPDATE ${table} SET ${amount} = s.cents, original_currency = s.original_currency,
         original_cents = s.original_cents, rate = s.rate, rate_source = s.rate_source,
         rate_at = s.rate_at
       FROM conversion_staged s
       WHERE s.email = ?1 AND s.kind = ?3 AND ${table}.email = ?1 AND ${match} AND ${STILL}`,
    )
    .bind(email, since, kind);
};

/**
 * Takes the change back: the currency is what it was, nothing was converted, and the
 * profile names the limit until the currency is changed again
 */
async function refuse(
  db: D1Database,
  email: string,
  conversion: ConversionRow,
  limit: ConversionLimit,
) {
  const { since, from } = conversion;
  await db.batch([
    db
      .prepare(
        `UPDATE user_settings SET currency = ?3, updated_at = ?4 WHERE email = ?1 AND ${STILL}`,
      )
      .bind(email, since, from, Date.now()),
    db.prepare('DELETE FROM conversion_staged WHERE email = ?').bind(email),
    db
      .prepare(
        `UPDATE conversions SET phase = 'refused', refused = ?3, touched_at = ?4
         WHERE email = ?1 AND since = ?2 AND phase = 'converting'`,
      )
      .bind(email, since, limit, Date.now()),
  ]);
  console.error(`refused a change of currency: an amount past the ${limit} limit`);
}

/**
 * Takes the conversion `job` names one step on: a page of transactions, or the rest and the
 * swap. Answers whether there's another step to queue. Throws when a rate can't be had
 * (the step is tried again later, nothing kept from it but the rates).
 */
export async function convertStep(
  db: D1Database,
  { email, since }: ConvertJob,
  fetchRate: FetchRate,
): Promise<boolean> {
  const conversion = await readConversionRow(db, email);
  if (conversion?.phase !== 'converting' || conversion.since !== since) return false;
  const { from, to, afterDate, afterId } = conversion;
  const rateOf = rateKeeper(to, fetchRate);

  const { results: page } = await db
    .prepare(
      `SELECT id AS key, amount_cents AS cents, original_currency AS originalCurrency,
         original_cents AS originalCents, date AS day
       FROM transactions
       WHERE email = ?1 AND (date > ?2 OR (date = ?2 AND id > ?3))
       ORDER BY date, id LIMIT ?4`,
    )
    .bind(email, afterDate, afterId, PAGE)
    .all<Amount>();

  if (page.length > 0) {
    const staged = await stage(page, 'amount', from, to, rateOf);
    if (typeof staged === 'string') {
      await refuse(db, email, conversion, staged);
      return false;
    }
    const last = page[page.length - 1];
    const results = await db.batch([
      ...stageStatements(db, email, since, 'transaction', staged),
      db
        .prepare(
          `UPDATE conversions SET after_date = ?5, after_id = ?6, touched_at = ?7
           WHERE email = ?1 AND since = ?2 AND phase = 'converting'
             AND after_date = ?3 AND after_id = ?4`,
        )
        .bind(email, since, afterDate, afterId, last.day, last.key, Date.now()),
    ]);
    // Another run took this page: that one goes on
    return (results.at(-1)?.meta.changes ?? 0) > 0;
  }

  // Every transaction is worked out: the rest at the rate on the day of the switch
  const day = rateDay(since);
  const [accounts, budgets, recurring] = await db.batch([
    db
      .prepare(
        `SELECT id AS key, opening_cents AS cents, original_currency AS originalCurrency,
           original_cents AS originalCents, ?2 AS day
         FROM accounts WHERE email = ?1`,
      )
      .bind(email, day),
    db
      .prepare(
        `SELECT category_id || '/' || from_month AS key, amount_cents AS cents,
           original_currency AS originalCurrency, original_cents AS originalCents, ?2 AS day
         FROM budgets WHERE email = ?1 AND amount_cents IS NOT NULL`,
      )
      .bind(email, day),
    db
      .prepare(
        `SELECT id AS key, amount_cents AS cents, original_currency AS originalCurrency,
           original_cents AS originalCents, ?2 AS day
         FROM recurring WHERE email = ?1`,
      )
      .bind(email, day),
  ]);
  const staged: [string, string, Staged[]][] = [];
  for (const [kind, limit, rows] of [
    ['account', 'opening', accounts],
    ['budget', 'budget', budgets],
    ['recurring', 'scheduled', recurring],
  ] as const) {
    const done = await stage(rows.results as Amount[], limit, from, to, rateOf);
    if (typeof done === 'string') {
      await refuse(db, email, conversion, done);
      return false;
    }
    staged.push([kind, limit, done]);
  }

  // Everything fits: all of it swapped in at once, then let go
  await db.batch([
    ...staged.flatMap(([kind, , rows]) => stageStatements(db, email, since, kind, rows)),
    swap(db, email, since, 'transaction', 'transactions'),
    swap(db, email, since, 'account', 'accounts'),
    swap(db, email, since, 'budget', 'budgets'),
    swap(db, email, since, 'recurring', 'recurring'),
    db
      .prepare(`UPDATE accounts SET currency = ?3 WHERE email = ?1 AND ${STILL}`)
      .bind(email, since, to),
    db.prepare(`DELETE FROM conversion_staged WHERE email = ?1 AND ${STILL}`).bind(email, since),
    db
      .prepare("DELETE FROM conversions WHERE email = ? AND since = ? AND phase = 'converting'")
      .bind(email, since),
  ]);
  return false;
}
