import { describe, expect, test } from 'vitest';
import type { Account } from '@shared/api';
import { apply } from './apply';

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

describe('apply', () => {
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
