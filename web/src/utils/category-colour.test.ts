import { expect, test } from 'vitest';
import type { Category } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { categoryColour } from './category-colour';

// Each spending category wears one of six colours (--c1 to --c6), as the design draws them:
// the starting ones each have their own, and one a person adds takes one from its id, so
// no category's colour moves when others are added, moved, renamed or archived. A
// subcategory wears its parent's, "Other" stays a quiet grey, and income is green.

const SIX = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)', 'var(--c5)', 'var(--c6)'];

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

test('a category a person adds keeps its colour however the list changes around it', () => {
  const added = cat('5f0c2e9a1b7d3c44', 'Pets', 3);
  const list = [cat('a1', 'Food', 0), cat('b2', 'Fun', 1), cat('c3', 'Travel', 2), added];
  const colour = categoryColour(list, added.id);
  expect(SIX).toContain(colour);
  // Moved to the top, the others archived or renamed, and more added before it
  const changed = [
    { ...added, position: 0 },
    cat('a1', 'Eating out', 1, { archived: true }),
    cat('c3', 'Travel', 2, { archived: true }),
    ...Array.from({ length: 7 }, (_, i) => cat(`n${i}`, `New ${i}`, 3 + i)),
  ];
  expect(categoryColour(changed, added.id)).toBe(colour);
});

test('categories a person adds spread over all six colours', () => {
  const list = Array.from({ length: 60 }, (_, i) =>
    cat((i * 7919).toString(16).padStart(16, '0'), `Category ${i}`, i),
  );
  expect(new Set(list.map((c) => categoryColour(list, c.id)))).toEqual(new Set(SIX));
});

test('a subcategory wears its parent’s colour', () => {
  const list = [
    cat('food', 'Food', 0),
    cat('fun', 'Fun', 1),
    cat('cafe', 'Coffee', 0, { parentId: 'fun' }),
  ];
  expect(categoryColour(list, 'cafe')).toBe(categoryColour(list, 'fun'));
  expect(SIX).toContain(categoryColour(list, 'cafe'));
});

test('"Other" is grey and takes no colour from the others', () => {
  const list = [cat('a', 'Food', 0), cat('o', 'Other', 1), cat('b', 'Fun', 2)];
  expect(categoryColour(list, 'o')).toBe('var(--line-2)');
  expect(SIX).toContain(categoryColour(list, 'b'));
});

test('income categories are green', () => {
  const list = [cat('s', 'Salary', 0, { kind: 'income' }), cat('a', 'Food', 0)];
  expect(categoryColour(list, 's')).toBe('var(--pos)');
  expect(SIX).toContain(categoryColour(list, 'a'));
});

test('the starting categories wear the design’s colours, grey for Other', () => {
  const colours = DEFAULT_CATEGORIES.map((c) => [c.name, categoryColour(DEFAULT_CATEGORIES, c.id)]);
  // As R-Categories draws them
  expect(Object.fromEntries(colours)).toEqual({
    'Food': 'var(--c3)',
    'Transport': 'var(--c5)',
    'Groceries': 'var(--c1)',
    'Bills': 'var(--c4)',
    'Shopping': 'var(--c2)',
    'Health': 'var(--c4)',
    'Fun': 'var(--c6)',
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

test('a starting category keeps its colour renamed, moved, or with others added', () => {
  const food = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!;
  const list = [
    cat('5f0c2e9a1b7d3c44', 'Pets', 0),
    { ...food, name: 'Eating out', position: 5 },
    ...DEFAULT_CATEGORIES.filter((c) => c.id !== food.id),
  ];
  expect(categoryColour(list, food.id)).toBe('var(--c3)');
});

test('only a category named exactly "Other" is the grey one', () => {
  const list = [cat('a', 'other', 0), cat('b', 'Other things', 1)];
  expect(SIX).toContain(categoryColour(list, 'a'));
  expect(SIX).toContain(categoryColour(list, 'b'));
});

test('the same list always gives the same colours, and is left as it was', () => {
  const list = [cat('b', 'Fun', 1), cat('a', 'Food', 0)];
  const before = structuredClone(list);
  const first = list.map((c) => categoryColour(list, c.id));
  expect(list.map((c) => categoryColour(list, c.id))).toEqual(first);
  expect(list).toEqual(before);
});
