// Converting a person's amounts after their home currency changes (owner decisions D2 to D5),
// in the background, a step at a time (convert-queue.ts runs each step from the
// mahnee-reconvert queue). Each transaction converts at the rate on its own day; opening
// balances, budgets and scheduled items at the rate on the day of the switch. Each keeps what
// it was typed as: one already converted is converted again from that, a plain one becomes
// "typed in the old currency", and one typed in the new currency is plain again, exactly as
// typed, so changing back restores the exact amounts.
//
// An import's change to an opening balance converts with it, at the same rate, keeping
// what it was typed as the same way.
//
// Every converted amount is worked out first (conversion_staged), a page of transactions per
// step, checking each against its limit; the last step works out the accounts, budgets and
// scheduled items and swaps everything in at once. So one amount past its limit refuses the
// whole change with nothing converted, naming the limit, and amounts never show in two
// currencies at once. The person's writes wait meanwhile (changes.ts answers 503), so what's
// worked out stays true until it's swapped in. Every step is checked against the conversion
// it was for (since), so one for an older change, or run twice, does nothing.

import {
  CONVERSION_REFUSALS,
  type ConversionLimit,
  type ConversionRefusal,
  type Conversion,
  type FetchedRateSource,
} from '../../shared/api';
import { MAX_TRANSACTION_CENTS } from '../../shared/ledger';
import { convertCents, convertSignedCents, rateDay } from '../../shared/rates';

/**
 * A rate as getRateOn (exchange-rates.ts) answers it; written out here so this file needs
 * nothing of the Worker's runtime (worker/test/convert.test.ts runs it in Node)
 */
export interface Rate {
  rate: number;
  source: FetchedRateSource;
  fetchedAt: number;
}

/** One conversion's next step, sent to the queue */
export interface ConvertJob {
  email: string;
  /** conversions.since of the change it's for; an older one's job does nothing */
  since: number;
}

/** Transactions worked out in one step: few enough rates to fetch within one run */
export const PAGE = 200;
/**
 * How many times in a row a stalled conversion is started again before it's given back;
 * a step that moves on starts the count afresh
 */
export const MAX_RESTARTS = 3;
/**
 * How many times a conversion starts over from its first transaction (found with
 * worked-out amounts gone) before it's given back, however far it got each time
 */
export const MAX_START_OVERS = 3;
/** A conversion that hasn't moved on for this long is started again when the person reads it */
export const STALLED_MS = 2 * 60 * 1000;
/** Budget rows worked out in one statement, well within D1's statement size */
const CHUNK = 500;
/**
 * Worked-out transactions swapped in by one statement: the swap is one batch (all or
 * nothing), its statements each bounded, so none runs long
 */
export const SWAP_CHUNK = 10_000;

/**
 * The rate from one currency into another for a day (2026-11-05), or null once the step
 * has asked for as many rates as one run may: the rest wait for the next step
 */
export type FetchRate = (from: string, to: string, day: string) => Promise<Rate | null>;

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

/**
 * Converts amounts into `to`, or names the limit one of them would go past. Stops early,
 * with those converted so far, once no more rates can be had in this step.
 */
async function stage(
  amounts: Amount[],
  limit: ConversionLimit,
  from: string,
  to: string,
  rateOf: (currency: string, day: string) => Promise<Rate | null>,
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
    const found = await rateOf(typedIn, a.day);
    if (found == null) return staged;
    const { rate, source, fetchedAt } = found;
    // An amount above zero stays above zero: a cent at the least
    const cents = signed ? convertSignedCents(typed, rate) : Math.max(1, convertCents(typed, rate));
    if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_TRANSACTION_CENTS) return limit;
    staged.push([a.key, cents, typedIn, typed, rate, source, fetchedAt]);
  }
  return staged;
}

