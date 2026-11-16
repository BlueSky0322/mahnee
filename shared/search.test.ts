import { describe, expect, test } from 'vitest';
import type { Category, Transaction } from './api';
import { DEFAULT_CATEGORIES } from './categories';
import { EMPTY_SEARCH, matchesSearch, readSearch, searchParams } from './search';

// What a search asks for, read the same way by the Worker and the app's stand-in, and
// whether a transaction matches it. Activity's kind filter is part of it: spending,
// income, transfers, or any two of them ("Expenses and income").

const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const categories: Category[] = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
/** An address's parts, read as a browser reads them (shared/ has no URLSearchParams) */
const partsOf = (query: string) =>
  new Map(
    query
      .split('&')
      .filter(Boolean)
      .map((part) => {
        const [key, value = ''] = part.split('=');
        return [decodeURIComponent(key), decodeURIComponent(value)] as const;
      }),
  );
const read = (query: string) => {
  const parts = partsOf(query);
  return readSearch({ get: (key) => parts.get(key) ?? null });
};
const write = (params: Record<string, string>) =>
  Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');

const t = (over: Partial<Transaction>): Transaction => ({
  id: 'a'.repeat(16),
  kind: 'expense',
  accountId: 'b'.repeat(16),
  toAccountId: null,
  amountCents: 850,
  categoryId: id('Food'),
  payee: 'Kopi Corner',
  note: null,
  date: '2026-11-05',
  createdAt: 1,
  ...over,
});
const spent = t({});
const received = t({ kind: 'income', categoryId: id('Salary'), payee: 'Acme' });
const moved = t({ kind: 'transfer', categoryId: null, toAccountId: 'c'.repeat(16) });

describe('the kind filter', () => {
  test('is every kind when not asked', () => {
    expect(read('')).toEqual({ ...EMPTY_SEARCH });
    expect(EMPTY_SEARCH.kinds).toBeNull();
    expect(read('kind=')).toMatchObject({ kinds: null });
  });

  test('reads one kind, or several in the order expense, income, transfer', () => {
    expect(read('kind=expense')).toMatchObject({ kinds: ['expense'] });
    expect(read('kind=transfer')).toMatchObject({ kinds: ['transfer'] });
    expect(read('kind=income,expense')).toMatchObject({ kinds: ['expense', 'income'] });
    expect(read('kind=transfer,income,expense')).toMatchObject({
      kinds: ['expense', 'income', 'transfer'],
    });
  });

  test.each([
    ['an unknown kind', 'kind=spending'],
    ['a kind named twice', 'kind=expense,expense'],
    ['an empty part', 'kind=expense,'],
    ['a kind in capitals', 'kind=Expense'],
  ])('refuses %s', (_what, query) => {
    expect(read(query)).toEqual({ error: 'Give kinds from expense, income and transfer' });
  });

  test('is written into the address as it is read back', () => {
    const query = { ...EMPTY_SEARCH, q: 'kopi', kinds: ['expense', 'income'] as const };
    const params = searchParams({ ...query, kinds: [...query.kinds] });
    expect(params).toEqual({ q: 'kopi', kind: 'expense,income' });
    expect(read(write(params))).toEqual({
      ...query,
      kinds: ['expense', 'income'],
    });
    // Every kind is no filter at all, so nothing is written
    expect(searchParams({ ...EMPTY_SEARCH })).toEqual({});
  });

  test('finds only the kinds asked for', () => {
    const only = (kinds: Transaction['kind'][] | null) =>
      [spent, received, moved]
        .filter((x) => matchesSearch(x, { ...EMPTY_SEARCH, kinds }, categories))
        .map((x) => x.kind);
    expect(only(null)).toEqual(['expense', 'income', 'transfer']);
    expect(only(['expense'])).toEqual(['expense']);
    expect(only(['income'])).toEqual(['income']);
    expect(only(['transfer'])).toEqual(['transfer']);
    expect(only(['expense', 'income'])).toEqual(['expense', 'income']);
  });

  test('narrows words and the other filters too', () => {
    const query = { ...EMPTY_SEARCH, q: 'kopi', kinds: ['income' as const] };
    expect(matchesSearch(spent, query, categories)).toBe(false);
    expect(matchesSearch({ ...received, payee: 'Kopi refund' }, query, categories)).toBe(true);
    expect(
      matchesSearch(spent, { ...EMPTY_SEARCH, kinds: ['expense'], from: '2026-11-06' }, categories),
    ).toBe(false);
  });
});
