import { describe, expect, test } from 'vitest';
import type { Category, Transaction } from './api';
import { DEFAULT_CATEGORIES } from './categories';
import { EMPTY_SEARCH, matchesSearch } from './search';

// What words find, as the app asks while a list of results is open (an entry added or
// changed stays in it only if it still matches), the same rules the Worker's SQL keeps:
// anywhere in the payee, the note, the category's name or its parent's, with A to Z in
// either case; words that read as an amount find that exact amount too.

const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
const COFFEE = 'e'.repeat(16);
const categories: Category[] = [
  ...DEFAULT_CATEGORIES.map((c) => ({ ...c })),
  {
    id: COFFEE,
    name: 'Coffee',
    kind: 'expense',
    parentId: id('Food'),
    position: 0,
    archived: false,
  },
];

let n = 0;
const t = (over: Partial<Transaction>): Transaction => ({
  id: (++n).toString(16).padStart(16, '0'),
  kind: 'expense',
  accountId: 'a'.repeat(16),
  toAccountId: null,
  amountCents: 100,
  categoryId: id('Transport'),
  payee: null,
  note: null,
  date: '2026-11-05',
  createdAt: n,
  ...over,
});
const finds = (q: string, x: Transaction) => matchesSearch(x, { ...EMPTY_SEARCH, q }, categories);

describe('words', () => {
  test("find a subcategory by its parent's name, and by its own", () => {
    const latte = t({ categoryId: COFFEE });
    expect(finds('food', latte)).toBe(true);
    expect(finds('coffee', latte)).toBe(true);
    expect(finds('food', t({ categoryId: id('Transport') }))).toBe(false);
  });

  test('find the payee and the note whatever the case of A to Z', () => {
    expect(finds('kopi', t({ payee: 'KOPI KING' }))).toBe(true);
    expect(finds('KoPi', t({ note: 'kopi with Mei' }))).toBe(true);
    expect(finds('kopi', t({ payee: 'Teh tarik' }))).toBe(false);
  });
});

describe('an amount', () => {
  const at = (amountCents: number, over: Partial<Transaction> = {}) => t({ amountCents, ...over });

  test('"8" finds RM 8.00 exactly, not 8.50, 80 or 800, and a note with an 8 in it', () => {
    expect(finds('8', at(800))).toBe(true);
    expect(finds('8', at(850))).toBe(false);
    expect(finds('8', at(8_000))).toBe(false);
    expect(finds('8', at(80_000))).toBe(false);
    expect(finds('8', at(2_000, { note: '8 refund' }))).toBe(true);
  });

  test('"8.5" and "8.50" are RM 8.50; "1,000" is RM 1,000.00', () => {
    expect(finds('8.5', at(850))).toBe(true);
    expect(finds('8.50', at(850))).toBe(true);
    expect(finds('8.50', at(800))).toBe(false);
    expect(finds('1,000', at(100_000))).toBe(true);
    expect(finds('1,000', at(1_000))).toBe(false);
  });
});
