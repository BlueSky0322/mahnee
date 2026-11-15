import { expect, test } from 'vitest';
import type { Category } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { categoryColour } from './category-colour';

// Each spending category gets one of six colours from its place in the list, as the design
// draws them (--c1 to --c6); a subcategory wears its parent's, "Other" stays a quiet grey,
// and income is green. Nothing is stored: it is worked out from the list each time.

const cat = (
  id: string,
  name: string,
  position: number,
  extra: Partial<Category> = {},
): Category => ({
  id,
  name,
  kind: 'expense',
  parentId: null,
  position,
  archived: false,
  ...extra,
});

test('top-level spending categories take the six colours in list order, then repeat', () => {
  const list = Array.from({ length: 8 }, (_, i) => cat(`c${i}`, `Category ${i}`, i));
  // Saved out of order: the list's order is their positions
  const shuffled = [...list].reverse();
  expect(list.map((c) => categoryColour(shuffled, c.id))).toEqual([
    'var(--c1)',
    'var(--c2)',
    'var(--c3)',
    'var(--c4)',
    'var(--c5)',
    'var(--c6)',
    'var(--c1)',
    'var(--c2)',
  ]);
});

test('a subcategory wears its parent’s colour', () => {
  const list = [
    cat('food', 'Food', 0),
    cat('fun', 'Fun', 1),
    cat('cafe', 'Coffee', 0, { parentId: 'fun' }),
  ];
  expect(categoryColour(list, 'cafe')).toBe('var(--c2)');
});

test('"Other" is grey and takes no colour from the others', () => {
  const list = [cat('a', 'Food', 0), cat('o', 'Other', 1), cat('b', 'Fun', 2)];
  expect(categoryColour(list, 'o')).toBe('var(--line-2)');
  expect(categoryColour(list, 'b')).toBe('var(--c2)');
});

test('an archived category keeps its colour, so the others don’t shift when one goes', () => {
  const list = [cat('a', 'Food', 0, { archived: true }), cat('b', 'Fun', 1)];
  expect(categoryColour(list, 'b')).toBe('var(--c2)');
});

test('income categories are green', () => {
  const list = [cat('s', 'Salary', 0, { kind: 'income' }), cat('a', 'Food', 0)];
  expect(categoryColour(list, 's')).toBe('var(--pos)');
  expect(categoryColour(list, 'a')).toBe('var(--c1)');
});

test('the starting categories: six colours and round again, grey for Other', () => {
  const colours = DEFAULT_CATEGORIES.map((c) => [c.name, categoryColour(DEFAULT_CATEGORIES, c.id)]);
  expect(Object.fromEntries(colours)).toEqual({
    'Food': 'var(--c1)',
    'Transport': 'var(--c2)',
    'Groceries': 'var(--c3)',
    'Bills': 'var(--c4)',
    'Shopping': 'var(--c5)',
    'Health': 'var(--c6)',
    'Fun': 'var(--c1)',
    'Other': 'var(--line-2)',
    'Salary': 'var(--pos)',
    'Other income': 'var(--pos)',
  });
});

test('a category that isn’t in the list is grey', () => {
  expect(categoryColour([cat('a', 'Food', 0)], 'gone')).toBe('var(--line-2)');
});

test('a subcategory of "Other" is grey, as Other is', () => {
  const list = [cat('a', 'Food', 0), cat('o', 'Other', 1), cat('s', 'Odds', 0, { parentId: 'o' })];
  expect(categoryColour(list, 's')).toBe('var(--line-2)');
});

test('income is green at every level, whatever it is called', () => {
  const list = [
    cat('s', 'Salary', 0, { kind: 'income' }),
    cat('b', 'Bonus', 0, { kind: 'income', parentId: 's' }),
    cat('o', 'Other', 1, { kind: 'income' }),
  ];
  expect(list.map((c) => categoryColour(list, c.id))).toEqual([
    'var(--pos)',
    'var(--pos)',
    'var(--pos)',
  ]);
});

test('two categories at the same place are ordered by id, however the list is sent', () => {
  const list = [cat('b', 'Fun', 0), cat('a', 'Food', 0)];
  for (const order of [list, [...list].reverse()]) {
    expect([categoryColour(order, 'a'), categoryColour(order, 'b')]).toEqual([
      'var(--c1)',
      'var(--c2)',
    ]);
  }
});

test('only a category named exactly "Other" is the grey one', () => {
  const list = [cat('a', 'other', 0), cat('b', 'Other things', 1)];
  expect(categoryColour(list, 'a')).toBe('var(--c1)');
  expect(categoryColour(list, 'b')).toBe('var(--c2)');
});

test('the same list always gives the same colours, and is left as it was', () => {
  const list = [cat('b', 'Fun', 1), cat('a', 'Food', 0)];
  const before = structuredClone(list);
  const first = list.map((c) => categoryColour(list, c.id));
  expect(list.map((c) => categoryColour(list, c.id))).toEqual(first);
  expect(list).toEqual(before);
});
