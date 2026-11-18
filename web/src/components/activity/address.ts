import type { TransactionKind } from '@shared/ledger';
import { TRANSACTION_KINDS } from '@shared/ledger';
import type { SearchQuery } from '@shared/search';
import { periodMonthOf, periodOf } from '@shared/period';
import { MAX_SEARCH_TEXT, isCalendarDay, readKinds } from '@shared/search';

// Activity's filters, as its address holds them (docs/feature-map.md, Pages): ?activity is
// this month on every account, expenses and income (transfers only when asked for); &q=,
// &account=, &category=, &kind= (one kind, two joined by a comma, or all); &scheduled (only what Scheduled added); the days as &day= (that day alone), &from= and &to= (both included), or
// &dates=all (every month); and &select (a phone opens selecting). A part that makes no
// sense is left out: a day that isn't one, a kind not known, and (once the ledger is
// known) an account or category the person doesn't have. A day wins over from and to, and
// those over all months. Each filter is written back in that order, only when it isn't
// its default, so plain ?activity stays plain.

/** Which days: this month (the default), every one, one day, or from and/or to */
export type Days =
  | { kind: 'month' }
  | { kind: 'all' }
  | { kind: 'day'; day: string }
  | { kind: 'range'; from: string | null; to: string | null };

export interface Filters {
  /** Words, trimmed; '' for none */
  q: string;
  account: string | null;
  category: string | null;
  /** Only these kinds, in TRANSACTION_KINDS' order (DEFAULT_KINDS to start); null for all */
  kinds: TransactionKind[] | null;
  days: Days;
  /** Only entries added from Scheduled (Plan's "See them") */
  scheduled: boolean;
  select: boolean;
}

/** What Activity shows until another kind is picked: transfers are left out (R-Activity) */
export const DEFAULT_KINDS: readonly TransactionKind[] = ['expense', 'income'];

/** Whether `kinds` are the ones Activity starts on */
export const isDefaultKinds = (kinds: readonly TransactionKind[] | null) =>
  kinds != null &&
  kinds.length === DEFAULT_KINDS.length &&
  DEFAULT_KINDS.every((k) => kinds.includes(k));

export const NO_FILTERS: Omit<Filters, 'q' | 'days' | 'select'> = {
  account: null,
  category: null,
  kinds: [...DEFAULT_KINDS],
  scheduled: false,
};

const day = (v: string | null) => (v != null && isCalendarDay(v) ? v : null);

/**
 * The kinds the address names, by shared/search.ts's rule, or every kind for "all"; the
 * default when it names none or can't be read
 */
function kindsOf(text: string | null): TransactionKind[] | null {
  if (text === 'all') return null;
  const kinds = readKinds(text);
  if (kinds == null || 'error' in kinds) return [...DEFAULT_KINDS];
  return kinds.length === TRANSACTION_KINDS.length ? null : kinds;
}

/** The filters an address (its query string, without the ?) asks for */
export function readFilters(query: string): Filters {
  const params = new URLSearchParams(query);
  const q = (params.get('q') ?? '').trim().slice(0, MAX_SEARCH_TEXT);
  const one = day(params.get('day'));
  const [from, to] = [day(params.get('from')), day(params.get('to'))];
  const days: Days =
    one != null
      ? { kind: 'day', day: one }
      : from != null || to != null
        ? { kind: 'range', from, to }
        : params.get('dates') === 'all'
          ? { kind: 'all' }
          : { kind: 'month' };
  return {
    q,
    account: params.get('account') || null,
    category: params.get('category') || null,
    kinds: kindsOf(params.get('kind')),
    scheduled: params.has('scheduled'),
    days,
    select: params.has('select'),
  };
}

/** Activity's address for `filters`, each part only when it isn't its default */
export function writeFilters(filters: Filters) {
  const parts = ['activity'];
  const put = (key: string, value: string | null) => {
    if (value != null && value !== '') parts.push(`${key}=${encodeURIComponent(value)}`);
  };
  put('q', filters.q);
  put('account', filters.account);
  put('category', filters.category);
  if (!isDefaultKinds(filters.kinds)) put('kind', filters.kinds?.join(',') ?? 'all');
  if (filters.scheduled) parts.push('scheduled');
  const { days } = filters;
  if (days.kind === 'day') put('day', days.day);
  if (days.kind === 'range') {
    put('from', days.from);
    put('to', days.to);
  }
  if (days.kind === 'all') parts.push('dates=all');
  if (filters.select) parts.push('select');
  return `?${parts.join('&')}`;
}

/**
 * The first and last days of `month` (2026-11), the person's month from `start`
 * (shared/period.ts; the 1st when not given)
 */
export function monthDays(month: string, start = 1): { from: string; to: string } {
  const { firstDay, lastDay } = periodOf(month, start);
  return { from: firstDay, to: lastDay };
}

/**
 * The first and last day the days ask for (null for no end), with `today` for this month,
 * the person's from `start`
 */
export function dayRange(
  days: Days,
  today: string,
  start = 1,
): { from: string | null; to: string | null } {
  if (days.kind === 'month') return monthDays(periodMonthOf(today, start), start);
  if (days.kind === 'all') return { from: null, to: null };
  if (days.kind === 'day') return { from: days.day, to: days.day };
  return { from: days.from, to: days.to };
}

/** The search the filters make, on `today`, months from `start` */
export const searchOf = (filters: Filters, today: string, start = 1): SearchQuery => ({
  q: filters.q,
  account: filters.account,
  category: filters.category,
  kinds: filters.kinds,
  ...dayRange(filters.days, today, start),
  ...(filters.scheduled && { scheduled: true }),
});
