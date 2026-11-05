import { describe, expect, test } from 'vitest';
import type { Account, Category, LedgerChange } from '@shared/api';
import { apply as applyToLedger } from './apply';

/** The accounts once `changes` are made to them (with no categories beside them) */
const apply = (accounts: Account[], changes: LedgerChange[]) =>
  applyToLedger({ accounts, categories: [] }, changes).accounts;

const account = (id: string, changes: Partial<Account> = {}): Account => ({
  id,
  name: `Account ${id}`,
  kind: 'bank',
  currency: 'MYR',
  openingCents: 0,
  balanceCents: 0,
  position: 0,
  archived: false,
  ...changes,
});

describe('apply to accounts', () => {
  test('adds an account last in the list, holding its opening balance', () => {
    const before = [account('a', { position: 0 }), account('b', { position: 3 })];
    const after = apply(before, [
      {
        op: 'addAccount',
        account: { id: 'c', name: 'Visa', kind: 'card', openingCents: -12_000 },
      },
    ]);
    expect(after[2]).toEqual({
      id: 'c',
      name: 'Visa',
      kind: 'card',
      currency: 'MYR',
      openingCents: -12_000,
      balanceCents: -12_000,
      position: 4,
      archived: false,
    });
    // What it was given is left as it was
    expect(before).toHaveLength(2);
  });

  test('adds the first account at the top', () => {
    const [first] = apply(
      [],
      [{ op: 'addAccount', account: { id: 'a', name: 'Wallet', kind: 'cash', openingCents: 0 } }],
    );
    expect(first.position).toBe(0);
  });

  test('comes out the same applied to a copy that already has the change', () => {
    const add = {
      op: 'addAccount' as const,
      account: { id: 'a', name: 'Wallet', kind: 'cash' as const, openingCents: 500 },
    };
    const rename = { op: 'updateAccount' as const, id: 'a', name: 'Purse', openingCents: 700 };
    const once = apply([], [add, rename]);
    expect(apply(once, [add, rename])).toEqual(once);
  });

  test('renames without touching the balance, and moves the balance with the opening', () => {
    const before = [account('a', { openingCents: 1_000, balanceCents: 5_000 }), account('b')];
    const renamed = apply(before, [{ op: 'updateAccount', id: 'a', name: 'Savings' }]);
    expect(renamed[0]).toMatchObject({ name: 'Savings', openingCents: 1_000, balanceCents: 5_000 });
    // What came in and went out since (4,000) stays on top of the new opening
    const reopened = apply(renamed, [{ op: 'updateAccount', id: 'a', openingCents: -500 }]);
    expect(reopened[0]).toMatchObject({ name: 'Savings', openingCents: -500, balanceCents: 3_500 });
    expect(reopened[1]).toBe(before[1]);
  });

  test('archives one account and brings it back', () => {
    const before = [account('a'), account('b')];
    const archived = apply(before, [{ op: 'archiveAccount', id: 'b', archived: true }]);
    expect(archived.map((a) => a.archived)).toEqual([false, true]);
    const back = apply(archived, [{ op: 'archiveAccount', id: 'b', archived: false }]);
    expect(back.map((a) => a.archived)).toEqual([false, false]);
  });

  test('applies changes in order, so a later one sees an account added before it', () => {
    const after = apply(
      [],
      [
        { op: 'addAccount', account: { id: 'a', name: 'Wallet', kind: 'cash', openingCents: 0 } },
        { op: 'updateAccount', id: 'a', name: 'Purse' },
        { op: 'archiveAccount', id: 'a', archived: true },
      ],
    );
    expect(after).toEqual([expect.objectContaining({ id: 'a', name: 'Purse', archived: true })]);
  });
});

const category = (id: string, changes: Partial<Category> = {}): Category => ({
  id,
  name: `Category ${id}`,
  kind: 'expense',
  parentId: null,
  position: 0,
  archived: false,
  ...changes,
});

/** The categories once `changes` are made to them */
const applyCategories = (categories: Category[], changes: LedgerChange[]) =>
  applyToLedger({ accounts: [], categories }, changes).categories;

/** Each category's id at its place: "food:0" */
const places = (categories: Category[]) =>
  [...categories]
    .sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    .map((c) => `${c.id}:${c.parentId ?? '-'}:${c.position}`);

