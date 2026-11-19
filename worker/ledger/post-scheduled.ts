// The nightly job (owner decision D8, "Add on the day"): the cron trigger runs it every 15
// minutes, and each run adds every scheduled occurrence whose day has begun where its
// person is, in their stored time zone, from the run's scheduled time. Someone with no
// zone yet is left until the app sends one. Items that ask first (D19) wait for Log it or
// Skip on Home.
//
// Each occurrence is a logRecurring change saved through applyChanges, the same path and
// checks as the app's own, marked as from Scheduled (and to check when the amount
// changes). Its change id and transaction id are worked out from the item and the day, so a
// run repeated, retried or overlapping another adds nothing twice: the receipt, the next
// due guard and the transaction's own id each stop it. Missed runs are caught up from the
// item's next due date, oldest first, at most MAX_POSTED_PER_ITEM of one item and
// MAX_POSTED_PER_RUN in all; the rest come in the runs after. An item that can't be added
// (an archived account or category) is never read, so it takes nothing from the run;
// anything else refused is left as it is, without holding back the person's other items.
// A person whose save fails outright (not a refusal) is left for the next run and the
// others still go; the run then fails, so the trigger shows it.
//
// A run stays inside a Worker's budget of database calls: at most MAX_PEOPLE_PER_RUN people
// and MAX_SAVES_PER_RUN saves (a person's at once, then each item on its own when that's
// refused); what's left waits for the next run, 15 minutes later.
//
// Nothing a person entered is logged: only an error's name and message.

import type { LedgerChange } from '../../shared/api';
import type { TransactionKind } from '../../shared/ledger';
import type { Schedule } from '../../shared/recurring';
import { MAX_POSTED_PER_ITEM, MAX_POSTED_PER_RUN, dayIn, dueThrough } from '../../shared/scheduled';
import { applyChanges } from './changes';

/** The most people one run adds for; the rest wait for the next run */
const MAX_PEOPLE_PER_RUN = 40;

/**
 * The most saves one run makes (each one applyChanges: about seven database calls), so a run
 * stays well under a Worker's 1,000
 */
const MAX_SAVES_PER_RUN = 100;

/** A due item as read, with its person's today */
interface DueRow {
  email: string;
  id: string;
  kind: TransactionKind;
  accountId: string;
  toAccountId: string | null;
  amountCents: number;
  categoryId: string | null;
  payee: string | null;
  schedule: Schedule;
  day: number;
  nextDue: string;
  today: string;
}

/** One occurrence to add: its change, its fixed id, and the item it's of */
interface Posting {
  id: string;
  item: string;
  change: LedgerChange;
}

/** The first 16 hex characters of the SHA-256 of `text`: a row id fixed by what it's for */
async function fixedId(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Adds what's due as of `scheduledTime` (ms), as described above */
export async function postScheduled(db: D1Database, scheduledTime: number): Promise<void> {
  // Each zone anyone has, and the day it is there now
  const zones = await db
    .prepare('SELECT DISTINCT time_zone AS zone FROM user_settings WHERE time_zone IS NOT NULL')
    .all<{ zone: string }>();
  const today: Record<string, string> = {};
  for (const { zone } of zones.results) {
    const day = dayIn(zone, scheduledTime);
    if (day != null) today[zone] = day;
  }
  if (Object.keys(today).length === 0) return;

  // Due by the person's own day, running, not asking first, and able to be added: its
  // accounts and category not archived. At most a run's worth, oldest due first.
  const { results } = await db
    .prepare(
      `SELECT r.email, r.id, r.kind, r.account_id AS accountId, r.to_account_id AS toAccountId,
              r.amount_cents AS amountCents, r.category_id AS categoryId, r.payee, r.schedule,
              r.day, r.next_due AS nextDue, z.value AS today
       FROM json_each(?1) z
       JOIN user_settings s ON s.time_zone = z.key
       JOIN recurring r ON r.email = s.email
       JOIN accounts a ON a.email = r.email AND a.id = r.account_id
       LEFT JOIN accounts b ON b.email = r.email AND b.id = r.to_account_id
       LEFT JOIN categories c ON c.email = r.email AND c.id = r.category_id
       WHERE r.archived = 0 AND r.ask_first = 0 AND r.next_due <= z.value
         -- Not while the person's amounts convert into a new currency: the next run adds it
         AND NOT EXISTS (
           SELECT 1 FROM conversions cv WHERE cv.email = r.email AND cv.phase = 'converting'
         )
         AND a.archived = 0
         AND (r.to_account_id IS NULL OR b.archived = 0)
         AND (c.archived IS NULL OR c.archived = 0)
       ORDER BY r.next_due, r.email, r.position, r.id
       LIMIT ?2`,
    )
    .bind(JSON.stringify(today), MAX_POSTED_PER_RUN)
    .all<DueRow>();

  // Each item's occurrences, until the run's are used up, by person in the order read
  const byPerson = new Map<string, Posting[]>();
  let left = MAX_POSTED_PER_RUN;
  for (const r of results) {
    if (left === 0) break;
    if (!byPerson.has(r.email) && byPerson.size >= MAX_PEOPLE_PER_RUN) continue;
    const due = dueThrough(r, r.today, Math.min(MAX_POSTED_PER_ITEM, left));
    left -= due.length;
    const changes = byPerson.get(r.email) ?? [];
    for (const day of due) {
      // The change's id and its transaction's are the same, fixed by the item and the day
      const id = await fixedId(`sched:${r.id}:${day}`);
      changes.push({
        id,
        item: r.id,
        change: {
          op: 'logRecurring',
          id: r.id,
          due: day,
          transaction: {
            id,
            kind: r.kind,
            accountId: r.accountId,
            toAccountId: r.toAccountId,
            amountCents: r.amountCents,
            categoryId: r.categoryId,
            payee: r.payee,
            note: null,
            date: day,
          },
        },
      });
    }
    byPerson.set(r.email, changes);
  }

  let saves = 0;
  let failed = 0;
  for (const [email, changes] of byPerson) {
    if (saves >= MAX_SAVES_PER_RUN) break;
    try {
      // All of a person's at once; refused, each item on its own, so one can't hold back
      // others, as far as the run's saves go
      saves++;
      if (await post(db, email, changes, scheduledTime)) continue;
      for (const item of new Set(changes.map((c) => c.item))) {
        if (saves >= MAX_SAVES_PER_RUN) break;
        saves++;
        await post(
          db,
          email,
          changes.filter((c) => c.item === item),
          scheduledTime,
        );
      }
    } catch (err) {
      // Left for the next run; everyone else still goes
      failed++;
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown error');
    }
  }
  if (failed > 0) throw new Error(`Scheduled entries for ${failed} people couldn't be added`);
}

/** Saves these changes as the job; whether they were saved (now or before) */
async function post(
  db: D1Database,
  email: string,
  changes: Posting[],
  now: number,
): Promise<boolean> {
  const res = await applyChanges(
    db,
    email,
    { changes: changes.map((c) => c.change), ids: changes.map((c) => c.id) },
    { now, posting: true },
  );
  return res.ok;
}
