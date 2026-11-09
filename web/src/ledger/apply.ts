import type {
  Account,
  Category,
  Ledger,
  LedgerChange,
  Recurring,
  Transaction,
  TransactionPage,
} from '@shared/api';
import { nextPosition, reorder, siblingsOf } from '@shared/categories';
import { DEFAULT_CURRENCY, balanceEffect } from '@shared/ledger';
import { nextAfter } from '@shared/recurring';

// Changes shown before the server has them: the ledger and lists of transactions as
// they will be once they're saved, worked out the way the server saves them. Each change
// can be applied again to a copy that already has it (a fresh copy from the server while
// it was being sent) and comes out the same, as long as the transaction it names is
// known as it was: a balance moves by what a transaction changed, so applying one needs
// it as it was before (`Lookup`).

/** A transaction as it is before the changes being applied; undefined when not known */
export type Lookup = (id: string) => Transaction | undefined;

const unknown: Lookup = () => undefined;

/**
 * The transactions the changes name, as they go: each one as it was (`lookup`) until a
 * change makes it something else, or deletes it (null)
 */
export function tracker(lookup: Lookup) {
  const touched = new Map<string, Transaction | null>();
  return {
    find: (id: string) => (touched.has(id) ? touched.get(id) ?? undefined : lookup(id)),
    set: (id: string, t: Transaction | null) => touched.set(id, t),
  };
}

/** A change made to a transaction: what it becomes, null once deleted; undefined if not one */
export function changedTransaction(
  change: LedgerChange,
  before: Transaction | undefined,
): Transaction | null | undefined {
  switch (change.op) {
    case 'addTransaction':
      // Already there (a fresh copy from the server that has it): left as it is
      return before ?? { ...change.transaction, createdAt: Date.now() };
    case 'updateTransaction': {
      if (before == null) return undefined;
      const { op: _op, id: _id, ...fields } = change;
      return { ...before, ...fields };
    }
    case 'removeTransaction':
      return before == null ? undefined : null;
    default:
      return undefined;
  }
}

export const isTransactionChange = (change: LedgerChange) =>
  change.op === 'addTransaction' ||
  change.op === 'updateTransaction' ||
  change.op === 'removeTransaction' ||
  change.op === 'recategoriseTransactions' ||
  change.op === 'removeTransactions' ||
  change.op === 'logRecurring';

/**
 * The changes, with each change to many transactions made into the same change to each
 * one in turn (moved to the category, or deleted), and each log of a repeating item into
 * the transaction it adds and the move to its next due date, so it's shown as the server
 * makes it
 */
export const oneByOne = (changes: LedgerChange[]): LedgerChange[] =>
  changes.flatMap((change): LedgerChange[] => {
    switch (change.op) {
      case 'recategoriseTransactions':
        return change.ids.map((id) => ({
          op: 'updateTransaction',
          id,
          categoryId: change.categoryId,
        }));
      case 'removeTransactions':
        return change.ids.map((id) => ({ op: 'removeTransaction', id }));
      case 'logRecurring':
        return [
          { op: 'addTransaction', transaction: change.transaction },
          { op: 'skipRecurring', id: change.id, due: change.due },
        ];
      default:
        return [change];
    }
  });

export const idOf = (change: LedgerChange) =>
  change.op === 'addTransaction' ? change.transaction.id : 'id' in change ? change.id : '';

/**
 * The ledger with `changes` made to it, in order; the one passed in is left as it was.
 * `lookup` gives each transaction as it is in this copy of the ledger, so its balance
 * moves by what changes: one not known moves no balance until the server's copy arrives.
 */
export function apply(ledger: Ledger, changes: LedgerChange[], lookup: Lookup = unknown): Ledger {
  const transactions = tracker(lookup);
  let next = ledger;
  for (const made of changes) {
    // A log this copy holds already (its item has moved on) is in its balance too
    if (made.op === 'logRecurring' && !stillDue(next, made.id, made.due)) continue;
    for (const change of oneByOne([made])) {
      if (!isTransactionChange(change)) {
        next = applyOne(next, change);
        continue;
      }
      const id = idOf(change);
      const before = transactions.find(id);
      // An addition already in this copy is in its balance too
      if (change.op === 'addTransaction' && before != null) continue;
      const after = changedTransaction(change, before);
      if (after === undefined) continue;
      transactions.set(id, after);
      next = {
        ...next,
        accounts: moveBalances(moveBalances(next.accounts, before, -1), after, 1),
      };
    }
  }
  return next;
}