/** Rates fetched once per currency and day within a step */
function rateKeeper(to: string, fetchRate: FetchRate) {
  const kept = new Map<string, Promise<Rate | null>>();
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
export interface ConversionRow {
  from: string;
  to: string;
  since: number;
  phase: 'converting' | 'refused';
  afterDate: string;
  afterId: string;
  touchedAt: number;
  restarts: number;
  startOvers: number;
  refused: ConversionRefusal | null;
}

export const SELECT_CONVERSION = `SELECT from_currency AS "from", to_currency AS "to", since, phase,
    after_date AS afterDate, after_id AS afterId, touched_at AS touchedAt, restarts,
    start_overs AS startOvers, refused
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
        refused: CONVERSION_REFUSALS.includes(row.refused as ConversionRefusal)
          ? row.refused
          : null,
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

/**
 * Puts the worked-out transactions in, SWAP_CHUNK of the staged rows (by rowid, `low` to
 * `high`) per statement
 */
function swapTransactions(
  db: D1Database,
  email: string,
  since: number,
  low: number | null,
  high: number | null,
) {
  if (low == null || high == null) return [];
  const statements: D1PreparedStatement[] = [];
  for (let from = low; from <= high; from += SWAP_CHUNK) {
    statements.push(
      swap(db, email, since, 'transaction', 'transactions', [from, from + SWAP_CHUNK - 1]),
    );
  }
  return statements;
}

/** Puts every worked-out amount of `kind` (with `rows`, those of its rowids) into `table` */
const swap = (
  db: D1Database,
  email: string,
  since: number,
  kind: string,
  table: string,
  rows?: [number, number],
) => {
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
       WHERE s.email = ?1 AND s.kind = ?3 AND ${table}.email = ?1 AND ${match} AND ${STILL}
         ${rows == null ? '' : 'AND s.rowid BETWEEN ?4 AND ?5'}`,
    )
    .bind(email, since, kind, ...(rows ?? []));
};

/**
 * Takes the change back, if it's still the one under way: the currency is what it was,
 * nothing was converted (what was worked out goes), the person's writes go through again,
 * and the profile says why (`reason`) until the currency is changed again
 */
