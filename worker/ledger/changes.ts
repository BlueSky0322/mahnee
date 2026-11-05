// Saving the app's changes to a person's ledger. A batch is checked change by change,
// in order, against their accounts and categories as they are now (with the batch's
// earlier changes), then saved all or nothing in one D1 batch. Every row read or written
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
import {
  DEFAULT_CURRENCY,
  MAX_ACCOUNTS,
  MAX_ACCOUNT_NAME,
  MAX_TRANSACTION,
  fitsOpeningCents,
  isAccountKind,
  readAccountName,
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

/**
 * What the batch knows of the person's ledger, as it goes: each account's id, and their
 * categories (the defaults while none are saved)
 */
interface Model {
  accounts: Set<string>;
  categories: Category[];
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
      model.accounts.add(account.id);
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
      if (!isRowId(change.id) || !model.accounts.has(change.id)) throw new Refused(404, NOT_FOUND);
      const sets: string[] = [];
      const values: (string | number)[] = [];
      if ('name' in change) {
        sets.push('name = ?');
        values.push(readName(change.name));
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
      if (!isRowId(change.id) || !model.accounts.has(change.id)) throw new Refused(404, NOT_FOUND);
      if (typeof change.archived !== 'boolean')
        throw new Refused(400, 'Say whether it is archived');
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
    default:
      throw new Refused(400, 'Unknown change');
  }
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

  const [{ results }, savedCategories] = await Promise.all([
    db.prepare('SELECT id FROM accounts WHERE email = ?').bind(email).all<{ id: string }>(),
    listCategories(db, email),
  ]);
  const model: Model = {
    accounts: new Set(results.map((r) => r.id)),
    categories: categoriesOrDefaults(savedCategories),
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
    // Another batch landed between reading and saving: an account or category added
    // with the same id, the last one a limit allows, or a move that would go two deep
    return fail('Changed somewhere else at the same time. Try again.', 409);
  }
  return ok();
}
