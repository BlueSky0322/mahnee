import type { Account, Category, Ledger, LedgerChange } from '@shared/api';
import { nextPosition, reorder, siblingsOf } from '@shared/categories';
import { DEFAULT_CURRENCY } from '@shared/ledger';

// Changes shown before the server has them: the ledger as it will be once they're
// saved, worked out the way the server saves them. Each change can be applied again to
// a copy that already has it (a fresh copy from the server while it was being sent)
// and comes out the same.

/** The ledger with `changes` made to it, in order; the one passed in is left as it was */
export function apply(ledger: Ledger, changes: LedgerChange[]): Ledger {
  let next = ledger;
  for (const change of changes) next = applyOne(next, change);
  return next;
}

function applyOne(ledger: Ledger, change: LedgerChange): Ledger {
  switch (change.op) {
    case 'addAccount':
    case 'updateAccount':
    case 'archiveAccount':
      return { ...ledger, accounts: applyToAccounts(ledger.accounts, change) };
    case 'addCategory':
    case 'updateCategory':
    case 'archiveCategory':
      return { ...ledger, categories: applyToCategories(ledger.categories, change) };
  }
}

function applyToAccounts(accounts: Account[], change: LedgerChange): Account[] {
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
    default:
      return accounts;
  }
}

function applyToCategories(categories: Category[], change: LedgerChange): Category[] {
  switch (change.op) {
    case 'addCategory': {
      const { id, name, kind, parentId } = change.category;
      if (categories.some((c) => c.id === id)) return categories;
      // Last among the ones beside it, as the server puts it
      const position = nextPosition(siblingsOf(categories, kind, parentId));
      return [...categories, { id, name, kind, parentId, position, archived: false }];
    }
    case 'updateCategory': {
      const found = categories.find((c) => c.id === change.id);
      if (found == null) return categories;
      let moved: Category = { ...found, name: change.name ?? found.name };
      // Moved under another (or to the top level): last among its new siblings
      if (change.parentId !== undefined && change.parentId !== found.parentId) {
        const siblings = siblingsOf(categories, found.kind, change.parentId);
        moved = { ...moved, parentId: change.parentId, position: nextPosition(siblings) };
      }
      let next = categories.map((c) => (c.id === moved.id ? moved : c));
      if (change.position != null) {
        // Its siblings numbered afresh from 0, with it in its new place
        const order = reorder(
          siblingsOf(next, moved.kind, moved.parentId),
          moved.id,
          change.position,
        );
        next = next.map((c) => {
          const at = order.indexOf(c.id);
          return at < 0 || at === c.position ? c : { ...c, position: at };
        });
      }
      return next;
    }
    case 'archiveCategory':
      return categories.map((c) => (c.id === change.id ? { ...c, archived: change.archived } : c));
    default:
      return categories;
  }
}
