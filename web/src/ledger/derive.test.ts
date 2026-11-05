import { describe, expect, test } from 'vitest';
import type { Category } from '@shared/api';
import { UNKNOWN_CATEGORY, rollUp } from './derive';

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
