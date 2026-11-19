// A change typed in a home currency the person has since left (made offline on another
// device, or waiting while the amounts converted): its amounts are converted into the home
// currency as it's saved, the way the conversion does (convert.ts), each keeping what was
// typed. An entry's amount at the rate on its own day, anything else at today's.

import { MAX_TRANSACTION_CENTS } from '../../shared/ledger';
import { convertCents, convertSignedCents } from '../../shared/rates';
import type { Rate } from './exchange-rates';

/** The rate from one currency into another for a day (2026-11-05) */
type FetchRate = (from: string, to: string, day: string) => Promise<Rate>;

/** What an amount saved by a change was typed as, written once the change is */
export interface Typed {
  table: 'transactions' | 'accounts' | 'budgets' | 'recurring';
  /** The row: its id, or a budget's category and month */
  row: { id: string } | { categoryId: string; fromMonth: string };
  currency: string;
  cents: number;
  rate: Rate;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);
const isCents = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The change with its amounts in `to`, and what each was typed as. Anything not as a
 * change should be is left for the checks that refuse it; an amount that would go past
 * its limit once converted goes on past it, so the change is refused for that.
 */
export async function typedIn(
  change: unknown,
  from: string,
  to: string,
  {
    fetchRate,
    today,
    dayOf,
  }: {
    fetchRate: FetchRate;
    /** The person's today, for amounts that aren't an entry's */
    today: string;
    /** A saved entry's day, for one changed without saying it */
    dayOf: (id: string) => Promise<string | null>;
  },
): Promise<{ change: unknown; typed: Typed[] }> {
  if (!isObject(change)) return { change, typed: [] };
  const typed: Typed[] = [];

  /** `holder[field]` in `to`, recording what it was typed as on `table`'s `row` */
  const convert = async (
    holder: Record<string, unknown>,
    field: string,
    table: Typed['table'],
    row: Typed['row'],
    day: string,
    signed = false,
  ) => {
    const cents = holder[field];
    if (!isCents(cents)) return holder;
    const rate = await fetchRate(from, to, DAY.test(day) ? day : today);
    const converted = signed
      ? convertSignedCents(cents, rate.rate)
      : Math.max(cents > 0 ? 1 : 0, convertCents(cents, rate.rate));
    if (Math.abs(converted) > MAX_TRANSACTION_CENTS) return { ...holder, [field]: converted };
    typed.push({ table, row, currency: from, cents, rate });
    return { ...holder, [field]: converted };
  };
  const id = (v: unknown) => (typeof v === 'string' ? v : '');

  switch (change.op) {
    case 'addAccount': {
      if (!isObject(change.account)) break;
      const account = change.account;
      const row = { id: id(account.id) };
      return {
        change: {
          ...change,
          account: await convert(account, 'openingCents', 'accounts', row, today, true),
        },
        typed,
      };
    }
    case 'updateAccount':
      return {
        change: await convert(
          change,
          'openingCents',
          'accounts',
          { id: id(change.id) },
          today,
          true,
        ),
        typed,
      };
    case 'addTransaction':
    case 'logRecurring': {
      if (!isObject(change.transaction)) break;
      const t = change.transaction;
      const day = id(t.date);
      return {
        change: {
          ...change,
          transaction: await convert(t, 'amountCents', 'transactions', { id: id(t.id) }, day),
        },
        typed,
      };
    }
    case 'updateTransaction': {
      if (!isCents(change.amountCents)) break;
      const day = typeof change.date === 'string' ? change.date : await dayOf(id(change.id));
      return {
        change: await convert(
          change,
          'amountCents',
          'transactions',
          { id: id(change.id) },
          day ?? today,
        ),
        typed,
      };
    }
    case 'setBudget': {
      const row = { categoryId: id(change.categoryId), fromMonth: id(change.fromMonth) };
      return { change: await convert(change, 'amountCents', 'budgets', row, today), typed };
    }
    case 'addRecurring': {
      if (!isObject(change.recurring)) break;
      const r = change.recurring;
      return {
        change: {
          ...change,
          recurring: await convert(r, 'amountCents', 'recurring', { id: id(r.id) }, today),
        },
        typed,
      };
    }
    case 'updateRecurring':
      return {
        change: await convert(change, 'amountCents', 'recurring', { id: id(change.id) }, today),
        typed,
      };
  }
  return { change, typed };
}

/** Writes what each amount a change saved was typed as, once the change itself is saved */
export function typedStatements(db: D1Database, email: string, typed: Typed[]) {
  return typed.map(({ table, row, currency, cents, rate }) => {
    const where = 'id' in row ? 'id = ?7' : 'category_id = ?7 AND from_month = ?8';
    return db
      .prepare(
        `UPDATE ${table} SET original_currency = ?2, original_cents = ?3, rate = ?4,
           rate_source = ?5, rate_at = ?6
         WHERE email = ?1 AND ${where}`,
      )
      .bind(
        email,
        currency,
        cents,
        rate.rate,
        rate.source,
        rate.fetchedAt,
        ...('id' in row ? [row.id] : [row.categoryId, row.fromMonth]),
      );
  });
}