describe('apply to categories', () => {
  test('adds one last among the ones beside it: same kind, same parent', () => {
    const before = [
      category('food', { position: 0 }),
      category('fun', { position: 4 }),
      category('salary', { kind: 'income', position: 7 }),
      category('coffee', { parentId: 'food', position: 2 }),
    ];
    const after = applyCategories(before, [
      {
        op: 'addCategory',
        category: { id: 'bills', name: 'Bills', kind: 'expense', parentId: null },
      },
      {
        op: 'addCategory',
        category: { id: 'tea', name: 'Tea', kind: 'expense', parentId: 'food' },
      },
      {
        op: 'addCategory',
        category: { id: 'bonus', name: 'Bonus', kind: 'income', parentId: null },
      },
    ]);
    expect(after.slice(4)).toEqual([
      { id: 'bills', name: 'Bills', kind: 'expense', parentId: null, position: 5, archived: false },
      { id: 'tea', name: 'Tea', kind: 'expense', parentId: 'food', position: 3, archived: false },
      { id: 'bonus', name: 'Bonus', kind: 'income', parentId: null, position: 8, archived: false },
    ]);
    expect(before).toHaveLength(4);
  });

  test('moves one under another, last there, and back to the top level, last there', () => {
    const before = [
      category('food', { position: 0 }),
      category('fun', { position: 1 }),
      category('coffee', { parentId: 'food', position: 0 }),
      category('drinks', { position: 2 }),
    ];
    const under = applyCategories(before, [
      { op: 'updateCategory', id: 'drinks', parentId: 'food' },
    ]);
    expect(under.find((c) => c.id === 'drinks')).toMatchObject({ parentId: 'food', position: 1 });
    const back = applyCategories(under, [{ op: 'updateCategory', id: 'coffee', parentId: null }]);
    expect(back.find((c) => c.id === 'coffee')).toMatchObject({ parentId: null, position: 2 });
    // Staying where it is, nothing moves
    expect(applyCategories(back, [{ op: 'updateCategory', id: 'fun', parentId: null }])).toEqual(
      back,
    );
  });

  test('puts one at a place among its siblings, numbering them afresh, others left alone', () => {
    const before = [
      category('a', { position: 0 }),
      category('b', { position: 3 }),
      category('c', { position: 7 }),
      category('x', { kind: 'income', position: 1 }),
      category('s', { parentId: 'a', position: 0 }),
    ];
    const after = applyCategories(before, [{ op: 'updateCategory', id: 'c', position: 0 }]);
    expect(places(after.filter((c) => c.kind === 'expense' && c.parentId == null))).toEqual([
      'c:-:0',
      'a:-:1',
      'b:-:2',
    ]);
    expect(after.find((c) => c.id === 'x')).toBe(before[3]);
    expect(after.find((c) => c.id === 's')).toBe(before[4]);
    // Past the end is last
    const last = applyCategories(after, [{ op: 'updateCategory', id: 'c', position: 99 }]);
    expect(places(last.filter((c) => c.kind === 'expense' && c.parentId == null))).toEqual([
      'a:-:0',
      'b:-:1',
      'c:-:2',
    ]);
  });

  test('moves, then places among the new siblings, in one change', () => {
    const before = [
      category('food', { position: 0 }),
      category('coffee', { parentId: 'food', position: 0 }),
      category('tea', { parentId: 'food', position: 1 }),
      category('drinks', { position: 1 }),
    ];
    const after = applyCategories(before, [
      { op: 'updateCategory', id: 'drinks', name: 'Juice', parentId: 'food', position: 1 },
    ]);
    expect(places(after.filter((c) => c.parentId === 'food'))).toEqual([
      'coffee:food:0',
      'drinks:food:1',
      'tea:food:2',
    ]);
    expect(after.find((c) => c.id === 'drinks')?.name).toBe('Juice');
  });

  test('renames, archives and brings back one category', () => {
    const before = [category('a'), category('b', { position: 1 })];
    const renamed = applyCategories(before, [
      { op: 'updateCategory', id: 'a', name: 'Eating out' },
    ]);
    expect(renamed[0]).toEqual({ ...before[0], name: 'Eating out' });
    const archived = applyCategories(renamed, [{ op: 'archiveCategory', id: 'b', archived: true }]);
    expect(archived.map((c) => c.archived)).toEqual([false, true]);
    const back = applyCategories(archived, [{ op: 'archiveCategory', id: 'b', archived: false }]);
    expect(back.map((c) => c.archived)).toEqual([false, false]);
  });

  test('comes out the same applied to a copy that already has the changes', () => {
    const changes: LedgerChange[] = [
      { op: 'addCategory', category: { id: 'tea', name: 'Tea', kind: 'expense', parentId: null } },
      { op: 'updateCategory', id: 'tea', parentId: 'food', position: 0 },
      { op: 'updateCategory', id: 'fun', position: 0 },
    ];
    const once = applyCategories(
      [category('food'), category('fun', { position: 1 }), category('x', { parentId: 'food' })],
      changes,
    );
    expect(applyCategories(once, changes)).toEqual(once);
  });

  test('leaves the accounts as they were, and the categories for account changes', () => {
    const ledger = { accounts: [account('a')], categories: [category('food')] };
    const after = applyToLedger(ledger, [
      { op: 'updateCategory', id: 'food', name: 'Meals' },
      { op: 'updateAccount', id: 'a', name: 'Purse' },
    ]);
    expect(after.accounts[0].name).toBe('Purse');
    expect(after.categories[0].name).toBe('Meals');
    expect(ledger.categories[0].name).toBe('Category food');
  });
});
