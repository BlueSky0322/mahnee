// What each payee was last filed under, so an import can file a payee's new transactions
// the same way (the app offers it, and the person can change it). Read in one query from
// the person's own spending and income; transfers and transactions with no payee say
// nothing.

import type { PayeeCategories, PayeeCategory } from '../../shared/api';
import { MAX_PAYEE_CATEGORIES, isRowId } from '../../shared/api';
import { fail, json } from '../http';

/**
 * GET /api/payee-categories?account=<id>: each payee's latest category for spending and
 * for income, payees compared trimmed (as they're saved) and ignoring case. What was filed
 * on that account comes before the person's other accounts; then the latest by day, time
 * saved and id. Someone else's account is answered as one that doesn't exist.
 */
export async function readPayeeCategories(
  db: D1Database,
  email: string,
  params: URLSearchParams,
): Promise<Response> {
  const account = params.get('account');
  if (account == null) return fail('Ask for an account', 400);
  const found =
    isRowId(account) &&
    (await db
      .prepare('SELECT 1 FROM accounts WHERE email = ? AND id = ?')
      .bind(email, account)
      .first()) != null;
  if (!found) return fail('Account not found', 404);
  const { results } = await db
    .prepare(
      `SELECT payee, kind, categoryId FROM (
         SELECT payee, kind, category_id AS categoryId, date, created_at,
                ROW_NUMBER() OVER (
                  PARTITION BY kind, lower(payee)
                  ORDER BY account_id = ?2 DESC, date DESC, created_at DESC, id DESC
                ) AS n
         FROM transactions
         WHERE email = ?1 AND kind IN ('expense', 'income') AND payee IS NOT NULL
       )
       WHERE n = 1
       ORDER BY date DESC, created_at DESC
       LIMIT ?3`,
    )
    .bind(email, account, MAX_PAYEE_CATEGORIES)
    .all<PayeeCategory>();
  return json<PayeeCategories>({ payees: results });
}
