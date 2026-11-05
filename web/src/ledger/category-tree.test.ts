import { describe, expect, test } from 'vitest';
import type { Category } from '@shared/api';
import { categoryTree } from './category-tree';

const category = (id: string, changes: Partial<Category> = {}): Category => ({
  id,
  name: id,
  kind: 'expense',
  parentId: null,
  position: 0,
  archived: false,
  ...changes,
});

describe('categoryTree', () => {
  test('lists each kind in order, each top-level category with its subcategories in order', () => {
    const tree = categoryTree([
      category('tea', { parentId: 'food', position: 1 }),
      category('fun', { position: 1 }),
      category('salary', { kind: 'income' }),
      category('food', { position: 0 }),
      category('coffee', { parentId: 'food', position: 0 }),
    ]);
    expect(tree.listed.expense.map((c) => [c.id, c.subcategories.map((s) => s.id)])).toEqual([
      ['food', ['coffee', 'tea']],
      ['fun', []],
    ]);
    expect(tree.listed.income.map((c) => c.id)).toEqual(['salary']);
    expect(tree.archived).toEqual([]);
  });

  test('sets archived ones apart; subcategories of an archived one go with it, uncounted', () => {
    const tree = categoryTree([
      category('food'),
      category('coffee', { parentId: 'food', archived: true }),
      category('tea', { parentId: 'food', position: 1 }),
      category('old', { position: 1, archived: true }),
      category('older', { parentId: 'old' }),
      category('oldest', { parentId: 'old', position: 1, archived: true }),
      category('gift', { kind: 'income', archived: true }),
    ]);
    expect(tree.listed.expense.map((c) => [c.id, c.subcategories.map((s) => s.id)])).toEqual([
      ['food', ['tea']],
    ]);
    expect(tree.listed.income).toEqual([]);
    expect(tree.archived.map((c) => c.id)).toEqual(['coffee', 'old', 'gift']);
  });
});
