import type { Account, LedgerChange } from '@shared/api';
import { DEFAULT_CURRENCY } from '@shared/ledger';

// Changes shown before the server has them: the ledger as it will be once they're
// saved, worked out the way the server saves them. Each change can be applied again to
// a copy that already has it (a fresh copy from the server while it was being sent)
// and comes out the same.

/** The accounts with `changes` made to them, in order; the list passed in is left as it was */
export function apply(accounts: Account[], changes: LedgerChange[]): Account[] {
  let next = accounts;
  for (const change of changes) next = applyOne(next, change);
  return next;
}

function applyOne(accounts: Account[], change: LedgerChange): Account[] {
  switch (change.op) {
    case 'addAccount': {
      const { id, name, kind, openingCents } = change.account;
      if (accounts.some((a) => a.id === id)) return accounts;
      // Last in the list, as the server puts it
      const position = accounts.reduce((last, a) => Math.max(last, a.position + 1), 0);
      return [
        ...accounts,
        {
          id,
          name,
          kind,
          currency: DEFAULT_CURRENCY,
          openingCents,
          balanceCents: openingCents,
          position,
          archived: false,
        },
      ];
    }
    case 'updateAccount':
      return accounts.map((a) => {
        if (a.id !== change.id) return a;
        const openingCents = change.openingCents ?? a.openingCents;
        return {
          ...a,
          name: change.name ?? a.name,
          openingCents,
          // What came in and went out since stays as it was
          balanceCents: a.balanceCents + openingCents - a.openingCents,
        };
      });
    case 'archiveAccount':
      return accounts.map((a) => (a.id === change.id ? { ...a, archived: change.archived } : a));
  }
}
