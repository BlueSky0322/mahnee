// Searching a person's transactions (GET /api/search): what a search asks for, read from
// the address the same way by the Worker and the app's test stand-in, and whether a
// transaction matches it. The Worker matches in SQL; the app uses matchesSearch to keep a
// list of results right as changes are made to it before the server has them, so the two
// must agree: words are found anywhere in the payee, the note, the category's name or its
// parent's (so "food" finds Food › Coffee), ignoring the case of A to Z only (as SQLite's
// lower() does); words that read as an amount ("8", "8.50", "1,000") also find that exact
// amount.

import type { Category, Transaction } from './api';
import { isOnAccount } from './ledger';

/** The longest search, in characters, once trimmed */
export const MAX_SEARCH_TEXT = 100;

/** What a search asks for; null where it doesn't filter */
export interface SearchQuery {
  /** Words to find, trimmed; '' for none */
  q: string;
  /** Only transactions on this account (a transfer into it too) */
  account: string | null;
  /** Only this category, and its subcategories when it's a top-level one */
  category: string | null;
  /** Only from this day (2025-09-01), and up to this one, both included */
  from: string | null;
  to: string | null;
}

export const EMPTY_SEARCH: SearchQuery = {
  q: '',
  account: null,
  category: null,
  from: null,
  to: null,
};

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether `v` is a real calendar day, as 2025-09-01 */
function isCalendarDay(v: string) {
  const m = DAY_PATTERN.exec(v);
  if (m == null) return false;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return at.toISOString().slice(0, 10) === v;
}

/**
 * The search an address asks for (?q=&account=&category=&from=&to=, each read with `get`),
 * or why it can't be one
 */
export function readSearch(params: {
  get: (key: string) => string | null;
}): SearchQuery | { error: string } {
  const q = (params.get('q') ?? '').trim();
  if (q.length > MAX_SEARCH_TEXT) {
    return { error: `Search for up to ${MAX_SEARCH_TEXT} characters` };
  }
  const days: Record<'from' | 'to', string | null> = { from: null, to: null };
  for (const key of ['from', 'to'] as const) {
    const day = params.get(key) || null;
    if (day != null && !isCalendarDay(day)) return { error: 'Give a day, like 2025-09-01' };
    days[key] = day;
  }
  const account = params.get('account') || null;
  const category = params.get('category') || null;
  return { q, account, category, ...days };
}

/** A search's parts for its address, as readSearch reads them, only those it filters by */
export function searchParams(query: SearchQuery): Record<string, string> {
  const params: Record<string, string> = {};
  if (query.q !== '') params.q = query.q;
  for (const key of ['account', 'category', 'from', 'to'] as const) {
    const value = query[key];
    if (value != null) params[key] = value;
  }
  return params;
}

/** Letters A to Z in lower case, others as they are (as SQLite's lower() folds them) */
export const foldCase = (text: string) => text.replace(/[A-Z]/g, (c) => c.toLowerCase());

const AMOUNT_PATTERN = /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/;

/** The amount words read as, in cents ("8.50" is 850, "1,000" is 100000), or null */
export function searchAmount(q: string): number | null {
  if (!AMOUNT_PATTERN.test(q)) return null;
  const [whole, part = ''] = q.replace(/,/g, '').split('.');
  const cents = Number(whole) * 100 + Number(part.padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

/**
 * The categories a category filter takes in: the one named and, for a top-level one, the
 * ones under it
 */
export const categoriesIn = (categories: readonly Category[], id: string) =>
  new Set([id, ...categories.filter((c) => c.parentId === id).map((c) => c.id)]);

/** Whether `t` is found by `query`, with the person's `categories` for names and parents */
export function matchesSearch(
  t: Transaction,
  query: SearchQuery,
  categories: readonly Category[],
): boolean {
  if (query.account != null && !isOnAccount(t, query.account)) return false;
  if (query.category != null) {
    if (t.categoryId == null || !categoriesIn(categories, query.category).has(t.categoryId)) {
      return false;
    }
  }
  if (query.from != null && t.date < query.from) return false;
  if (query.to != null && t.date > query.to) return false;
  if (query.q === '') return true;
  if (searchAmount(query.q) === t.amountCents) return true;
  const category = categories.find((c) => c.id === t.categoryId);
  const parent = categories.find((c) => c.id === category?.parentId);
  const words = foldCase(query.q);
  return [t.payee, t.note, category?.name, parent?.name].some(
    (text) => text != null && foldCase(text).includes(words),
  );
}
