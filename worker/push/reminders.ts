// The reminders (owner decision D6): the cron trigger runs this every 15 minutes, beside the
// nightly job, and each run reminds the devices of everyone whose "Remind me at" time has
// come on their own clock, in their stored time zone, from the run's scheduled time:
//   - daily, when nothing was added that day (an entry saved during their day, not one
//     from Scheduled);
//   - the day (or days) before a scheduled entry, naming it and its amount, for items that
//     will be added on their own: running, not asking first, accounts and category in use.
// A device is reminded once a day (reminded_on). One whose run is more than two hours past
// its time waits for the next day, so nothing comes hours late. Someone with no time zone,
// no device or both reminders off is never read.
//
// A device its push service says is gone (404, 410) is let go; one the service can't take
// now is tried again at the next run; anything else, not again that day. A run reminds at
// most MAX_DEVICES_PER_RUN devices, the ones waiting longest first, and reads at most
// MAX_ITEMS_READ items; the rest wait for the next run. A person whose reminders fail
// outright is left for the next run and the others still go; the run then fails, so the
// trigger shows it.
//
// Nothing a person entered is logged, nor any endpoint or key: only an error's name and
// message.

import { isPushService } from '../../shared/push';
import { fallsOn } from '../../shared/recurring';
import type { Schedule } from '../../shared/recurring';
import type { ReminderMessage } from './send';
import { sendPush } from './send';
import type { DueItem } from './reminder-text';
import { DAILY_REMINDER, scheduledReminder } from './reminder-text';
import type { VapidKeys } from './vapid';
import { vapidAuthorization } from './vapid';

export interface PushEnv {
  /** The VAPID public key devices subscribe with (wrangler.jsonc vars) */
  VAPID_PUBLIC_KEY?: string;
  /** Its private key, a P-256 JWK in JSON (a Worker secret) */
  VAPID_PRIVATE_KEY?: string;
  /** One more origin taken as a push service: a stand-in, set only by the tests */
  PUSH_TEST_ORIGIN?: string;
}

/** The most devices one run reminds; each takes at most two pushes */
const MAX_DEVICES_PER_RUN = 50;
/** The most scheduled items one run reads */
const MAX_ITEMS_READ = 200;
/** How late a reminder may still come, in minutes after its time */
const LATE_MINUTES = 120;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The VAPID keys, or null when the server has none (reminders aren't set up) */
export function vapidKeysOf(env: PushEnv): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: env.VAPID_PRIVATE_KEY };
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * Where the person's clock is at `at` in `zone`: the day, the time (21:00), the earliest
 * time still reminded (two hours back, or '' from the day's start), and when the day began
 * and ends (ms); null for a zone this runtime doesn't know
 */
function clockIn(zone: string, at: number) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
  } catch {
    return null;
  }
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const minutes = Number(part('hour')) * 60 + Number(part('minute'));
  const start = at - (minutes * 60 + Number(part('second'))) * 1000 - (at % 1000);
  return {
    today: `${part('year')}-${part('month')}-${part('day')}`,
    now: hhmm(minutes),
    from: minutes > LATE_MINUTES ? hhmm(minutes - LATE_MINUTES) : '',
    start,
    end: start + DAY_MS,
  };
}

/** The day `days` after `day` (2025-11-19 + 1 is 2025-11-20) */
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** A device due a reminder, with its person's settings and day */
interface DeviceRow {
  endpoint: string;
  email: string;
  p256dh: string;
  auth: string;
  daily: number;
  days: number | null;
  today: string;
  start: number;
  end: number;
}

interface ItemRow {
  email: string;
  payee: string | null;
  kind: string;
  categoryName: string | null;
  amountCents: number;
  currency: string;
  schedule: Schedule;
  day: number;
  target: string;
}

