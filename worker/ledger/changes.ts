// Saving the app's changes to a person's ledger. A batch is checked change by change,
// in order, against their accounts, categories and the transactions it names as they
// are now (with the batch's earlier changes), then saved all or nothing in one D1 batch. Every row read or written
// is the signed-in person's own: an id of someone else's is answered exactly like one
// that doesn't exist. A person's first change of any kind saves the default categories
// with it. Repeating items are checked the same way, and logging one saves its
// transaction (marked as from Scheduled) and moves it on to its next due date together. The
// nightly job (post-scheduled.ts) adds each item on its day through the same path. An item
// saved, moved back or brought back (or its account or category brought back) with its next
// due date on or before the person's own today asks first (Log it or Skip on Home; owner
// decision D19), and stops asking once logged or skipped past today. An import is recorded before the transactions that name
// it, and undoing one deletes exactly those, in one batch.

import {
  type Category,
  type ChangesBody,
  type LedgerChange,
  MAX_CHANGES,
  MAX_FILE_NAME,
  isRowId,
} from '../../shared/api';
import { MAX_IMPORT_ROWS } from '../../shared/csv-import';
import { isTimeOfDay } from '../../shared/settings';
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
import type { Schedule } from '../../shared/recurring';
import {
  MAX_RECURRING,
  fallsOn,
  isCalendarDay,
  isSchedule,
  isScheduleDay,
  latestDue,
  nextAfter,
  scheduleDayRange,
} from '../../shared/recurring';
import { dayIn } from '../../shared/scheduled';
import {
  FIRST_DAY,
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
import { BUDGET_RANGE, fitsBudgetCents, isBudgetMonth, whyNoBudget } from '../../shared/budgets';
import { ensureProfileStatement } from '../accounts/profiles';
import { type Unchecked, fail, ok } from '../http';
import { listCategories } from './read';
import { readMonthStart } from './month-start';
import { changeFingerprint, receiptStatements, savedReceipts } from './receipts';
import { DEFAULT_SETTINGS } from '../../shared/api';
import { isEntryCurrency } from '../../shared/rates';
import type { Rate } from '../currency/exchange-rates';
import { RatesUnavailable } from '../currency/exchange-rates';
import { type Typed, TypedTooLarge, typedIn, typedStatements } from '../currency/typed-in';

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
const RECURRING_NOT_FOUND = 'Repeating item not found';
const TOO_MANY_RECURRING = `You can have up to ${MAX_RECURRING} repeating items, stopped ones included`;
const NOT_NEXT = 'That was logged or skipped already';
const STOPPED = 'That no longer repeats';
const OFF_SCHEDULE = 'Next due has to fall on its schedule';
const LOGGED_ON_DUE = 'A repeating item is logged on the day it was due';
const IMPORT_NOT_FOUND = 'Import not found';
const FILE_NAME_LENGTH = `Give the file a name of up to ${MAX_FILE_NAME} characters`;
const SAY_VARIES = 'Say whether the amount changes';
const ONLY_CHECKED = 'An amount is checked, never unchecked';
const IMPORT_COUNT = `A count is a whole number from 0 to ${MAX_IMPORT_ROWS.toLocaleString('en')}`;

/** What a check needs to know of a saved transaction */
interface TransactionState {
  kind: TransactionKind;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
}

/** What a check needs to know of a saved repeating item */
interface RecurringState {
  kind: TransactionKind;
  accountId: string;
  toAccountId: string | null;
  categoryId: string | null;
  schedule: Schedule;
  day: number;
  nextDue: string;
  archived: boolean;
  amountVaries: boolean;
}

/**
 * What the batch knows of the person's ledger, as it goes: their accounts, their
 * categories (the defaults while none are saved), the transactions the batch names (by
 * id; one not here doesn't exist), how many transactions the accounts it adds to hold, and
 * their repeating items (read only when the batch changes one)
 */
interface Model {
  accounts: Map<string, { name: string; archived: boolean }>;
  categories: Category[];
  transactions: Map<string, TransactionState>;
  counts: Map<string, number>;
  recurring: Map<string, RecurringState>;
  /** The imports the batch names, and whether each was undone (one not here doesn't exist) */
  imports: Map<string, { undone: boolean }>;
  /** The day the person's month starts on (read only when the batch sets a budget) */
  monthStart: number;
  /**
   * The person's own today, in their stored time zone (UTC's without one): what decides
   * whether a repeating item asks first
   */
  today: string;
  /** Saved by the nightly job: what it adds is marked to check when the amount changes */
  posting: boolean;
  /** The person's home currency: a new account's */
  currency: string;
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

/** A time of day on the person's clock (08:12), or none: null */
const readTime = (value: unknown) => {
  if (value === null) return null;
  if (!isTimeOfDay(value)) throw new Refused(400, 'Invalid time');
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
          .bind(email, account.id, name, account.kind, model.currency, opening, MAX_ACCOUNTS, now),
      ];
    }
    case 'updateAccount': {
      onlyFields(change, ['op', 'id', 'name', 'kind', 'openingCents']);
      const account = isRowId(change.id) ? model.accounts.get(change.id) : undefined;
      if (account == null) throw new Refused(404, NOT_FOUND);
      const sets: string[] = [];
      const values: (string | number)[] = [];
      if ('name' in change) {
        account.name = readName(change.name);
        sets.push('name = ?');
        values.push(account.name);
      }
      // A new kind keeps the opening balance's cents as they were, unless it comes with one
      if ('kind' in change) {
        if (!isAccountKind(change.kind)) throw new Refused(400, 'Unknown kind of account');
        sets.push('kind = ?');
        values.push(change.kind);
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
          // Archived now: the day it happened. Already archived: its day stays as it was, none
          // for one archived before the day was kept. Brought back: none.
          .prepare(
            `UPDATE accounts
             SET archived = ?1,
                 archived_at = CASE WHEN ?1 = 0 THEN NULL
                                    WHEN archived = 0 THEN ?2
                                    ELSE archived_at END,
                 updated_at = ?2
             WHERE email = ?3 AND id = ?4`,
          )
          .bind(change.archived ? 1 : 0, now, email, change.id),
        // Brought back after its items' days passed: nothing is guessed, they ask first
        ...(change.archived
          ? []
          : [
              db
                .prepare(
                  `UPDATE recurring SET ask_first = 1, updated_at = ?
                   WHERE email = ? AND archived = 0 AND next_due <= ?
                     AND (account_id = ? OR to_account_id = ?)`,
                )
                .bind(now, email, model.today, change.id, change.id),
            ]),
        // Add no longer starts on an archived account, but on the last one used
        ...(change.archived
          ? [
              db
                .prepare(
                  `UPDATE user_settings SET default_account_id = NULL, updated_at = ?
                   WHERE email = ? AND default_account_id = ?`,
                )
                .bind(now, email, change.id),
            ]
          : []),
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
        // Brought back after its items' days passed: nothing is guessed, they ask first
        ...(change.archived
          ? []
          : [
              db
                .prepare(
                  `UPDATE recurring SET ask_first = 1, updated_at = ?
                   WHERE email = ? AND archived = 0 AND next_due <= ? AND category_id = ?`,
                )
                .bind(now, email, model.today, category.id),
            ]),
      ];
    }
    case 'addTransaction': {
      onlyFields(change, ['op', 'transaction', 'importId']);
      const importId = 'importId' in change ? readImport(model, change.importId) : null;
      const t = change.transaction;
      if (!isObject(t)) throw new Refused(400, 'Invalid transaction');
      // Brought back from Scheduled (Undo of a delete): still from its own item
      const mark = 'scheduled' in t ? readMark(model, t.scheduled) : null;
      return addTransaction(db, email, model, t, now, importId, mark);
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
        'time',
        'toCheck',
      ]);
      const saved = isRowId(change.id) ? model.transactions.get(change.id) : undefined;
      if (saved == null) throw new Refused(404, TRANSACTION_NOT_FOUND);
      if ('toCheck' in change && change.toCheck !== false) throw new Refused(400, ONLY_CHECKED);
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
      if ('time' in change) set('time', readTime(change.time));
      // Confirmed, or given what the bill came to: nothing left to check
      if ('toCheck' in change || 'amountCents' in change) set('to_check', 0);
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
    case 'addImport': {
      onlyFields(change, ['op', 'import']);
      const record = change.import;
      if (!isObject(record)) throw new Refused(400, 'Invalid import');
      onlyFields(record, ['id', 'fileName', 'accountId', 'addedCount', 'skippedCount']);
      if (!isRowId(record.id)) throw new Refused(400, 'Invalid import id');
      if (model.imports.has(record.id)) throw new Refused(409, 'That import is already recorded');
      const fileName = typeof record.fileName === 'string' ? record.fileName.trim() : '';
      if (fileName.length < 1 || fileName.length > MAX_FILE_NAME) {
        throw new Refused(400, FILE_NAME_LENGTH);
      }
      const accountId = record.accountId ?? null;
      if (accountId != null && !(isRowId(accountId) && model.accounts.has(accountId))) {
        throw new Refused(404, NOT_FOUND);
      }
      const added = readImportCount(record.addedCount);
      const skipped = readImportCount(record.skippedCount);
      model.imports.set(record.id, { undone: false });
      return [
        db
          .prepare(
            `INSERT INTO imports (email, id, file_name, account_id, added_count, skipped_count,
                                  created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(email, record.id, fileName, accountId, added, skipped, now),
      ];
    }
    case 'undoImport': {
      onlyFields(change, ['op', 'id']);
      const record = isRowId(change.id) ? model.imports.get(change.id) : undefined;
      if (record == null) throw new Refused(404, IMPORT_NOT_FOUND);
      // Undone already, on another device or by this change sent again: nothing more goes
      if (record.undone) return [];
      record.undone = true;
      return [
        db
          .prepare('DELETE FROM transactions WHERE email = ? AND import_id = ?')
          .bind(email, change.id),
        db
          .prepare('UPDATE imports SET undone_at = ? WHERE email = ? AND id = ?')
          .bind(now, email, change.id),
      ];
    }
    case 'setBudget': {
      onlyFields(change, ['op', 'categoryId', 'fromMonth', 'amountCents', 'carryOver']);
      const category = readCategory(model, change.categoryId);
      const reason = whyNoBudget(category);
      if (reason != null) throw new Refused(409, reason);
      if (!isBudgetMonth(change.fromMonth, now, model.monthStart)) {
        throw new Refused(400, 'Give a month from 2000 up to this one');
      }
      const amount = change.amountCents;
      if (amount !== null && !fitsBudgetCents(amount)) throw new Refused(400, BUDGET_RANGE);
      if (typeof change.carryOver !== 'boolean') {
        throw new Refused(400, 'Say whether it carries over');
      }
      // Taking one away from an archived category is fine; setting one isn't
      if (amount !== null && category.archived) {
        throw new Refused(409, `${category.name} is archived`);
      }
      // From this month on: what was set for later months goes
      return [
        db
          .prepare('DELETE FROM budgets WHERE email = ? AND category_id = ? AND from_month > ?')
          .bind(email, category.id, change.fromMonth),
        db
          .prepare(
            `INSERT INTO budgets (email, category_id, from_month, amount_cents, carry_over,
                                  updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT (email, category_id, from_month)
             DO UPDATE SET amount_cents = ?4, carry_over = ?5, updated_at = ?6`,
          )
          .bind(
            email,
            category.id,
            change.fromMonth,
            amount,
            amount !== null && change.carryOver ? 1 : 0,
            now,
          ),
      ];
    }
    case 'addRecurring': {
      onlyFields(change, ['op', 'recurring']);
      const r = change.recurring;
      if (!isObject(r)) throw new Refused(400, 'Invalid repeating item');
      onlyFields(r, [
        'id',
        'kind',
        'accountId',
        'toAccountId',
        'amountCents',
        'categoryId',
        'payee',
        'schedule',
        'day',
        'startDate',
        'nextDue',
        'amountVaries',
      ]);
      if (!isRowId(r.id)) throw new Refused(400, 'Invalid repeating item id');
      if (model.recurring.has(r.id)) throw new Refused(409, 'That repeating item already exists');
      const kind = readTransactionKind(r.kind);
      const accountId = readTransactionAccount(model, r.accountId);
      const toAccountId = readDestination(model, kind, accountId, r.toAccountId, true);
      const amount = readAmount(r.amountCents);
      const categoryId = readTransactionCategory(model, r.categoryId, kind);
      const payee = readText(r.payee, MAX_PAYEE, 'payee');
      const schedule = readSchedule(r.schedule);
      const day = readScheduleDay(schedule, r.day);
      // Set up from a transaction, so any day a transaction can be on
      const startDate = readDay(r.startDate, now);
      const amountVaries = 'amountVaries' in r ? readVaries(r.amountVaries) : false;
      if (model.recurring.size >= MAX_RECURRING) throw new Refused(409, TOO_MANY_RECURRING);
      // Its first due date as the app worked it out (the first after the person's today, or
      // an imported one's), checked as a moved one is: on its schedule and within a year, but
      // never against today, so a change sent days later from an offline device still applies.
      // From an app from before: the day it was set up from was the first occurrence.
      const nextDue =
        'nextDue' in r
          ? readNextDue(schedule, day, r.nextDue, now)
          : nextAfter(schedule, day, startDate);
      model.recurring.set(r.id, {
        kind,
        accountId,
        toAccountId,
        categoryId,
        schedule,
        day,
        nextDue,
        archived: false,
        amountVaries,
      });
      // In the order set up. The count is checked again as it's saved: past the limit the
      // position is NULL, which NOT NULL refuses, undoing the whole batch.
      return [
        db
          .prepare(
            `INSERT INTO recurring (email, id, kind, account_id, to_account_id, amount_cents,
                                    category_id, payee, schedule, day, start_date, next_due,
                                    position, archived, created_at, updated_at, amount_varies,
                                    ask_first)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12,
                    CASE WHEN COUNT(*) < ${MAX_RECURRING} THEN COALESCE(MAX(position) + 1, 0) END,
                    0, ?13, ?13, ?14, ?15
             FROM recurring WHERE email = ?1`,
          )
          .bind(
            email,
            r.id,
            kind,
            accountId,
            toAccountId,
            amount,
            categoryId,
            payee,
            schedule,
            day,
            startDate,
            nextDue,
            now,
            amountVaries ? 1 : 0,
            // Its day passed by the time it's saved (sent late from an offline device, say)
            nextDue <= model.today ? 1 : 0,
          ),
      ];
    }
    case 'updateRecurring': {
      onlyFields(change, [
        'op',
        'id',
        'accountId',
        'toAccountId',
        'amountCents',
        'categoryId',
        'payee',
        'schedule',
        'day',
        'nextDue',
        'amountVaries',
      ]);
      const saved = readRecurring(model, change.id);
      const fields = Object.keys(change).filter((k) => k !== 'op' && k !== 'id');
      if (fields.length === 0) throw new Refused(400, 'Nothing to change');
      const values: (string | number | null)[] = [email];
      const sets: string[] = [];
      const set = (column: string, value: string | number | null) =>
        sets.push(`${column} = ?${values.push(value)}`);
      if ('accountId' in change || 'toAccountId' in change) {
        const accountId =
          'accountId' in change ? readTransactionAccount(model, change.accountId) : saved.accountId;
        const given = 'toAccountId' in change;
        const toAccountId = readDestination(
          model,
          saved.kind,
          accountId,
          given ? change.toAccountId : saved.toAccountId,
          given,
        );
        set('account_id', accountId);
        set('to_account_id', toAccountId);
        saved.accountId = accountId;
        saved.toAccountId = toAccountId;
      }
      if ('amountCents' in change) set('amount_cents', readAmount(change.amountCents));
      if ('categoryId' in change) {
        const categoryId = readTransactionCategory(model, change.categoryId, saved.kind);
        set('category_id', categoryId);
        saved.categoryId = categoryId;
      }
      if ('payee' in change) set('payee', readText(change.payee, MAX_PAYEE, 'payee'));
      if ('amountVaries' in change) {
        saved.amountVaries = readVaries(change.amountVaries);
        set('amount_varies', saved.amountVaries ? 1 : 0);
      }
      const schedule = 'schedule' in change ? readSchedule(change.schedule) : saved.schedule;
      const day =
        'schedule' in change || 'day' in change
          ? readScheduleDay(schedule, 'day' in change ? change.day : saved.day)
          : saved.day;
      if (('schedule' in change || 'day' in change) && !('nextDue' in change)) {
        throw new Refused(400, 'Say when it is next due');
      }
      if ('nextDue' in change) {
        const nextDue = readNextDue(schedule, day, change.nextDue, now);
        set('schedule', schedule);
        set('day', day);
        set('next_due', nextDue);
        // Moved back to a day passed (Undo of Log it or Skip): it asks again
        set('ask_first', nextDue <= model.today ? 1 : 0);
        Object.assign(saved, { schedule, day, nextDue });
      }
      set('updated_at', now);
      return [
        db
          .prepare(
            `UPDATE recurring SET ${sets.join(', ')}
             WHERE email = ?1 AND id = ?${values.push(change.id as string)}`,
          )
          .bind(...values),
        ...(saved.schedule === 'monthly' ? [] : [monthOffPay(db, email, change.id as string, now)]),
      ];
    }
    case 'archiveRecurring': {
      onlyFields(change, ['op', 'id', 'archived']);
      const saved = readRecurring(model, change.id);
      if (typeof change.archived !== 'boolean') {
        throw new Refused(400, 'Say whether it is archived');
      }
      saved.archived = change.archived;
      return [
        db
          .prepare(
            `UPDATE recurring
             SET archived = ?1,
                 ask_first = CASE WHEN ?1 = 0 AND next_due <= ?2 THEN 1 ELSE ask_first END,
                 updated_at = ?3
             WHERE email = ?4 AND id = ?5`,
          )
          .bind(change.archived ? 1 : 0, model.today, now, email, change.id),
        ...(change.archived ? [monthOffPay(db, email, change.id as string, now)] : []),
      ];
    }
    case 'logRecurring':
    case 'skipRecurring': {
      onlyFields(
        change,
        change.op === 'logRecurring' ? ['op', 'id', 'due', 'transaction'] : ['op', 'id', 'due'],
      );
      const saved = readRecurring(model, change.id);
      if (saved.archived) throw new Refused(409, STOPPED);
      const account = model.accounts.get(saved.accountId);
      const reason = account == null ? null : whyNotOnAccount(account);
      if (reason != null) throw new Refused(409, reason);
      const due = saved.nextDue;
      if (change.due !== due) throw new Refused(409, NOT_NEXT);
      const statements: D1PreparedStatement[] = [];
      if (change.op === 'logRecurring') {
        const t = change.transaction;
        if (!isObject(t)) throw new Refused(400, 'Invalid transaction');
        if (t.date !== due) throw new Refused(400, LOGGED_ON_DUE);
        // Checked and saved as any transaction added, marked as this occurrence's: to check
        // when the job adds one whose amount changes; Log it is the person's own doing
        const { scheduled: _given, ...rest } = t;
        const mark = {
          recurringId: change.id as string,
          due,
          toCheck: model.posting && saved.amountVaries,
        };
        statements.push(...addTransaction(db, email, model, rest, now, null, mark));
      }
      saved.nextDue = nextAfter(saved.schedule, saved.day, due);
      // Moved on only from the occurrence it was at when read: had another batch moved it
      // since, next_due is NULL, which NOT NULL refuses, undoing the whole batch (the
      // transaction too), so an occurrence is never logged twice
      // Logged or skipped past the person's today, it stops asking first
      statements.push(
        db
          .prepare(
            `UPDATE recurring SET next_due = CASE WHEN next_due = ?1 THEN ?2 END, updated_at = ?3,
                                  ask_first = CASE WHEN ?2 > ?6 THEN 0 ELSE ask_first END
             WHERE email = ?4 AND id = ?5`,
          )
          .bind(due, saved.nextDue, now, email, change.id, model.today),
      );
      return statements;
    }
    default:
      throw new Refused(400, 'Unknown change');
  }
}

/**
 * A month that starts on payday goes back to starting on its day once its pay stops or
 * is no longer monthly. The pay is kept, to offer again.
 */
const monthOffPay = (db: D1Database, email: string, payId: string, now: number) =>
  db
    .prepare(
      `UPDATE user_settings SET month_start_mode = 'date', updated_at = ?
       WHERE email = ? AND month_start_mode = 'payday' AND month_start_pay_id = ?`,
    )
    .bind(now, email, payId);

/** Where an entry from Scheduled came from */
interface Mark {
  recurringId: string;
  due: string;
  toCheck: boolean;
}

/** An added transaction's statement, after checking it against the model, which it updates */
function addTransaction(
  db: D1Database,
  email: string,
  model: Model,
  t: Record<string, unknown>,
  now: number,
  importId: string | null,
  mark: Mark | null,
): D1PreparedStatement[] {
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
    'time',
    'scheduled',
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
  const time = 'time' in t ? readTime(t.time) : null;
  const saved = { kind, accountId, toAccountId, categoryId };
  for (const side of sidesOf(saved)) countOn(model, side, 1);
  model.transactions.set(t.id, saved);
  // ?1 the person, ?2 the account it's from, ?3 the one it goes to
  const sides = toAccountId == null ? ['?2'] : ['?2', '?3'];
  return [
    db
      .prepare(
        `INSERT INTO transactions (email, id, kind, account_id, to_account_id, amount_cents,
                                   category_id, payee, note, date, created_at, updated_at,
                                   import_id, time, recurring_id, recurring_due, to_check)
         SELECT ?1, ?4, ?5, ${withRoom('?2', sides)}, ?3, ?6, ?7, ?8, ?9, ?10, ?11, ?11, ?12,
                ?13, ?14, ?15, ?16`,
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
        importId,
        time,
        mark?.recurringId ?? null,
        mark?.due ?? null,
        mark?.toCheck ? 1 : 0,
      ),
  ];
}

/** An entry's mark from Scheduled, as given: one of the person's own items (any state) */
function readMark(model: Model, value: unknown): Mark {
  if (!isObject(value)) throw new Refused(400, 'Invalid scheduled entry');
  onlyFields(value, ['recurringId', 'due', 'toCheck']);
  readRecurring(model, value.recurringId);
  if (!isCalendarDay(value.due) || value.due < FIRST_DAY) {
    throw new Refused(400, 'Invalid scheduled entry');
  }
  if (typeof value.toCheck !== 'boolean') throw new Refused(400, 'Invalid scheduled entry');
  return { recurringId: value.recurringId as string, due: value.due, toCheck: value.toCheck };
}

/** Whether something is yes or no, else refused */
function readVaries(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Refused(400, SAY_VARIES);
  return value;
}

/** One of the person's repeating items, by id */
function readRecurring(model: Model, id: unknown): RecurringState {
  const found = isRowId(id) ? model.recurring.get(id) : undefined;
  if (found == null) throw new Refused(404, RECURRING_NOT_FOUND);
  return found;
}

const readSchedule = (value: unknown): Schedule => {
  if (!isSchedule(value)) throw new Refused(400, 'Repeat monthly or weekly');
  return value;
};

const readScheduleDay = (schedule: Schedule, value: unknown): number => {
  if (!isScheduleDay(schedule, value)) throw new Refused(400, scheduleDayRange(schedule));
  return value;
};

/**
 * A next due date: a calendar day from 2000 that falls on the schedule, at most a year from
 * now (MAX_DUE_AHEAD_DAYS). No lower bound on today: it may have passed by the time it's sent.
 */
function readNextDue(schedule: Schedule, day: number, value: unknown, now: number): string {
  if (!isCalendarDay(value) || value < FIRST_DAY || !fallsOn(schedule, day, value)) {
    throw new Refused(400, OFF_SCHEDULE);
  }
  if (value > latestDue(now)) throw new Refused(400, 'Next due has to be within a year');
  return value;
}

/** The import an entry came in with: one of the person's own, not undone */
function readImport(model: Model, value: unknown): string {
  const record = isRowId(value) ? model.imports.get(value) : undefined;
  if (record == null) throw new Refused(404, IMPORT_NOT_FOUND);
  if (record.undone) throw new Refused(409, 'That import was undone');
  return value as string;
}

/** How many lines an import added or left out: a whole number up to MAX_IMPORT_ROWS */
function readImportCount(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > MAX_IMPORT_ROWS) {
    throw new Refused(400, IMPORT_COUNT);
  }
  return value as number;
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

const utcDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** The person's own today, in their stored time zone, else UTC's */
async function readToday(db: D1Database, email: string, now: number): Promise<string> {
  const row = await db
    .prepare('SELECT time_zone AS zone FROM user_settings WHERE email = ?')
    .bind(email)
    .first<{ zone: string | null }>();
  return (row?.zone != null ? dayIn(row.zone, now) : null) ?? utcDay(now);
}

/**
 * The person's home currency, and the one their amounts are converting into, if they are
 * (no settings saved yet: the default, none)
 */
async function readHome(db: D1Database, email: string) {
  const row = await db
    .prepare(
      `SELECT (SELECT currency FROM user_settings WHERE email = ?1) AS currency,
         (SELECT to_currency FROM conversions WHERE email = ?1 AND phase = 'converting')
           AS converting`,
    )
    .bind(email)
    .first<{ currency: string | null; converting: string | null }>();
  return {
    currency: row?.currency ?? DEFAULT_SETTINGS.currency,
    converting: row?.converting ?? null,
  };
}

/** An entry's new amount, sent as typed in the home currency */
const typedInHome = (change: unknown) =>
  isObject(change) &&
  change.op === 'updateTransaction' &&
  typeof change.id === 'string' &&
  typeof change.amountCents === 'number';

/** Writes wait while amounts convert: the app keeps them and sends them again */
const converting = (to: string) =>
  fail(
    `Converting your amounts to ${to}. Your changes are kept and saved once it's done.`,
    503,
    'converting',
  );

/** Whether D1 refused a write for breaking a constraint */
const isConstraintError = (err: unknown) => String(err).includes('CONSTRAINT');

/** POST /api/changes: saves a batch all or nothing, answering Ok or why it was refused */
export async function applyChanges(
  db: D1Database,
  email: string,
  body: Unchecked<ChangesBody>,
  {
    now = Date.now(),
    posting = false,
    fetchRate,
  }: {
    /** When it's saved as of: the nightly job's scheduled time */
    now?: number;
    /** Saved by the nightly job */
    posting?: boolean;
    /** A rate for a day, for changes typed in a home currency the person has since left */
    fetchRate?: (from: string, to: string, day: string) => Promise<Rate>;
  } = {},
) {
  const { changes, ids, currencies } = body;
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
  if (
    currencies !== undefined &&
    (!Array.isArray(currencies) ||
      currencies.length !== changes.length ||
      !currencies.every((c: unknown) => c === null || isEntryCurrency(c)))
  ) {
    return fail('Send the currency each change was typed in, one each', 400);
  }

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

  // While the person's amounts convert into a new home currency, nothing changes: the app
  // keeps the changes and sends them again (a 503)
  const home = await readHome(db, email);
  if (home.converting != null) return converting(home.converting);

  // The transactions the batch names, and how many each account it adds to holds
  const named = new Set<string>();
  const addingTo = new Set<string>();
  let repeating = false;
  let budgeting = false;
  let askingToday = false;
  const importIds = new Set<string>();
  for (const i of fresh) {
    const change: unknown = changes[i];
    if (!isObject(change)) continue;
    const op = String(change.op);
    if (op.endsWith('Recurring')) repeating = true;
    if (op === 'setBudget') budgeting = true;
    // An account or category brought back may make its items ask first
    if (op === 'archiveAccount' || op === 'archiveCategory') askingToday = true;
    // An entry brought back from Scheduled names its item
    if (
      op === 'addTransaction' &&
      isObject(change.transaction) &&
      'scheduled' in change.transaction
    ) {
      repeating = true;
    }
    // The imports it records, adds to or undoes
    const record = op === 'addImport' && isObject(change.import) ? change.import.id : undefined;
    for (const id of [record, change.importId, op === 'undoImport' ? change.id : undefined]) {
      if (isRowId(id)) importIds.add(id);
    }
    // Logging a repeating item adds its transaction
    const adds = op === 'addTransaction' || op === 'logRecurring';
    const t = adds ? change.transaction : change;
    if (!isObject(t)) continue;
    if (isRowId(t.id) && (op.endsWith('Transaction') || op === 'logRecurring')) named.add(t.id);
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
  const [accounts, savedCategories, transactions, counts, recurring, imports] = await Promise.all([
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
    !repeating
      ? { results: [] }
      : db
          .prepare(
            `SELECT id, kind, account_id AS accountId, to_account_id AS toAccountId,
                    category_id AS categoryId, schedule, day, next_due AS nextDue, archived,
                    amount_varies AS amountVaries
             FROM recurring WHERE email = ?`,
          )
          .bind(email)
          .all<
            Omit<RecurringState, 'archived' | 'amountVaries'> & {
              id: string;
              archived: 0 | 1;
              amountVaries: 0 | 1;
            }
          >(),
    importIds.size === 0
      ? { results: [] }
      : db
          .prepare(
            `SELECT id, undone_at AS undoneAt FROM imports
             WHERE email = ? AND id IN (SELECT value FROM json_each(?))`,
          )
          .bind(email, JSON.stringify([...importIds]))
          .all<{ id: string; undoneAt: number | null }>(),
  ]);
  const model: Model = {
    accounts: new Map(
      accounts.results.map((r) => [r.id, { name: r.name, archived: r.archived === 1 }]),
    ),
    categories: categoriesOrDefaults(savedCategories),
    transactions: new Map(transactions.results.map(({ id, ...t }) => [id, t])),
    counts: new Map(counts.results.map((r) => [r.id, r.count])),
    recurring: new Map(
      recurring.results.map(({ id, archived, amountVaries, ...r }) => [
        id,
        { ...r, archived: archived === 1, amountVaries: amountVaries === 1 },
      ]),
    ),
    imports: new Map(imports.results.map((r) => [r.id, { undone: r.undoneAt != null }])),
    // A budget is set from the person's month (shared/period.ts)
    monthStart: budgeting ? await readMonthStart(db, email) : 1,
    today: repeating || askingToday ? await readToday(db, email, now) : utcDay(now),
    posting,
    currency: home.currency,
  };
  // None saved yet: the defaults are saved first, so the changes after can name them
  const statements: D1PreparedStatement[] =
    savedCategories.length === 0 ? [defaultCategoriesStatement(db, email, now)] : [];
  for (const i of fresh) {
    // Typed in another currency (one of the person's others, or a home currency since
    // left): converted, keeping what was typed
    let change: unknown = changes[i];
    let typed: Typed[] = [];
    const typedCurrency = currencies?.[i];
    if (typedCurrency != null && typedCurrency !== home.currency && fetchRate != null) {
      try {
        ({ change, typed } = await typedIn(change, typedCurrency, home.currency, {
          fetchRate,
          today: model.today,
          dayOf: (id) =>
            db
              .prepare('SELECT date FROM transactions WHERE email = ? AND id = ?')
              .bind(email, id)
              .first<string>('date'),
        }));
      } catch (err) {
        if (err instanceof RatesUnavailable) return fail(err.message, 503);
        if (err instanceof TypedTooLarge) return fail(err.message, 400);
        throw err;
      }
    }
    try {
      statements.push(...changeStatements(db, email, model, change, now));
    } catch (err) {
      if (err instanceof Refused) return fail(err.message, err.status);
      throw err;
    }
    statements.push(...typedStatements(db, email, typed));
    // An entry's amount typed in the home currency is what it is: what it was typed as
    // before goes, even when the figure comes out the same (the trigger only sees a change)
    if (typed.length === 0 && typedInHome(change)) {
      statements.push(
        db
          .prepare(
            `UPDATE transactions SET original_currency = NULL, original_cents = NULL,
               rate = NULL, rate_source = NULL, rate_at = NULL
             WHERE email = ? AND id = ?`,
          )
          .bind(email, (change as { id: string }).id),
      );
    }
  }

  try {
    await db.batch([
      // A conversion begun since the currency was read refuses the whole batch: a NULL
      // where one can't go, only then
      db
        .prepare(
          `INSERT INTO change_receipts (email, change_id, fingerprint, saved_at)
           SELECT ?1, NULL, '', 0 WHERE EXISTS (
             SELECT 1 FROM conversions WHERE email = ?1 AND phase = 'converting'
           ) OR COALESCE((SELECT currency FROM user_settings WHERE email = ?1), ?3) IS NOT ?2`,
        )
        .bind(email, home.currency, DEFAULT_SETTINGS.currency),
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
    // The currency changed meanwhile: kept and sent again, as above
    const after = await readHome(db, email);
    if (after.converting != null) return converting(after.converting);
    if (after.currency !== home.currency) {
      return fail('The currency changed meanwhile. Try again.', 503);
    }
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
