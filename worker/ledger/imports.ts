// The person's recent imports, so every device lists them with Undo: newest first, those
// not undone, at most MAX_RECENT_IMPORTS. Recording one and undoing it are changes
// (addImport, undoImport in changes.ts), saved through POST /api/changes like any other.

import type { ImportRecord, RecentImports } from '../../shared/api';
import { MAX_RECENT_IMPORTS } from '../../shared/api';

/** GET /api/imports */
export async function readImports(db: D1Database, email: string): Promise<RecentImports> {
  const { results } = await db
    .prepare(
      `SELECT id, file_name AS fileName, account_id AS accountId, added_count AS addedCount,
              skipped_count AS skippedCount, created_at AS createdAt
       FROM imports
       WHERE email = ? AND undone_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .bind(email, MAX_RECENT_IMPORTS)
    .all<ImportRecord>();
  return { imports: results };
}
