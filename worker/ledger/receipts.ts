// Receipts for the app's changes, one per change id, saved in the same batch as the
// change: a change sent again (its answer lost on the way back) counts once, and the
// same id sent with a different change is refused.

/** A receipt is kept this long: well past how long a change waits on a device */
export const RECEIPT_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Receipts for the changes saved now, and this person's ones older than RECEIPT_DAYS let go */
export function receiptStatements(
  db: D1Database,
  email: string,
  receipts: { id: string; fingerprint: string }[],
  now = Date.now(),
): D1PreparedStatement[] {
  if (receipts.length === 0) return [];
  return [
    ...receipts.map((r) =>
      db
        .prepare(
          `INSERT INTO change_receipts (email, change_id, fingerprint, saved_at)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(email, r.id, r.fingerprint, now),
    ),
    db
      .prepare('DELETE FROM change_receipts WHERE email = ? AND saved_at < ?')
      .bind(email, now - RECEIPT_DAYS * DAY_MS),
  ];
}