/** Sends the reminders due as of `scheduledTime` (ms), as described above */
export async function sendReminders(
  db: D1Database,
  env: PushEnv,
  scheduledTime: number,
): Promise<void> {
  const keys = vapidKeysOf(env);
  if (keys == null) return;
  // Keys that aren't a pair fail the run at once, rather than each person
  await vapidAuthorization('https://fcm.googleapis.com', keys, Date.now());

  // Each zone of anyone with a device, and where its clock is now
  const zones = await db
    .prepare(
      `SELECT DISTINCT s.time_zone AS zone FROM user_settings s
       JOIN push_subscriptions p ON p.email = s.email
       WHERE s.time_zone IS NOT NULL`,
    )
    .all<{ zone: string }>();
  const clocks: Record<string, NonNullable<ReturnType<typeof clockIn>>> = {};
  for (const { zone } of zones.results) {
    const clock = clockIn(zone, scheduledTime);
    if (clock != null) clocks[zone] = clock;
  }
  if (Object.keys(clocks).length === 0) return;

  // Devices whose person's time has come, and not too long ago, not yet reminded today,
  // the ones waiting longest first
  const { results: devices } = await db
    .prepare(
      `SELECT p.endpoint, p.email, p.p256dh, p.auth, s.daily_reminder AS daily,
              s.scheduled_reminder_days AS days, json_extract(z.value, '$.today') AS today,
              json_extract(z.value, '$.start') AS start, json_extract(z.value, '$.end') AS "end"
       FROM json_each(?1) z
       JOIN user_settings s ON s.time_zone = z.key
       JOIN push_subscriptions p ON p.email = s.email
       WHERE (s.daily_reminder = 1 OR s.scheduled_reminder_days IS NOT NULL)
         AND s.reminder_time <= json_extract(z.value, '$.now')
         AND s.reminder_time > json_extract(z.value, '$.from')
         AND (p.reminded_on IS NULL OR p.reminded_on < json_extract(z.value, '$.today'))
       ORDER BY p.reminded_on IS NOT NULL, p.reminded_on, p.email, p.endpoint
       LIMIT ?2`,
    )
    .bind(JSON.stringify(clocks), MAX_DEVICES_PER_RUN)
    .all<DeviceRow>();
  if (devices.length === 0) return;

  const people = new Map<string, DeviceRow[]>();
  for (const d of devices) people.set(d.email, [...(people.get(d.email) ?? []), d]);
  const first = (email: string) => people.get(email)![0];

  // Who added something during their day: they get no daily reminder
  const daily = [...people.keys()].filter((email) => first(email).daily === 1);
  const added = new Set<string>();
  if (daily.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT json_extract(z.value, '$.email') AS email FROM json_each(?1) z
         WHERE EXISTS (
           SELECT 1 FROM transactions t
           WHERE t.email = json_extract(z.value, '$.email')
             AND t.created_at >= json_extract(z.value, '$.start')
             AND t.created_at < json_extract(z.value, '$.end')
             AND t.recurring_id IS NULL)`,
      )
      .bind(
        JSON.stringify(
          daily.map((email) => ({ email, start: first(email).start, end: first(email).end })),
        ),
      )
      .all<{ email: string }>();
    for (const r of results) added.add(r.email);
  }

  // The items each person has on the day their reminder before is for, as Scheduled lists
  // them, that will be added on their own
  const ahead = [...people.keys()]
    .filter((email) => first(email).days != null)
    .map((email) => ({ email, target: addDays(first(email).today, first(email).days!) }));
  const due = new Map<string, DueItem[]>();
  if (ahead.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT r.email, r.payee, r.kind, c.name AS categoryName, r.amount_cents AS amountCents,
                a.currency, r.schedule, r.day, json_extract(z.value, '$.target') AS target
         FROM json_each(?1) z
         JOIN recurring r ON r.email = json_extract(z.value, '$.email')
         JOIN accounts a ON a.email = r.email AND a.id = r.account_id
         LEFT JOIN accounts b ON b.email = r.email AND b.id = r.to_account_id
         LEFT JOIN categories c ON c.email = r.email AND c.id = r.category_id
         WHERE r.archived = 0 AND r.ask_first = 0
           AND r.next_due <= json_extract(z.value, '$.target')
           AND a.archived = 0
           AND (r.to_account_id IS NULL OR b.archived = 0)
           AND (c.archived IS NULL OR c.archived = 0)
         ORDER BY r.email, r.position, r.id
         LIMIT ?2`,
      )
      .bind(JSON.stringify(ahead), MAX_ITEMS_READ)
      .all<ItemRow>();
    for (const r of results) {
      if (!fallsOn(r.schedule, r.day, r.target)) continue;
      const name = r.payee ?? r.categoryName ?? (r.kind === 'transfer' ? 'Transfer' : 'Scheduled');
      due.set(r.email, [
        ...(due.get(r.email) ?? []),
        { name, amountCents: r.amountCents, currency: r.currency },
      ]);
    }
  }

  const reminded: D1PreparedStatement[] = [];
  let failed = 0;
  for (const [email, theirs] of people) {
    const { daily: isDaily, days } = theirs[0];
    const messages: ReminderMessage[] = [];
    if (isDaily === 1 && !added.has(email)) messages.push(DAILY_REMINDER);
    const items = due.get(email);
    if (days != null && items != null) messages.push(scheduledReminder(items, days));
    try {
      for (const device of theirs) {
        reminded.push(...(await remind(db, env, device, messages, keys)));
      }
    } catch (err) {
      // Left for the next run; everyone else still goes
      failed++;
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown error');
    }
  }
  if (reminded.length > 0) await db.batch(reminded);
  if (failed > 0) throw new Error(`Reminders for ${failed} people couldn't be sent`);
}

/**
 * Sends a device its messages, in order; answers what becomes of it: let go, reminded for
 * today, or nothing (tried again at the next run)
 */
async function remind(
  db: D1Database,
  env: PushEnv,
  device: DeviceRow,
  messages: ReminderMessage[],
  keys: VapidKeys,
): Promise<D1PreparedStatement[]> {
  const mark = (okAt: number | null) =>
    db
      .prepare(
        `UPDATE push_subscriptions SET reminded_on = ?1, last_ok_at = COALESCE(?2, last_ok_at)
         WHERE email = ?3 AND endpoint = ?4`,
      )
      .bind(device.today, okAt, device.email, device.endpoint);
  // Kept from before the push services were narrowed, or from a test's stand-in: never sent
  if (!isPushService(device.endpoint, env.PUSH_TEST_ORIGIN)) return [mark(null)];
  let okAt: number | null = null;
  for (const message of messages) {
    const outcome = await sendPush(device, message, keys);
    if (outcome === 'gone') {
      return [
        db
          .prepare('DELETE FROM push_subscriptions WHERE email = ?1 AND endpoint = ?2')
          .bind(device.email, device.endpoint),
      ];
    }
    if (outcome === 'later') return [];
    if (outcome === 'sent') okAt = Date.now();
  }
  return [mark(okAt)];
}
