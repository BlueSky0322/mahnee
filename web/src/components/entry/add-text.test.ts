import { describe, expect, test } from 'vitest';
import type { Category } from '@shared/api';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { EMPTY_KEYPAD, press, typeKeys } from '@shared/keypad';
import { categoryTree } from '../../ledger/category-tree';
import { formatMoney } from '../../utils/money';
import { payeeHint, recentCategories, saveLabel } from './add-text';

// Add's words and choices: what Save says it will do (R-Add's labels), the five recent
// categories (digest 4.8), and the hint a payee gives a new category (R-Add-Pick).
// The figures and names are made up.

describe('saveLabel', () => {
  test('asks for an amount until there is one above zero', () => {
    expect(saveLabel('expense', EMPTY_KEYPAD, 'MYR')).toBe('Type an amount');
    expect(saveLabel('expense', typeKeys('0'), 'MYR')).toBe('Type an amount');
    expect(saveLabel('expense', typeKeys('6-6'), 'MYR')).toBe('Type an amount');
  });

  test('says when the total is below zero', () => {
    expect(saveLabel('income', typeKeys('2-3'), 'MYR')).toBe('The total is below zero');
  });

  test('saves spending and income, and moves a transfer, by the total', () => {
    expect(saveLabel('expense', typeKeys('3.07+11.6'), 'MYR')).toBe('Save RM 14.67');
    expect(saveLabel('income', typeKeys('1250.5'), 'MYR')).toBe('Save RM 1,250.50');
    expect(saveLabel('transfer', typeKeys('40'), 'MYR')).toBe('Move RM 40.00');
  });

  test('names the largest amount when a key went past it', () => {
    const refused = press(typeKeys('10000000'), '1');
    expect(refused.tooMuch).toBe(true);
    expect(saveLabel('expense', refused, 'MYR')).toBe('Up to 10,000,000');
    expect(saveLabel('transfer', refused, 'MYR')).toBe('Up to 10,000,000');
  });

  test('writes the account’s own currency, as amounts are shown elsewhere', () => {
    expect(saveLabel('expense', typeKeys('9.5'), 'SGD')).toBe(`Save ${formatMoney(950, 'SGD')}`);
    expect(saveLabel('transfer', typeKeys('9.5'), 'SGD')).toBe(`Move ${formatMoney(950, 'SGD')}`);
    expect(saveLabel('expense', typeKeys('9.5'), 'SGD')).not.toContain('RM');
  });
});

describe('recentCategories', () => {
  const COFFEE: Category = {
    id: 'e'.repeat(16),
    name: 'Coffee',
    kind: 'expense',
    parentId: DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id,
    position: 0,
    archived: false,
  };
  const id = (name: string) => DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
  const names = (list: { name: string }[]) => list.map((c) => c.name);

  test('with none used, the first five of the kind in their order', () => {
    const tree = categoryTree([...DEFAULT_CATEGORIES]);
    expect(names(recentCategories([], tree.listed.expense))).toEqual([
      'Food',
      'Transport',
      'Groceries',
      'Bills',
      'Shopping',
    ]);
    expect(names(recentCategories([], tree.listed.income))).toEqual(['Salary', 'Other income']);
  });

  test('the ones used first, then the rest in order, each once, five at most', () => {
    const tree = categoryTree([...DEFAULT_CATEGORIES, COFFEE]);
    const list = recentCategories([COFFEE.id, id('Fun'), id('Food')], tree.listed.expense);
    expect(names(list)).toEqual(['Coffee', 'Fun', 'Food', 'Transport', 'Groceries']);
    // With the name the For row shows
    expect(list[0].fullName).toBe('Food › Coffee');
    expect(list[1].fullName).toBe('Fun');
  });

  test('passes over archived and unknown ones, and another kind’s', () => {
    const categories = DEFAULT_CATEGORIES.map((c) => ({ ...c, archived: c.name === 'Fun' }));
    const tree = categoryTree([...categories, { ...COFFEE, archived: true }]);
    const list = recentCategories(
      [id('Fun'), COFFEE.id, 'f'.repeat(16), id('Salary'), id('Bills')],
      tree.listed.expense,
    );
    expect(names(list)).toEqual(['Bills', 'Food', 'Transport', 'Groceries', 'Shopping']);
  });
});

describe('payeeHint', () => {
  const categories: Category[] = [
    ...DEFAULT_CATEGORIES,
    {
      id: 'e'.repeat(16),
      name: 'Coffee',
      kind: 'expense',
      parentId: DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id,
      position: 0,
      archived: false,
    },
  ];
  const id = (name: string) => categories.find((c) => c.name === name)!.id;
  const payees = [
    { payee: 'Kedai Mesra', kind: 'expense' as const, categoryId: id('Groceries') },
    { payee: 'Tealeaf Co', kind: 'expense' as const, categoryId: id('Coffee') },
    { payee: 'Kedai Mesra', kind: 'income' as const, categoryId: id('Salary') },
  ];

  test('names the category the payee was last in, ignoring case and spaces at the ends', () => {
    expect(payeeHint(' kedai MESRA ', 'expense', payees, categories)).toEqual({
      parentId: id('Groceries'),
      parentName: 'Groceries',
      text: 'Kedai Mesra was in Groceries',
    });
    expect(payeeHint('Kedai Mesra', 'income', payees, categories)).toEqual({
      parentId: id('Salary'),
      parentName: 'Salary',
      text: 'Kedai Mesra was in Salary',
    });
  });

  test('a subcategory’s new neighbour goes under its own category', () => {
    expect(payeeHint('Tealeaf Co', 'expense', payees, categories)).toEqual({
      parentId: id('Food'),
      parentName: 'Food',
      text: 'Tealeaf Co was in Food › Coffee',
    });
  });

  test('gives none for no payee, one not known, or a category no longer listed', () => {
    expect(payeeHint('', 'expense', payees, categories)).toBeNull();
    expect(payeeHint('Nobody', 'expense', payees, categories)).toBeNull();
    // Only the payee's category of the kind being added
    expect(payeeHint('Tealeaf Co', 'income', payees, categories)).toBeNull();
    const archived = categories.map((c) => ({ ...c, archived: c.name === 'Groceries' }));
    expect(payeeHint('Kedai Mesra', 'expense', payees, archived)).toBeNull();
  });

  test('gives none when the category it names has no room for another under it', () => {
    const full = [
      ...categories,
      ...Array.from({ length: 50 }, (_, i) => ({
        id: i.toString(16).padStart(16, '9'),
        name: `Sub ${i}`,
        kind: 'expense' as const,
        parentId: id('Groceries'),
        position: i,
        archived: i % 2 === 0,
      })),
    ];
    expect(payeeHint('Kedai Mesra', 'expense', payees, full)).toBeNull();
  });
});
