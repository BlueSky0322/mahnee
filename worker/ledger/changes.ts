// Saving the app's changes to a person's ledger. A batch is checked change by change,
// in order, against their accounts, categories and the transactions it names as they
// are now (with the batch's earlier changes), then saved all or nothing in one D1 batch. Every row read or written
// is the signed-in person's own: an id of someone else's is answered exactly like one
// that doesn't exist. A person's first change of any kind saves the default categories
// with it.

import {
  type Category,
  type ChangesBody,
  type LedgerChange,
  MAX_CHANGES,
  isRowId,
} from '../../shared/api';
import {
  DEFAULT_CATEGORIES,
  MAX_CATEGORIES,
  MAX_CATEGORY_NAME,
  MAX_SUBCATEGORIES,
  categoriesOrDefaults,
  isCategoryKind,
  nextPosition,
  readCategoryName,
  reorder,
  siblingsOf,
  whyNotUnder,
} from '../../shared/categories';
import type { TransactionKind } from '../../shared/ledger';
import {
  DEFAULT_CURRENCY,
  MAX_ACCOUNTS,
  MAX_BULK_TRANSACTIONS,
  MAX_ACCOUNT_NAME,
  MAX_NOTE,
  MAX_PAYEE,
  MAX_TRANSACTION,
  MAX_TRANSACTIONS_PER_ACCOUNT,
  fitsOpeningCents,
  fitsTransactionCents,
  isAccountKind,
  isDay,
  isTransactionKind,
  readAccountName,
  readOptionalText,
  whyNotBetween,
  whyNotInCategory,
  whyNotOnAccount,
} from '../../shared/ledger';
import { ensureProfileStatement } from '../accounts/profiles';
import { type Unchecked, fail, ok } from '../http';
import { listCategories } from './read';
import { changeFingerprint, receiptStatements, savedReceipts } from './receipts';

