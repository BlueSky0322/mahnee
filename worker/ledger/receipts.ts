// Receipts for the app's changes, one per change id, saved in the same batch as the
// change: a change sent again (its answer lost on the way back) counts once, and the
// same id sent with a different change is refused.

/** A change as sent, as SHA-256 hex */
export async function changeFingerprint(change: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(change));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The fingerprints saved for these change ids, by id */
export async function savedReceipts(
  db: D1Database,
  email: string,
  ids: string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .prepare(
      `SELECT change_id AS id, fingerprint FROM change_receipts
       WHERE email = ? AND change_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(email, JSON.stringify(ids))
    .all<{ id: string; fingerprint: string }>();
  return new Map(rows.results.map((r) => [r.id, r.fingerprint]));
}

/**
 * Which of these change ids have receipts, as a statement to read in the same batch as
 * the figures it goes with (rows of { id }), so it says exactly which changes they hold
 */
export const savedIdsStatement = (db: D1Database, email: string, ids: string[]) =>
  db
    .prepare(
      `SELECT change_id AS id FROM change_receipts
       WHERE email = ? AND change_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(email, JSON.stringify(ids));

/** Devices can retry after any length of time offline, so a saved change keeps its receipt. */
export function receiptStatements(
  db: D1Database,
  email: string,
  receipts: { id: string; fingerprint: string }[],
  now = Date.now(),
): D1PreparedStatement[] {
  return receipts.map((r) =>
    db
      .prepare(
        `INSERT INTO change_receipts (email, change_id, fingerprint, saved_at)
         VALUES (?, ?, ?, ?)`,
      )
      .bind(email, r.id, r.fingerprint, now),
  );
}
