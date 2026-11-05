import { describe, expect, test } from 'vitest';
import type { Account, Category, LedgerChange, Transaction, TransactionPage } from '@shared/api';
import { isOnAccount } from '@shared/ledger';
import { apply as applyToLedger, applyToPages } from './apply';

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

const spent = (id: string, changes: Partial<Transaction> = {}): Transaction => ({
  id,
  kind: 'expense',
  accountId: 'a',
  toAccountId: null,
  amountCents: 800,
  categoryId: 'food',
  payee: null,
  note: null,
  date: '2026-11-05',
  createdAt: 1_000,
  ...changes,
});

const { createdAt: _, ...coffee } = spent('t1');
const addCoffee: LedgerChange = { op: 'addTransaction', transaction: coffee };

/** The balances once `changes` are made, transactions known as `known` holds them */
const balancesAfter = (accounts: Account[], changes: LedgerChange[], known: Transaction[] = []) =>
  Object.fromEntries(
    applyToLedger({ accounts, categories: [] }, changes, (id) =>
      known.find((t) => t.id === id),
    ).accounts.map((a) => [a.id, a.balanceCents]),
  );

describe('apply transactions to balances', () => {
  const wallet = account('a', { kind: 'cash', balanceCents: 10_000 });
  const card = account('c', { kind: 'card', balanceCents: -12_000 });

  test('spending takes from the account, and on a card adds to what is owed', () => {
    expect(
      balancesAfter(
        [wallet, card],
        [addCoffee, { op: 'addTransaction', transaction: { ...coffee, id: 't2', accountId: 'c' } }],
      ),
    ).toEqual({ a: 9_200, c: -12_800 });
  });

  test('income adds to the account', () => {
    const pay = { ...coffee, kind: 'income' as const, amountCents: 5_000 };
    expect(balancesAfter([wallet], [{ op: 'addTransaction', transaction: pay }])).toEqual({
      a: 15_000,
    });
  });

  test('an edit moves the balances by what changed, a later edit after it too', () => {
    const before = spent('t1');
    expect(
      balancesAfter(
        [wallet, card],
        [
          { op: 'updateTransaction', id: 't1', amountCents: 1_000 },
          { op: 'updateTransaction', id: 't1', accountId: 'c', kind: 'income', categoryId: 's' },
        ],
        [before],
      ),
      // The 8.00 spent from the wallet is taken back; 10.00 came into the card
    ).toEqual({ a: 10_800, c: -11_000 });
  });

  test('a deletion takes it back, and Undo adds it again', () => {
    const known = [spent('t1')];
    expect(balancesAfter([wallet], [{ op: 'removeTransaction', id: 't1' }], known)).toEqual({
      a: 10_800,
    });
    expect(
      balancesAfter([wallet], [{ op: 'removeTransaction', id: 't1' }, addCoffee], known),
    ).toEqual({ a: 10_000 });
  });

  test('a transfer takes from one account and adds to the other: a card owes less', () => {
    const bank = account('b', { balanceCents: 100_000 });
    const payCard = { ...coffee, kind: 'transfer' as const, accountId: 'b', toAccountId: 'c' };
    const paid = balancesAfter(
      [bank, wallet, card],
      [{ op: 'addTransaction', transaction: { ...payCard, amountCents: 5_000, categoryId: null } }],
    );
    expect(paid).toEqual({ b: 95_000, a: 10_000, c: -7_000 });
  });

  test('an edited transfer moves both balances by what changed, and a deletion takes it back', () => {
    // The 8.00 moved from the bank to the wallet is in these balances already
    const bank = account('b', { balanceCents: 100_000 });
    const known = [
      spent('t1', { kind: 'transfer', accountId: 'b', toAccountId: 'a', categoryId: null }),
    ];
    expect(
      balancesAfter(
        [bank, wallet, card],
        [
          { op: 'updateTransaction', id: 't1', amountCents: 1_000 },
          // Sent to the card instead: the wallet gives back what it was given
          { op: 'updateTransaction', id: 't1', toAccountId: 'c' },
        ],
        known,
      ),
    ).toEqual({ b: 99_800, a: 9_200, c: -11_000 });
    expect(balancesAfter([bank, wallet], [{ op: 'removeTransaction', id: 't1' }], known)).toEqual({
      b: 100_800,
      a: 9_200,
    });
  });

  test('a transaction not known moves no balance, and one already there is not added twice', () => {
    expect(balancesAfter([wallet], [{ op: 'removeTransaction', id: 't9' }])).toEqual({
      a: 10_000,
    });
    // A fresh copy from the server that has it already counts it
    expect(balancesAfter([wallet], [addCoffee], [spent('t1')])).toEqual({ a: 10_000 });
  });
});

