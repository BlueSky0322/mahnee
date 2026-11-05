// Reading a person's ledger: their accounts, each with its balance worked out here and
// never stored, so it can't drift from what makes it up.

import type { Account, AccountList } from '../../shared/api';
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

/**
 * Every account of `email`, archived ones too, in their order. A balance is the opening
 * balance for now; transactions' sum joins in here once there are any.
 */
export async function listAccounts(db: D1Database, email: string): Promise<AccountList> {
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
  return {
    accounts: results.map((r): Account => ({ ...r, archived: r.archived === 1 })),
  };
}
