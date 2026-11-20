import type { Account, Category, LedgerChange, Transaction } from '@shared/api';
import { dayText } from '../../utils/date-input';
import { formatMoney } from '../../utils/money';

// A change in a few plain words, for the list of changes the server couldn't save: what
// the person did, named as they'd know it ("Rename "Wallet" to "Purse"",
// "Spent RM 12.00 at Grab on 3 Jan 2026").

/** "1 change couldn't be saved.", "3 changes couldn't be saved." */
export const refusedText = (count: number) =>
  `${count} ${count === 1 ? 'change' : 'changes'} couldn't be saved.`;

export interface Names {
  accounts: Account[] | null;
  categories: Category[] | null;
}

const quoted = (name: string | undefined, fallback: string) =>
  name == null ? fallback : `"${name}"`;

const KIND_WORD: Record<Transaction['kind'], string> = {
  expense: 'Spent',
  income: 'Received',
  transfer: 'Transfer of',
};

/** An entry: what kind, how much (in the currency it was typed in), who, and when */
function entryText(
  t: Pick<Transaction, 'kind' | 'amountCents' | 'payee' | 'date'>,
  currency: string,
) {
  const who = t.payee ? (t.kind === 'income' ? ` from ${t.payee}` : ` at ${t.payee}`) : '';
  return `${KIND_WORD[t.kind]} ${formatMoney(t.amountCents, currency)}${who} on ${dayText(t.date)}`;
}

const entries = (n: number) => (n === 1 ? '1 entry' : `${n} entries`);

export function describeChange(
  change: LedgerChange,
  currency: string,
  { accounts, categories }: Names,
) {
  const account = (id: string) => quoted(accounts?.find((a) => a.id === id)?.name, 'an account');
  const category = (id: string) => quoted(categories?.find((c) => c.id === id)?.name, 'a category');
  switch (change.op) {
    case 'addAccount':
      return `New account "${change.account.name}"`;
    case 'updateAccount':
      return change.name != null && change.kind == null && change.openingCents == null
        ? `Rename ${account(change.id)} to "${change.name}"`
        : `Change ${account(change.id)}`;
    case 'archiveAccount':
      return `${change.archived ? 'Archive' : 'Unarchive'} ${account(change.id)}`;
    case 'addCategory':
      return `New category "${change.category.name}"`;
    case 'updateCategory':
      return change.name != null
        ? `Rename ${category(change.id)} to "${change.name}"`
        : `Move ${category(change.id)}`;
    case 'archiveCategory':
      return `${change.archived ? 'Archive' : 'Unarchive'} ${category(change.id)}`;
    case 'addTransaction':
    case 'logRecurring':
      return entryText(change.transaction, currency);
    case 'updateTransaction':
      return 'Edit an entry';
    case 'removeTransaction':
      return 'Delete an entry';
    case 'recategoriseTransactions':
      return `Move ${entries(change.ids.length)} to ${category(change.categoryId)}`;
    case 'removeTransactions':
      return `Delete ${entries(change.ids.length)}`;
    case 'setBudget':
      return `Budget for ${category(change.categoryId)}`;
    case 'addRecurring':
      return 'New scheduled item';
    case 'updateRecurring':
      return 'Change a scheduled item';
    case 'archiveRecurring':
      return change.archived ? 'Stop a scheduled item' : 'Restart a scheduled item';
    case 'skipRecurring':
      return 'Skip a scheduled item';
    case 'addImport':
      return `Import "${change.import.fileName}"`;
    case 'undoImport':
      return 'Undo an import';
  }
}

/**
 * Said beside the held rest of an import whose first rows the server saved already (a
 * large one, sent in parts): discarding it leaves those rows in, and the opening balance
 * change that comes last goes with the rest, so Undo import is the way to take it all back.
 * Null for any other set, an import held whole included.
 */
export function partImportText(changes: LedgerChange[]): string | null {
  const recorded = new Set(changes.flatMap((c) => (c.op === 'addImport' ? [c.import.id] : [])));
  const ofImport = (c: LedgerChange) =>
    (c.op === 'addTransaction' || c.op === 'updateAccount') &&
    c.importId != null &&
    !recorded.has(c.importId);
  if (!changes.some(ofImport)) return null;
  const opening = changes.some((c) => c.op === 'updateAccount' && ofImport(c));
  return `Part of this import is saved already. Discarding leaves that part in${
    opening ? ', without its opening balance change' : ''
  }. To take the whole import back, use Undo import in Settings › Import and export.`;
}