describe('apply transactions to pages of a list', () => {
  const inWallet = (t: Transaction) => t.accountId === 'a';
  const ids = (pages: TransactionPage[]) => pages.map((p) => p.transactions.map((t) => t.id));
  // Two pages loaded, newest first, with more after them
  const pages: TransactionPage[] = [
    {
      transactions: [spent('t5', { date: '2026-11-05' }), spent('t4', { date: '2026-11-03' })],
      nextBefore: 'p1',
    },
    {
      transactions: [spent('t3', { date: '2026-11-02' }), spent('t2', { date: '2026-10-30' })],
      nextBefore: 'p2',
    },
  ];
  const add = (id: string, date: string): LedgerChange => ({
    op: 'addTransaction',
    transaction: { ...coffee, id, date },
  });

  test('puts a new one on the page whose days it falls in, and leaves one past them for later', () => {
    const after = applyToPages(
      pages,
      [add('n1', '2026-11-06'), add('n2', '2026-11-02'), add('n3', '2026-10-01')],
      inWallet,
    );
    expect(ids(after)).toEqual([
      ['n1', 't5', 't4'],
      ['n2', 't3', 't2'],
    ]);
  });

  test('keeps one on another account out, and moves one out when its account changes', () => {
    const after = applyToPages(
      pages,
      [
        { op: 'addTransaction', transaction: { ...coffee, id: 'n1', accountId: 'b' } },
        { op: 'updateTransaction', id: 't4', accountId: 'b' },
      ],
      inWallet,
    );
    expect(ids(after)).toEqual([['t5'], ['t3', 't2']]);
  });

  test('re-sorts an edited day, deletes, and brings in one moved here that it can look up', () => {
    const elsewhere = spent('x1', { accountId: 'b', date: '2026-11-04' });
    const after = applyToPages(
      pages,
      [
        { op: 'updateTransaction', id: 't2', date: '2026-11-04' },
        { op: 'removeTransaction', id: 't5' },
        { op: 'updateTransaction', id: 'x1', accountId: 'a' },
      ],
      inWallet,
      (id) => (id === 'x1' ? elsewhere : undefined),
    );
    expect(after[0].transactions.map((t) => [t.id, t.date])).toEqual([
      ['x1', '2026-11-04'],
      ['t2', '2026-11-04'],
      ['t4', '2026-11-03'],
    ]);
    expect(ids(after)[1]).toEqual(['t3']);
  });

  test("an account's list holds transfers out of it and into it, and lets one go once it isn't on it", () => {
    const onWallet = (t: Transaction) => isOnAccount(t, 'a');
    const out = { ...coffee, id: 'n1', kind: 'transfer' as const, toAccountId: 'b' };
    const into = { ...out, id: 'n2', accountId: 'b', toAccountId: 'a', date: '2026-11-04' };
    const both = applyToPages(
      pages,
      [
        { op: 'addTransaction', transaction: out },
        { op: 'addTransaction', transaction: into },
      ],
      onWallet,
    );
    expect(ids(both)[0]).toEqual(['n1', 't5', 'n2', 't4']);
    const after = applyToPages(
      both,
      [{ op: 'updateTransaction', id: 'n2', toAccountId: 'c' }],
      onWallet,
    );
    expect(ids(after)[0]).toEqual(['n1', 't5', 't4']);
  });

  test('comes out the same applied to pages that already have the changes', () => {
    const changes: LedgerChange[] = [
      add('n1', '2026-11-06'),
      { op: 'updateTransaction', id: 't4', amountCents: 1_200 },
      { op: 'removeTransaction', id: 't3' },
    ];
    const once = applyToPages(pages, changes, inWallet);
    expect(applyToPages(once, changes, inWallet)).toEqual(once);
  });
});