/** Whether a repeating item is still due on `due` in this copy (or isn't known in it) */
function stillDue(ledger: Ledger, id: string, due: string) {
  const found = ledger.recurring?.find((r) => r.id === id);
  return found == null || found.nextDue === due;
}

/** The accounts with `t`'s effect on each (shared/ledger.ts) added (`by` 1) or taken back (-1) */
function moveBalances(accounts: Account[], t: Transaction | null | undefined, by: 1 | -1) {
  if (t == null) return accounts;
  return accounts.map((a) => {
    const effect = balanceEffect(t, a.id);
    return effect === 0 ? a : { ...a, balanceCents: a.balanceCents + by * effect };
  });
}

/** Newest first: by day, then when it was saved, then by id, as the server lists them */
export const newestFirst = (a: Transaction, b: Transaction) =>
  a.date !== b.date
    ? a.date < b.date
      ? 1
      : -1
    : a.createdAt !== b.createdAt
      ? b.createdAt - a.createdAt
      : a.id < b.id
        ? 1
        : a.id > b.id
          ? -1
          : 0;

/**
 * Pages of a list of transactions (one account's, or a month's: those `belongs` keeps)
 * with `changes` made to them, newest first. Each stays on the page whose place it falls
 * in, so loading the next page carries on where this one ends; one that falls past the
 * last page loaded is left for that page to bring. `lookup` gives a transaction this
 * list doesn't hold, for one moved into it.
 */
export function applyToPages(
  pages: TransactionPage[],
  changes: LedgerChange[],
  belongs: (t: Transaction) => boolean,
  lookup: Lookup = unknown,
): TransactionPage[] {
  const relevant = oneByOne(changes.filter(isTransactionChange));
  if (relevant.length === 0) return pages;
  // Where each page ends, when a next one carries on from it
  const ends = pages.map((p) => (p.nextBefore == null ? null : p.transactions.at(-1) ?? null));
  const held = new Map(pages.flatMap((p) => p.transactions).map((t) => [t.id, t]));
  const transactions = tracker((id) => held.get(id) ?? lookup(id));
  for (const change of relevant) {
    const id = idOf(change);
    const after = changedTransaction(change, transactions.find(id));
    if (after === undefined) continue;
    transactions.set(id, after);
    held.delete(id);
    if (after != null && belongs(after)) held.set(id, after);
  }
  const all = [...held.values()].sort(newestFirst);
  return pages.map((page, i) => ({
    ...page,
    transactions: all.filter((t) => {
      const newerEnd = i === 0 ? null : ends[i - 1];
      const end = ends[i];
      return (
        (newerEnd == null ? i === 0 : newestFirst(newerEnd, t) < 0) &&
        (end == null || newestFirst(t, end) <= 0)
      );
    }),
  }));
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
    case 'addRecurring':
    case 'updateRecurring':
    case 'archiveRecurring':
    case 'skipRecurring':
      return { ...ledger, recurring: applyToRecurring(ledger.recurring ?? [], change) };
    default:
      return ledger;
  }
}

/** Repeating items with a change made, the way the server makes it (shared/recurring.ts) */
function applyToRecurring(recurring: Recurring[], change: LedgerChange): Recurring[] {
  const changed = (id: string, to: (r: Recurring) => Recurring) =>
    recurring.map((r) => (r.id === id ? to(r) : r));
  switch (change.op) {
    case 'addRecurring': {
      const r = change.recurring;
      if (recurring.some((found) => found.id === r.id)) return recurring;
      // First due when the app said (the first after the person's today); a change from an
      // app from before says nothing, and the server works it out from the day set up from
      const nextDue = r.nextDue ?? nextAfter(r.schedule, r.day, r.startDate);
      return [...recurring, { ...r, nextDue, archived: false }];
    }
    case 'updateRecurring': {
      const { op: _op, id, ...fields } = change;
      return changed(id, (r) => ({ ...r, ...fields }));
    }
    case 'archiveRecurring':
      return changed(change.id, (r) => ({ ...r, archived: change.archived }));
    case 'skipRecurring':
      // Only from the occurrence it names, so a copy that moved on already stays as it is
      return changed(change.id, (r) =>
        r.nextDue === change.due ? { ...r, nextDue: nextAfter(r.schedule, r.day, r.nextDue) } : r,
      );
    default:
      return recurring;
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
