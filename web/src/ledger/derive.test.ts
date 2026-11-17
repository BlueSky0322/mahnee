import { describe, expect, test } from 'vitest';
import type { Category } from '@shared/api';
import { UNKNOWN_CATEGORY, rollUp, rollUpEntries } from './derive';

const category = (id: string, changes: Partial<Category> = {}): Category => ({
  id,
  name: id,
  kind: 'expense',
  parentId: null,
  position: 0,
  archived: false,
  ...changes,
});

const categories = [
  category('food'),
  category('coffee', { parentId: 'food' }),
  category('tea', { parentId: 'food', archived: true }),
  category('fun'),
  category('films', { parentId: 'fun' }),
  // Its parent isn't in the list the app has
  category('stray', { parentId: 'gone' }),
];

describe('rollUp', () => {
  test('puts subcategories inside their category, with what was filed on it itself', () => {
    expect(
      rollUp(
        [
          { categoryId: 'food', cents: 800 },
          { categoryId: 'films', cents: 600 },
          { categoryId: 'tea', cents: 200 },
          { categoryId: 'coffee', cents: 300 },
        ],
        categories,
      ),
    ).toEqual([
      {
        id: 'food',
        name: 'food',
        cents: 1_300,
        ownCents: 800,
        // Largest first; an archived one still counts
        subcategories: [
          { id: 'coffee', name: 'coffee', cents: 300 },
          { id: 'tea', name: 'tea', cents: 200 },
        ],
      },
      {
        id: 'fun',
        name: 'fun',
        cents: 600,
        ownCents: 0,
        subcategories: [{ id: 'films', name: 'films', cents: 600 }],
      },
    ]);
  });

  test('keeps an amount whose category, or its parent, is not known', () => {
    expect(
      rollUp(
        [
          { categoryId: 'stray', cents: 100 },
          { categoryId: 'missing', cents: 50 },
        ],
        categories,
      ),
    ).toEqual([
      { id: 'stray', name: 'stray', cents: 100, ownCents: 100, subcategories: [] },
      { id: 'missing', name: UNKNOWN_CATEGORY, cents: 50, ownCents: 50, subcategories: [] },
    ]);
  });
});

// Plan's rows (R-Plan, digest 3.6 and 4.4): each top-level category with how many entries
// make it, its subcategories', and the payee when it is one entry in all
describe('rollUpEntries', () => {
  test('counts entries into the category, and keeps a payee only for one entry in all', () => {
    expect(
      rollUpEntries(
        [
          { categoryId: 'food', cents: 800, entries: 2 },
          { categoryId: 'coffee', cents: 300, entries: 1, payee: 'Kopi' },
          { categoryId: 'fun', cents: 600, entries: 1, payee: 'Cinema' },
          { categoryId: 'missing', cents: 50, entries: 1 },
        ],
        categories,
      ),
    ).toEqual([
      {
        id: 'food',
        name: 'food',
        cents: 1_100,
        ownCents: 800,
        entries: 3,
        // Three entries: Kopi names only one of them
        payee: null,
        subcategories: [{ id: 'coffee', name: 'coffee', cents: 300, entries: 1 }],
      },
      {
        id: 'fun',
        name: 'fun',
        cents: 600,
        ownCents: 600,
        entries: 1,
        payee: 'Cinema',
        subcategories: [],
      },
      {
        id: 'missing',
        name: UNKNOWN_CATEGORY,
        cents: 50,
        ownCents: 50,
        entries: 1,
        payee: null,
        subcategories: [],
      },
    ]);
  });

  test("names a subcategory's single entry's payee for its category, when it is the only one", () => {
    expect(
      rollUpEntries(
        [{ categoryId: 'films', cents: 1_200, entries: 1, payee: 'Netflix' }],
        categories,
      ),
    ).toEqual([
      {
        id: 'fun',
        name: 'fun',
        cents: 1_200,
        ownCents: 0,
        entries: 1,
        payee: 'Netflix',
        subcategories: [{ id: 'films', name: 'films', cents: 1_200, entries: 1 }],
      },
    ]);
  });

  test('gives the same totals, order and names as rollUp', () => {
    const totals = [
      { categoryId: 'food', cents: 800, entries: 4 },
      { categoryId: 'films', cents: 600, entries: 2 },
      { categoryId: 'tea', cents: 200, entries: 1 },
      { categoryId: 'coffee', cents: 300, entries: 3 },
      { categoryId: 'stray', cents: 100, entries: 1 },
    ];
    const plain = rollUp(totals, categories);
    const counted = rollUpEntries(totals, categories);
    expect(
      counted.map(({ entries: _e, payee: _p, subcategories, ...top }) => ({
        ...top,
        subcategories: subcategories.map(({ entries: _s, ...sub }) => sub),
      })),
    ).toEqual(plain);
    expect(counted.map((top) => top.entries)).toEqual([8, 2, 1]);
  });
});