export async function release(
  db: D1Database,
  { email, since }: ConvertJob,
  reason: ConversionRefusal,
) {
  const now = Date.now();
  await db.batch([
    db
      .prepare(
        `UPDATE user_settings SET currency =
           (SELECT from_currency FROM conversions WHERE email = ?1 AND since = ?2),
           updated_at = ?3
         WHERE email = ?1 AND ${STILL}`,
      )
      .bind(email, since, now),
    db.prepare(`DELETE FROM conversion_staged WHERE email = ?1 AND ${STILL}`).bind(email, since),
    // Last, as the two above hold only while it's under way
    db
      .prepare(
        `UPDATE conversions SET phase = 'refused', refused = ?3, touched_at = ?4
         WHERE email = ?1 AND since = ?2 AND phase = 'converting'`,
      )
      .bind(email, since, reason, now),
  ]);
  console.error(`refused a change of currency: ${reason}`);
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
      await release(db, { email, since }, staged);
      return false;
    }
    // As far as this step's rates went; the next step carries on from there
    if (staged.length === 0) throw new Error('No rate could be had for a transaction');
    const last = page[staged.length - 1];
    const results = await db.batch([
      ...stageStatements(db, email, since, 'transaction', staged),
      // Moving on: a stall before this one no longer counts
      db
        .prepare(
          `UPDATE conversions SET after_date = ?5, after_id = ?6, touched_at = ?7, restarts = 0
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
  const [accounts, budgets, recurring, imports] = await db.batch([
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
    // What an import changed an opening balance by, at the opening balance's own rate, so
    // its Undo puts the opening balance back where it would be on its own
    db
      .prepare(
        `SELECT id AS key, opening_change_cents AS cents,
           opening_change_currency AS originalCurrency,
           opening_change_typed_cents AS originalCents, ?2 AS day
         FROM imports
         WHERE email = ?1 AND (opening_change_cents <> 0 OR opening_change_currency IS NOT NULL)`,
      )
      .bind(email, day),
  ]);
  const staged: [string, string, Staged[]][] = [];
  for (const [kind, limit, rows] of [
    ['account', 'opening', accounts],
    ['budget', 'budget', budgets],
    ['recurring', 'scheduled', recurring],
    ['import', 'opening', imports],
  ] as const) {
    const amounts = rows.results as Amount[];
    const done = await stage(amounts, limit, from, to, rateOf);
    if (typeof done === 'string') {
      await release(db, { email, since }, done);
      return false;
    }
    // Tried again by the queue, with the rates found so far kept in Cloudflare's cache
    if (done.length < amounts.length) throw new Error('More rates than one step may ask for');
    staged.push([kind, limit, done]);
  }

  // Every transaction has to be worked out, or some would stay in the old currency: if any
  // isn't (what was worked out went, by a refusal for an older change), it starts over
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM transactions WHERE email = ?1) AS held,
         (SELECT COUNT(*) FROM conversion_staged WHERE email = ?1 AND kind = 'transaction')
           AS worked, (SELECT MIN(rowid) FROM conversion_staged
             WHERE email = ?1 AND kind = 'transaction') AS low,
         (SELECT MAX(rowid) FROM conversion_staged
             WHERE email = ?1 AND kind = 'transaction') AS high`,
    )
    .bind(email)
    .first<{ held: number; worked: number; low: number | null; high: number | null }>();
  // Counted however far it gets each time, and too many give the currency back
  if (counts == null || counts.held !== counts.worked) {
    if (conversion.startOvers >= MAX_START_OVERS) {
      await release(db, { email, since }, 'rates');
      return false;
    }
    await db
      .prepare(
        `UPDATE conversions SET after_date = '', after_id = '', touched_at = ?3,
           start_overs = start_overs + 1
         WHERE email = ?1 AND since = ?2 AND phase = 'converting'`,
      )
      .bind(email, since, Date.now())
      .run();
    return true;
  }

  // Everything fits: all of it swapped in at once, then let go. The first statement undoes
  // the batch if what was worked out changed since it was counted.
  await db.batch([
    db
      .prepare(
        `INSERT INTO change_receipts (email, change_id, fingerprint, saved_at)
         SELECT ?1, NULL, '', 0 WHERE ${STILL} AND ?3 <>
           (SELECT COUNT(*) FROM conversion_staged WHERE email = ?1 AND kind = 'transaction')`,
      )
      .bind(email, since, counts.worked),
    ...staged.flatMap(([kind, , rows]) => stageStatements(db, email, since, kind, rows)),
    ...swapTransactions(db, email, since, counts.low, counts.high),
    swap(db, email, since, 'account', 'accounts'),
    swap(db, email, since, 'budget', 'budgets'),
    swap(db, email, since, 'recurring', 'recurring'),
    db
      .prepare(
        `UPDATE imports SET opening_change_cents = s.cents,
           opening_change_currency = s.original_currency,
           opening_change_typed_cents = s.original_cents
         FROM conversion_staged s
         WHERE s.email = ?1 AND s.kind = 'import' AND imports.email = ?1 AND imports.id = s.key
           AND ${STILL}`,
      )
      .bind(email, since),
    db
      .prepare(`UPDATE accounts SET currency = ?3 WHERE email = ?1 AND ${STILL}`)
      .bind(email, since, to),
    // The new main currency is no longer one of the others, the rest kept in their order
    db
      .prepare(
        `UPDATE user_settings SET other_currencies = (
           SELECT json_group_array(value) FROM (
             SELECT value FROM json_each(user_settings.other_currencies)
             WHERE value <> ?3 ORDER BY key
           )
         )
         WHERE email = ?1 AND ${STILL}`,
      )
      .bind(email, since, to),
    db.prepare(`DELETE FROM conversion_staged WHERE email = ?1 AND ${STILL}`).bind(email, since),
    db
      .prepare("DELETE FROM conversions WHERE email = ? AND since = ? AND phase = 'converting'")
      .bind(email, since),
  ]);
  return false;
}

/**
 * A conversion that hasn't moved on for STALLED_MS past when it was last due (a step never
 * queued, or one lost) is started again (`queue` sends its next step): marked as moved on
 * first, so readers at once don't each queue it. After MAX_RESTARTS in a row without
 * moving on, it's given back.
 */
export async function restartIfStalled(
  db: D1Database,
  email: string,
  queue: (job: ConvertJob) => Promise<void>,
  now = Date.now(),
) {
  const row = await readConversionRow(db, email);
  if (row?.phase !== 'converting' || now - row.touchedAt < STALLED_MS) return;
  const job = { email, since: row.since };
  if (row.restarts >= MAX_RESTARTS) {
    await release(db, job, 'rates');
    return;
  }
  const { meta } = await db
    .prepare(
      `UPDATE conversions SET touched_at = ?3, restarts = restarts + 1
       WHERE email = ?1 AND since = ?2 AND phase = 'converting' AND touched_at = ?4`,
    )
    .bind(email, row.since, now, row.touchedAt)
    .run();
  if (meta.changes > 0) await queue(job);
}