/** A change that can't be saved, with the status and reason the API answers with */
class Refused extends Error {
  constructor(
    public status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

const NAME_LENGTH = `Give the account a name of up to ${MAX_ACCOUNT_NAME} characters`;
const OPENING_RANGE = `An opening balance can be up to ${MAX_TRANSACTION.toLocaleString('en')} either way`;
const TOO_MANY = `You can have up to ${MAX_ACCOUNTS} accounts, archived ones included`;
const NOT_FOUND = 'Account not found';
const CATEGORY_NAME_LENGTH = `Give the category a name of up to ${MAX_CATEGORY_NAME} characters`;
const TOO_MANY_CATEGORIES = `You can have up to ${MAX_CATEGORIES} categories, archived ones included`;
const CATEGORY_NOT_FOUND = 'Category not found';
const TRANSACTION_NOT_FOUND = 'Transaction not found';
const AMOUNT_RANGE = `An amount is more than 0 and up to ${MAX_TRANSACTION.toLocaleString('en')}`;
const DAY_RANGE = 'Give a day from 2000 up to today';
const TOO_MANY_TRANSACTIONS = `An account can hold up to ${MAX_TRANSACTIONS_PER_ACCOUNT.toLocaleString('en')} transactions`;
const TRANSFER_CATEGORY = 'A transfer has no category';
const ONLY_TRANSFERS_GO = 'Only a transfer goes to another account';
const PICK_DESTINATION = 'Pick the account it goes to';
const TOO_MANY_AT_ONCE = `Change up to ${MAX_BULK_TRANSACTIONS} transactions at once`;

/** What a check needs to know of a saved transaction */
interface TransactionState {
  kind: TransactionKind;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
}

/**
 * What the batch knows of the person's ledger, as it goes: their accounts, their
 * categories (the defaults while none are saved), the transactions the batch names (by
 * id; one not here doesn't exist), and how many transactions the accounts it adds to hold
 */
interface Model {
  accounts: Map<string, { name: string; archived: boolean }>;
  categories: Category[];
  transactions: Map<string, TransactionState>;
  counts: Map<string, number>;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  v != null && typeof v === 'object' && !Array.isArray(v);

/** Refuses fields a change doesn't have, so a mistyped one is never silently ignored */
function onlyFields(value: Record<string, unknown>, fields: readonly string[]) {
  const extra = Object.keys(value).find((k) => !fields.includes(k));
  if (extra === 'kind') throw new Refused(400, "A kind can't be changed");
  if (extra != null) throw new Refused(400, `Unknown field ${extra}`);
}

const readName = (value: unknown) => {
  const name = readAccountName(value);
  if (name == null) throw new Refused(400, NAME_LENGTH);
  return name;
};

const readCategory = (model: Model, id: unknown) => {
  const found = isRowId(id) ? model.categories.find((c) => c.id === id) : undefined;
  if (found == null) throw new Refused(404, CATEGORY_NOT_FOUND);
  return found;
};

/** A parent as sent: null for the top level, or one of the person's categories */
const readParent = (model: Model, value: unknown): string | null =>
  value === null ? null : readCategory(model, value).id;

/** Refuses putting `category` under `parentId` unless shared/categories.ts allows it */
function checkUnder(
  model: Model,
  category: Pick<Category, 'id' | 'kind'>,
  parentId: string | null,
) {
  const reason = whyNotUnder(model.categories, category, parentId);
  if (reason != null) throw new Refused(409, reason);
}

/**
 * The position a category joining the siblings of kind ?2 under parent ?3 (person ?1)
 * takes: last. Worked out again as it's saved, against what's saved then; with the
 * parent full it's NULL, which NOT NULL refuses, undoing the whole batch, so two batches
 * at once can't go over the limit between them.
 */
const JOINING_POSITION = `CASE WHEN ?3 IS NULL OR
         (SELECT COUNT(*) FROM categories WHERE email = ?1 AND parent_id = ?3) < ${MAX_SUBCATEGORIES}
       THEN (SELECT COALESCE(MAX(position) + 1, 0) FROM categories
             WHERE email = ?1 AND kind = ?2 AND parent_id IS ?3) END`;

const readOpening = (value: unknown) => {
  if (!fitsOpeningCents(value)) throw new Refused(400, OPENING_RANGE);
  return value;
};

const readTransactionKind = (value: unknown) => {
  if (!isTransactionKind(value)) throw new Refused(400, 'Unknown kind of transaction');
  return value;
};

/** An account a transaction can go on: one of the person's, listed */
const readTransactionAccount = (model: Model, id: unknown) => {
  const account = isRowId(id) ? model.accounts.get(id) : undefined;
  if (account == null) throw new Refused(404, NOT_FOUND);
  const reason = whyNotOnAccount(account);
  if (reason != null) throw new Refused(409, reason);
  return id as string;
};

/**
 * The account a transaction of `kind` from `accountId` goes to: for a transfer, another
 * of the person's (checked as an account it can go on only when `given` is new, as the
 * account it's from is); for spending and income, none
 */
function readDestination(
  model: Model,
  kind: TransactionKind,
  accountId: string,
  to: unknown,
  given: boolean,
): string | null {
  if (kind !== 'transfer') {
    if (to != null) throw new Refused(400, ONLY_TRANSFERS_GO);
    return null;
  }
  if (to == null) throw new Refused(400, PICK_DESTINATION);
  const toAccountId = given ? readTransactionAccount(model, to) : (to as string);
  const reason = whyNotBetween(accountId, toAccountId);
  if (reason != null) throw new Refused(400, reason);
  return toAccountId;
}

/**
 * A category a transaction of `kind` can go in: one of the person's, listed, of its
 * kind; none for a transfer
 */
const readTransactionCategory = (model: Model, id: unknown, kind: TransactionKind) => {
  if (kind === 'transfer') {
    if (id != null) throw new Refused(400, TRANSFER_CATEGORY);
    return null;
  }
  if (id == null) throw new Refused(400, 'Pick a category');
  const category = readCategory(model, id);
  const reason = whyNotInCategory(category, kind);
  if (reason != null) throw new Refused(409, reason);
  return category.id;
};

const readAmount = (value: unknown) => {
  if (!fitsTransactionCents(value)) throw new Refused(400, AMOUNT_RANGE);
  return value;
};

const readDay = (value: unknown, now: number) => {
  if (!isDay(value, now)) throw new Refused(400, DAY_RANGE);
  return value;
};

const readText = (value: unknown, max: number, what: string) => {
  const text = readOptionalText(value, max);
  if (text === undefined) throw new Refused(400, `A ${what} can be up to ${max} characters`);
  return text;
};

/** Makes room for one more transaction on an account, or refuses when it's full */
function countOn(model: Model, accountId: string, by: 1 | -1) {
  const count = model.counts.get(accountId);
  if (count == null) return;
  if (by === 1 && count >= MAX_TRANSACTIONS_PER_ACCOUNT) {
    throw new Refused(409, TOO_MANY_TRANSACTIONS);
  }
  model.counts.set(accountId, count + by);
}

/** The accounts a transaction is on: the one it's from, and the one a transfer goes to */
const sidesOf = (t: Pick<TransactionState, 'accountId' | 'toAccountId'>) =>
  t.toAccountId == null ? [t.accountId] : [t.accountId, t.toAccountId];

/**
 * `accountId` (a parameter) for the account column, if each of `joining` (parameters:
 * accounts it's newly on) has room for one more transaction, of person ?1, either side
 * counted; else NULL. Worked out again as it's saved, against what's saved then: NULL is
 * refused by NOT NULL, undoing the whole batch, so two batches at once can't go over the
 * limit between them.
 */
const withRoom = (accountId: string, joining: string[]) =>
  joining.length === 0
    ? accountId
    : `CASE WHEN ${joining
        .map(
          (p) => `(SELECT COUNT(*) FROM transactions
                   WHERE email = ?1 AND (account_id = ${p} OR to_account_id = ${p}))
                  < ${MAX_TRANSACTIONS_PER_ACCOUNT}`,
        )
        .join(' AND ')} THEN ${accountId} END`;

/** One change's statements, after checking it against the model, which it then updates */
function changeStatements(
  db: D1Database,
  email: string,
  model: Model,
  raw: unknown,
  now: number,
): D1PreparedStatement[] {
  if (!isObject(raw)) throw new Refused(400, 'Invalid change');
  const change = raw as Unchecked<LedgerChange> & Record<string, unknown>;
  switch (change.op) {
    case 'addAccount': {
      onlyFields(change, ['op', 'account']);
      const account = change.account;
      if (!isObject(account)) throw new Refused(400, 'Invalid account');
      onlyFields(account, ['id', 'name', 'kind', 'openingCents']);
      if (!isRowId(account.id)) throw new Refused(400, 'Invalid account id');
      if (model.accounts.has(account.id)) throw new Refused(409, 'That account already exists');
      const name = readName(account.name);
      if (!isAccountKind(account.kind)) throw new Refused(400, 'Unknown kind of account');
      const opening = readOpening(account.openingCents);
      if (model.accounts.size >= MAX_ACCOUNTS) throw new Refused(409, TOO_MANY);
      model.accounts.set(account.id, { name, archived: false });
      // A new account has no transactions
      model.counts.set(account.id, 0);
      // Last in the list. The count is checked again as it's saved: past the limit the
      // position is NULL, which NOT NULL refuses, undoing the whole batch, so two
      // batches at once can't go over it between them.
      return [
        db
          .prepare(
            `INSERT INTO accounts (email, id, name, kind, currency, opening_cents, position,
                                   archived, created_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6,
                    CASE WHEN COUNT(*) < ?7 THEN COALESCE(MAX(position) + 1, 0) END,
                    0, ?8, ?8
             FROM accounts WHERE email = ?1`,
          )
          .bind(
            email,
            account.id,
            name,
            account.kind,
            DEFAULT_CURRENCY,
            opening,
            MAX_ACCOUNTS,
            now,
          ),
      ];
    }
    case 'updateAccount': {
      onlyFields(change, ['op', 'id', 'name', 'openingCents']);
      const account = isRowId(change.id) ? model.accounts.get(change.id) : undefined;
      if (account == null) throw new Refused(404, NOT_FOUND);
      const sets: string[] = [];
      const values: (string | number)[] = [];
      if ('name' in change) {
        account.name = readName(change.name);
        sets.push('name = ?');
        values.push(account.name);
      }
      if ('openingCents' in change) {
        sets.push('opening_cents = ?');
        values.push(readOpening(change.openingCents));
      }
      if (sets.length === 0) throw new Refused(400, 'Nothing to change');
      return [
        db
          .prepare(
            `UPDATE accounts SET ${sets.join(', ')}, updated_at = ? WHERE email = ? AND id = ?`,
          )
          .bind(...values, now, email, change.id),
      ];
    }
    case 'archiveAccount': {
      onlyFields(change, ['op', 'id', 'archived']);
      const account = isRowId(change.id) ? model.accounts.get(change.id) : undefined;
      if (account == null) throw new Refused(404, NOT_FOUND);
      if (typeof change.archived !== 'boolean')
        throw new Refused(400, 'Say whether it is archived');
      account.archived = change.archived;
      return [
        db
          .prepare('UPDATE accounts SET archived = ?, updated_at = ? WHERE email = ? AND id = ?')
          .bind(change.archived ? 1 : 0, now, email, change.id),
      ];
    }
    case 'addCategory': {
      onlyFields(change, ['op', 'category']);
      const category = change.category;
      if (!isObject(category)) throw new Refused(400, 'Invalid category');
      onlyFields(category, ['id', 'name', 'kind', 'parentId']);
      if (!isRowId(category.id)) throw new Refused(400, 'Invalid category id');
      if (model.categories.some((c) => c.id === category.id)) {
        throw new Refused(409, 'That category already exists');
      }
      const name = readCategoryName(category.name);
      if (name == null) throw new Refused(400, CATEGORY_NAME_LENGTH);
      if (!isCategoryKind(category.kind)) throw new Refused(400, 'Unknown kind of category');
      const kind = category.kind;
      if (!('parentId' in category)) throw new Refused(400, 'Say what it goes under');
      const parentId = readParent(model, category.parentId);
      checkUnder(model, { id: category.id, kind }, parentId);
      if (model.categories.length >= MAX_CATEGORIES) throw new Refused(409, TOO_MANY_CATEGORIES);
      model.categories.push({
        id: category.id,
        name,
        kind,
        parentId,
        position: nextPosition(siblingsOf(model.categories, kind, parentId)),
        archived: false,
      });
      // As with a parent's limit, the person's is checked again as it's saved
      return [
        db
          .prepare(
            `INSERT INTO categories (email, id, name, kind, parent_id, position, archived,
                                     created_at, updated_at)
             SELECT ?1, ?4, ?5, ?2, ?3,
                    CASE WHEN (SELECT COUNT(*) FROM categories WHERE email = ?1) < ${MAX_CATEGORIES}
                         THEN ${JOINING_POSITION} END,
                    0, ?6, ?6`,
          )
          .bind(email, kind, parentId, category.id, name, now),
      ];
    }
    case 'updateCategory': {
      onlyFields(change, ['op', 'id', 'name', 'parentId', 'position']);
      const category = readCategory(model, change.id);
      const statements: D1PreparedStatement[] = [];
      if (!('name' in change || 'parentId' in change || 'position' in change)) {
        throw new Refused(400, 'Nothing to change');
      }
      if ('name' in change) {
        const name = readCategoryName(change.name);
        if (name == null) throw new Refused(400, CATEGORY_NAME_LENGTH);
        category.name = name;
        statements.push(
          db
            .prepare('UPDATE categories SET name = ?, updated_at = ? WHERE email = ? AND id = ?')
            .bind(name, now, email, category.id),
        );
      }
      if ('parentId' in change) {
        const parentId = readParent(model, change.parentId);
        if (parentId !== category.parentId) {
          checkUnder(model, category, parentId);
          category.position = nextPosition(siblingsOf(model.categories, category.kind, parentId));
          category.parentId = parentId;
          statements.push(
            db
              .prepare(
                `UPDATE categories SET parent_id = ?3, position = ${JOINING_POSITION},
                                       updated_at = ?4
                 WHERE email = ?1 AND id = ?5`,
              )
              .bind(email, category.kind, parentId, now, category.id),
          );
        }
      }
      if ('position' in change) {
        const index = change.position;
        if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0) {
          throw new Refused(400, 'Give a place from 0');
        }
        const siblings = siblingsOf(model.categories, category.kind, category.parentId);
        const order = reorder(siblings, category.id, index);
        for (const sibling of siblings) sibling.position = order.indexOf(sibling.id);
        // The siblings numbered afresh from 0, in their new order
        statements.push(
          db
            .prepare(
              `UPDATE categories
               SET position = (SELECT CAST(j.key AS INTEGER) FROM json_each(?2) j
                               WHERE j.value = categories.id)
               WHERE email = ?1 AND id IN (SELECT value FROM json_each(?2))`,
            )
            .bind(email, JSON.stringify(order)),
          db
            .prepare('UPDATE categories SET updated_at = ? WHERE email = ? AND id = ?')
            .bind(now, email, category.id),
        );
      }
      return statements;
    }
    case 'archiveCategory': {
      onlyFields(change, ['op', 'id', 'archived']);
      const category = readCategory(model, change.id);
      if (typeof change.archived !== 'boolean') {
        throw new Refused(400, 'Say whether it is archived');
      }
      category.archived = change.archived;
      return [
        db
          .prepare('UPDATE categories SET archived = ?, updated_at = ? WHERE email = ? AND id = ?')
          .bind(change.archived ? 1 : 0, now, email, category.id),
      ];
    }
    case 'addTransaction': {
      onlyFields(change, ['op', 'transaction']);
      const t = change.transaction;
      if (!isObject(t)) throw new Refused(400, 'Invalid transaction');
      onlyFields(t, [
        'id',
        'kind',
        'accountId',
        'toAccountId',
        'amountCents',
        'categoryId',
        'payee',
        'note',
        'date',
      ]);
      if (!isRowId(t.id)) throw new Refused(400, 'Invalid transaction id');
      if (model.transactions.has(t.id)) throw new Refused(409, 'That transaction already exists');
      const kind = readTransactionKind(t.kind);
      const accountId = readTransactionAccount(model, t.accountId);
      const toAccountId = readDestination(model, kind, accountId, t.toAccountId, true);
      const amount = readAmount(t.amountCents);
      const categoryId = readTransactionCategory(model, t.categoryId, kind);
      const payee = readText(t.payee, MAX_PAYEE, 'payee');
      const note = readText(t.note, MAX_NOTE, 'note');
      const date = readDay(t.date, now);
      const saved = { kind, accountId, toAccountId, categoryId };
      for (const side of sidesOf(saved)) countOn(model, side, 1);
      model.transactions.set(t.id, saved);
      // ?1 the person, ?2 the account it's from, ?3 the one it goes to
      const sides = toAccountId == null ? ['?2'] : ['?2', '?3'];
      return [
        db
          .prepare(
            `INSERT INTO transactions (email, id, kind, account_id, to_account_id, amount_cents,
                                       category_id, payee, note, date, created_at, updated_at)
             SELECT ?1, ?4, ?5, ${withRoom('?2', sides)}, ?3, ?6, ?7, ?8, ?9, ?10, ?11, ?11`,
          )
          .bind(
            email,
            accountId,
            toAccountId,
            t.id,
            kind,
            amount,
            categoryId,
            payee,
            note,
            date,
            now,
          ),
      ];
    }
    case 'updateTransaction': {
      onlyFields(change, [
        'op',
        'id',
        'kind',
        'accountId',
        'toAccountId',
        'amountCents',
        'categoryId',
        'payee',
        'note',
        'date',
      ]);
      const saved = isRowId(change.id) ? model.transactions.get(change.id) : undefined;
      if (saved == null) throw new Refused(404, TRANSACTION_NOT_FOUND);
      const fields = Object.keys(change).filter((k) => k !== 'op' && k !== 'id');
      if (fields.length === 0) throw new Refused(400, 'Nothing to change');
      // ?1 is the person
      const values: (string | number | null)[] = [email];
      const param = (value: string | number | null) => `?${values.push(value)}`;
      const sets: string[] = [];
      const set = (column: string, value: string | number | null) =>
        sets.push(`${column} = ${param(value)}`);
      const kind = 'kind' in change ? readTransactionKind(change.kind) : saved.kind;
      const accountId =
        'accountId' in change ? readTransactionAccount(model, change.accountId) : saved.accountId;
      // Where it goes, whenever the kind or either account changes
      let toAccountId = saved.toAccountId;
      if ('kind' in change || 'accountId' in change || 'toAccountId' in change) {
        const given = 'toAccountId' in change;
        toAccountId = readDestination(
          model,
          kind,
          accountId,
          given ? change.toAccountId : saved.toAccountId,
          given,
        );
      }
      // The kind and category go together: whichever changes, they're checked as a pair
      if ('kind' in change || 'categoryId' in change) {
        const categoryId = readTransactionCategory(
          model,
          'categoryId' in change ? change.categoryId : saved.categoryId,
          kind,
        );
        set('kind', kind);
        set('category_id', categoryId);
        saved.kind = kind;
        saved.categoryId = categoryId;
      }
      // Accounts it's newly on need room for it; ones it leaves have one fewer
      const before = sidesOf(saved);
      const after = sidesOf({ accountId, toAccountId });
      const joining = after.filter((a) => !before.includes(a));
      for (const side of joining) countOn(model, side, 1);
      for (const side of before.filter((a) => !after.includes(a))) countOn(model, side, -1);
      if (accountId !== saved.accountId || joining.length > 0) {
        sets.push(`account_id = ${withRoom(param(accountId), joining.map(param))}`);
      }
      if (toAccountId !== saved.toAccountId) set('to_account_id', toAccountId);
      saved.accountId = accountId;
      saved.toAccountId = toAccountId;
      if ('amountCents' in change) set('amount_cents', readAmount(change.amountCents));
      if ('payee' in change) set('payee', readText(change.payee, MAX_PAYEE, 'payee'));
      if ('note' in change) set('note', readText(change.note, MAX_NOTE, 'note'));
      if ('date' in change) set('date', readDay(change.date, now));
      set('updated_at', now);
      return [
        db
          .prepare(
            `UPDATE transactions SET ${sets.join(', ')}
             WHERE email = ?1 AND id = ${param(change.id as string)}`,
          )
          .bind(...values),
      ];
    }
    case 'removeTransaction': {
      onlyFields(change, ['op', 'id']);
      const saved = isRowId(change.id) ? model.transactions.get(change.id) : undefined;
      if (saved == null) throw new Refused(404, TRANSACTION_NOT_FOUND);
      model.transactions.delete(change.id as string);
      for (const side of sidesOf(saved)) countOn(model, side, -1);
      return [
        db.prepare('DELETE FROM transactions WHERE email = ? AND id = ?').bind(email, change.id),
      ];
    }
    case 'recategoriseTransactions': {
      onlyFields(change, ['op', 'ids', 'categoryId']);
      const named = readBulk(model, change.ids);
      const category = readCategory(model, change.categoryId);
      for (const saved of named) {
        if (saved.kind === 'transfer') throw new Refused(400, TRANSFER_CATEGORY);
        const reason = whyNotInCategory(category, saved.kind);
        if (reason != null) throw new Refused(409, reason);
      }
      for (const saved of named) saved.categoryId = category.id;
      return [
        db
          .prepare(
            `UPDATE transactions SET category_id = ?, updated_at = ?
             WHERE email = ? AND id IN (SELECT value FROM json_each(?))`,
          )
          .bind(category.id, now, email, JSON.stringify(change.ids)),
      ];
    }
    case 'removeTransactions': {
      onlyFields(change, ['op', 'ids']);
      const named = readBulk(model, change.ids);
      (change.ids as string[]).forEach((id) => model.transactions.delete(id));
      for (const saved of named) for (const side of sidesOf(saved)) countOn(model, side, -1);
      return [
        db
          .prepare(
            'DELETE FROM transactions WHERE email = ? AND id IN (SELECT value FROM json_each(?))',
          )
          .bind(email, JSON.stringify(change.ids)),
      ];
    }
    default:
      throw new Refused(400, 'Unknown change');
  }
}

/**
 * The transactions a change to many names (`ids`): a list of 1 to MAX_BULK_TRANSACTIONS,
 * each once, every one the person's
 */
function readBulk(model: Model, ids: unknown): TransactionState[] {
  if (!Array.isArray(ids)) throw new Refused(400, 'Name the transactions as a list of ids');
  if (ids.length === 0) throw new Refused(400, 'Name at least one transaction');
  if (ids.length > MAX_BULK_TRANSACTIONS) throw new Refused(400, TOO_MANY_AT_ONCE);
  if (new Set(ids).size !== ids.length) throw new Refused(400, 'Name each transaction once');
  return ids.map((id: unknown) => {
    const saved = isRowId(id) ? model.transactions.get(id) : undefined;
    if (saved == null) throw new Refused(404, TRANSACTION_NOT_FOUND);
    return saved;
  });
}

/**
 * Saves the default categories for a person who has none saved; for anyone who has, it
 * does nothing, so a batch saved at the same time can't save them twice
 */
function defaultCategoriesStatement(db: D1Database, email: string, now: number) {
  return db
    .prepare(
      `INSERT INTO categories (email, id, name, kind, parent_id, position, archived,
                               created_at, updated_at)
       SELECT ?1, json_extract(d.value, '$.id'), json_extract(d.value, '$.name'),
              json_extract(d.value, '$.kind'), NULL, json_extract(d.value, '$.position'),
              0, ?3, ?3
       FROM json_each(?2) d
       WHERE NOT EXISTS (SELECT 1 FROM categories WHERE email = ?1)`,
    )
    .bind(email, JSON.stringify(DEFAULT_CATEGORIES), now);
}

/** Whether D1 refused a write for breaking a constraint */
const isConstraintError = (err: unknown) => String(err).includes('CONSTRAINT');

/** POST /api/changes: saves a batch all or nothing, answering Ok or why it was refused */
export async function applyChanges(db: D1Database, email: string, body: Unchecked<ChangesBody>) {
  const { changes, ids } = body;
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > MAX_CHANGES) {
    return fail(`Send 1-${MAX_CHANGES} changes`, 400);
  }
  if (
    !Array.isArray(ids) ||
    ids.length !== changes.length ||
    !ids.every(isRowId) ||
    new Set(ids).size !== ids.length
  ) {
    return fail('Send one id of its own for each change', 400);
  }
  const changeIds = ids;

  // Changes saved before, their answer lost: counted once, and not applied again
  const prints = await Promise.all(changes.map((c: unknown) => changeFingerprint(c)));
  const saved = await savedReceipts(db, email, changeIds);
  const fresh: number[] = [];
  for (let i = 0; i < changes.length; i++) {
    const before = saved.get(changeIds[i]);
    if (before == null) fresh.push(i);
    else if (before !== prints[i]) return fail('That change was saved differently before', 409);
  }
  if (fresh.length === 0) return ok();

  // The transactions the batch names, and how many each account it adds to holds
  const named = new Set<string>();
  const addingTo = new Set<string>();
  for (const i of fresh) {
    const change: unknown = changes[i];
    if (!isObject(change)) continue;
    const t = change.op === 'addTransaction' ? change.transaction : change;
    if (!isObject(t)) continue;
    if (isRowId(t.id) && String(change.op).endsWith('Transaction')) named.add(t.id);
    // A change to many names them all (refused past the limit, so not read past it)
    if (
      String(change.op).endsWith('Transactions') &&
      Array.isArray(change.ids) &&
      change.ids.length <= MAX_BULK_TRANSACTIONS
    ) {
      for (const id of change.ids) if (isRowId(id)) named.add(id);
    }
    if (isRowId(t.accountId)) addingTo.add(t.accountId);
    if (isRowId(t.toAccountId)) addingTo.add(t.toAccountId);
  }
  const [accounts, savedCategories, transactions, counts] = await Promise.all([
    db
      .prepare('SELECT id, name, archived FROM accounts WHERE email = ?')
      .bind(email)
      .all<{ id: string; name: string; archived: 0 | 1 }>(),
    listCategories(db, email),
    named.size === 0
      ? { results: [] }
      : db
          .prepare(
            `SELECT id, kind, account_id AS accountId, to_account_id AS toAccountId,
                    category_id AS categoryId
             FROM transactions
             WHERE email = ? AND id IN (SELECT value FROM json_each(?))`,
          )
          .bind(email, JSON.stringify([...named]))
          .all<TransactionState & { id: string }>(),
    addingTo.size === 0
      ? { results: [] }
      : db
          .prepare(
            `SELECT a.value AS id,
                    (SELECT COUNT(*) FROM transactions
                     WHERE email = ?1
                       AND (account_id = a.value OR to_account_id = a.value)) AS count
             FROM json_each(?2) a`,
          )
          .bind(email, JSON.stringify([...addingTo]))
          .all<{ id: string; count: number }>(),
  ]);
  const model: Model = {
    accounts: new Map(
      accounts.results.map((r) => [r.id, { name: r.name, archived: r.archived === 1 }]),
    ),
    categories: categoriesOrDefaults(savedCategories),
    transactions: new Map(transactions.results.map(({ id, ...t }) => [id, t])),
    counts: new Map(counts.results.map((r) => [r.id, r.count])),
  };
  const now = Date.now();
  // None saved yet: the defaults are saved first, so the changes after can name them
  const statements: D1PreparedStatement[] =
    savedCategories.length === 0 ? [defaultCategoriesStatement(db, email, now)] : [];
  for (const i of fresh) {
    try {
      statements.push(...changeStatements(db, email, model, changes[i], now));
    } catch (err) {
      if (err instanceof Refused) return fail(err.message, err.status);
      throw err;
    }
  }

  try {
    await db.batch([
      ensureProfileStatement(db, email),
      ...statements,
      ...receiptStatements(
        db,
        email,
        fresh.map((i) => ({ id: changeIds[i], fingerprint: prints[i] })),
        now,
      ),
    ]);
  } catch (err) {
    if (!isConstraintError(err)) throw err;
    // The same changes sent twice at once: the other request saved them
    const now = await savedReceipts(db, email, changeIds);
    if (fresh.every((i) => now.get(changeIds[i]) === prints[i])) return ok();
    // Another batch landed between reading and saving: an account, category or
    // transaction added with the same id, the last one a limit allows, or a move that
    // would go two deep
    return fail('Changed somewhere else at the same time. Try again.', 409);
  }
  return ok();
}
