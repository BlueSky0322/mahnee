// Reading a person's ledger: their accounts, each with its balance worked out here and
// never stored, so it can't drift from what makes it up, and their categories.

import type { Account, Category, Ledger } from '../../shared/api';
import type { CategoryKind } from '../../shared/categories';
import type { AccountKind } from '../../shared/ledger';

interface AccountRow {
  id: string;
  name: string;
  kind: AccountKind;
  currency: string;
  openingCents: number;
  balanceCents: number;
  position: number;
  archived: 0 | 1;
}

interface CategoryRow {
  id: string;
  name: string;
  kind: CategoryKind;
  parentId: string | null;
  position: number;
  archived: 0 | 1;
}

/**
 * Every account of `email`, archived ones too, in their order. A balance is the opening
 * balance for now; transactions' sum joins in here once there are any.
 */
async function listAccounts(db: D1Database, email: string): Promise<Account[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.kind, a.currency,
              a.opening_cents AS openingCents,
              a.opening_cents AS balanceCents,
              a.position, a.archived
       FROM accounts a
       WHERE a.email = ?
       ORDER BY a.position, a.created_at, a.id`,
    )
    .bind(email)
    .all<AccountRow>();
  return results.map((r): Account => ({ ...r, archived: r.archived === 1 }));
}

/**
 * Every category of `email` saved so far, archived ones too, each in its place among
 * the ones beside it. None until their first change, which saves the defaults.
 */
export async function listCategories(db: D1Database, email: string): Promise<Category[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, kind, parent_id AS parentId, position, archived
       FROM categories
       WHERE email = ?
       ORDER BY position, id`,
    )
    .bind(email)
    .all<CategoryRow>();
  return results.map((r): Category => ({ ...r, archived: r.archived === 1 }));
}

/** A person's whole ledger, in one answer */
export async function readLedger(db: D1Database, email: string): Promise<Ledger> {
  const [accounts, categories] = await Promise.all([
    listAccounts(db, email),
    listCategories(db, email),
  ]);
  return { accounts, categories };
}
