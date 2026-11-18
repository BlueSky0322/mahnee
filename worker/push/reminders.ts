// The reminders (owner decision D6): the cron trigger runs this every 15 minutes, beside the
// nightly job, and each run reminds the devices of everyone whose "Remind me at" time has
// come on their own clock, in their stored time zone, from the run's scheduled time:
//   - daily, when nothing was added that day (an entry saved during their day, as their
//     clock runs that day, DST and half-hour zones included; not one from Scheduled);
//   - the day (or days) before a scheduled entry, naming it and its amount, for items that
//     will be added on their own: running, not asking first, accounts and category in use.
// A device is looked at once a day (reminded_on). One whose run is more than two hours past
// its time waits for the next day, so nothing comes hours late. Someone with no time zone,
// no device or both reminders off is never read.
//
// Each reminder is claimed for the device and the day (daily_on, scheduled_on) just before
// it is sent, so runs that overlap, or one after a run stopped halfway, never send it
// twice: at most once, never twice. A run stopped between a claim and its send loses that
// reminder for the day, by design. A device its push service says is gone (404, 410) or bad
// (400), or whose keys can't be encrypted to, is let go. One the service can't take now
// gets its claim back and is tried again 15 minutes on, then 30, 60, at most 120, so it
// doesn't take the run's places each time; one refused as unauthorised (401, 403) is
// tried again the same way and let go only at the third refusal in a row, so a broken VAPID
// setup can't let every device go in one run. Anything else (a redirect, never followed)
// isn't tried again that day.
//
// A run looks at most MAX_DEVICES_PER_RUN devices, the ones waiting longest first, a few
// at once, and reads at most MAX_NAMED + 1 items a person; the rest wait for the next run.
// A person whose reminders fail outright is left for the next run and the others still go;
// the run then fails, so the trigger shows it.
//
// Nothing a person entered is logged, nor any endpoint or key: only an error's name and
// message, or a push service's status.

import { isPushService } from '../../shared/push';
import { fallsOn } from '../../shared/recurring';
import type { Schedule } from '../../shared/recurring';
import type { ReminderMessage } from './send';
import { sendPush } from './send';
import type { DueItem } from './reminder-text';
import { MAX_NAMED, accountTag, dailyReminder, scheduledReminder } from './reminder-text';
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

/**
 * The most devices one run looks at: each takes at most two pushes and four database
 * calls, so a run beside the nightly job's stays under a Worker's 1,000
 */
const MAX_DEVICES_PER_RUN = 50;
/** How many devices are sent to at once: a Worker keeps six connections open */
const AT_ONCE = 6;
/** How many unauthorised refusals in a row let a device go */
const MAX_DENIED = 3;
/** How late a reminder may still come, in minutes after its time */
const LATE_MINUTES = 120;
/** Waits before trying a device again: 15 minutes, doubling, at most two hours */
const RETRY_MS = 15 * 60 * 1000;
const MAX_RETRY_MS = 120 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The VAPID keys, or null when the server has none (reminders aren't set up) */
export function vapidKeysOf(env: PushEnv): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return { publicKey: env.VAPID_PUBLIC_KEY, privateJwk: env.VAPID_PRIVATE_KEY };
}

const hhmm = (minutes: number) =>
  `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/** The wall clock in `zone` at `at`: its day, minutes into it, and seconds */
function wallClock(format: Intl.DateTimeFormat, at: number) {
  const parts = format.formatToParts(at);
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    minutes: part('hour') * 60 + part('minute'),
    seconds: part('second'),
  };
}

/** How far ahead of UTC `zone`'s clock is at `at`, in ms */
function offsetAt(format: Intl.DateTimeFormat, at: number) {
  const w = wallClock(format, at);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, 0, w.minutes, w.seconds);
  return asUtc - (at - (at % 1000));
}

/**
 * When the day `year-month-day` began in `zone`: its midnight, at the offset in force then
 * (the first instant on that day, where the clocks skipped midnight)
 */
function dayStart(format: Intl.DateTimeFormat, year: number, month: number, day: number) {
  const wall = Date.UTC(year, month - 1, day);
  const first = wall - offsetAt(format, wall);
  const second = wall - offsetAt(format, first);
  const onDay = (t: number) => {
    const w = wallClock(format, t);
    return w.year === year && w.month === month && w.day === day;
  };
  return [Math.min(first, second), Math.max(first, second)].find(onDay) ?? first;
}

/**
 * Where the person's clock is at `at` in `zone`: the day, the time (21:00), the earliest
 * time still reminded (two hours back, or '' from the day's start), and when the day began
 * and ends (ms); null for a zone this runtime doesn't know
 */
function clockIn(zone: string, at: number) {
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
  } catch {
    return null;
  }
  const now = wallClock(format, at);
  const today = `${now.year}-${String(now.month).padStart(2, '0')}-${String(now.day).padStart(2, '0')}`;
  const tomorrow = new Date(Date.UTC(now.year, now.month - 1, now.day + 1));
  return {
    today,
    now: hhmm(now.minutes),
    from: now.minutes > LATE_MINUTES ? hhmm(now.minutes - LATE_MINUTES) : '',
    start: dayStart(format, now.year, now.month, now.day),
    end: dayStart(
      format,
      tomorrow.getUTCFullYear(),
      tomorrow.getUTCMonth() + 1,
      tomorrow.getUTCDate(),
    ),
  };
}

/** The day `days` after `day` (2025-11-19 + 1 is 2025-11-20) */
const addDays = (day: string, days: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** A device due a look, with its person's settings and day */
interface DeviceRow {
  endpoint: string;
  email: string;
  p256dh: string;
  auth: string;
  daily: number;
  days: number | null;
  failures: number;
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
  /** How many of the person's are due that day, in all */
  count: number;
}

/** Runs `work` on each, at most `limit` at once */
async function eachAtOnce<T>(list: T[], limit: number, work: (item: T) => Promise<void>) {
  let next = 0;
  const lane = async () => {
    while (next < list.length) await work(list[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, lane));
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

  // Devices whose person's time has come, and not too long ago, not done with today and
  // not waiting to be tried again, the ones waiting longest first
  const { results: devices } = await db
    .prepare(
      `SELECT p.endpoint, p.email, p.p256dh, p.auth, p.failures, s.daily_reminder AS daily,
              s.scheduled_reminder_days AS days, json_extract(z.value, '$.today') AS today,
              json_extract(z.value, '$.start') AS start, json_extract(z.value, '$.end') AS "end"
       FROM json_each(?1) z
       JOIN user_settings s ON s.time_zone = z.key
       JOIN push_subscriptions p ON p.email = s.email
       WHERE (s.daily_reminder = 1 OR s.scheduled_reminder_days IS NOT NULL)
         AND s.reminder_time <= json_extract(z.value, '$.now')
         AND s.reminder_time > json_extract(z.value, '$.from')
         AND (p.reminded_on IS NULL OR p.reminded_on < json_extract(z.value, '$.today'))
         AND (p.retry_at IS NULL OR p.retry_at <= ?3)
       ORDER BY p.reminded_on IS NOT NULL, p.reminded_on, p.email, p.endpoint
       LIMIT ?2`,
    )
    .bind(JSON.stringify(clocks), MAX_DEVICES_PER_RUN, scheduledTime)
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
  // them, that will be added on their own: the first few of each, and how many in all.
  // A monthly item falls on its day, or the month's last when that is shorter; a weekly
  // one on its weekday (1 Monday to 7 Sunday).
  const ahead = [...people.keys()]
    .filter((email) => first(email).days != null)
    .map((email) => ({ email, target: addDays(first(email).today, first(email).days!) }));
  const due = new Map<string, { items: DueItem[]; count: number }>();
  if (ahead.length > 0) {
    const { results } = await db
      .prepare(
        `SELECT * FROM (
           SELECT r.email, r.payee, r.kind, c.name AS categoryName,
                  r.amount_cents AS amountCents, a.currency, r.schedule, r.day, z.target,
                  ROW_NUMBER() OVER (PARTITION BY r.email ORDER BY r.position, r.id) AS place,
                  COUNT(*) OVER (PARTITION BY r.email) AS count
           FROM (SELECT json_extract(value, '$.email') AS email,
                        json_extract(value, '$.target') AS target FROM json_each(?1)) z
           JOIN recurring r ON r.email = z.email
           JOIN accounts a ON a.email = r.email AND a.id = r.account_id
           LEFT JOIN accounts b ON b.email = r.email AND b.id = r.to_account_id
           LEFT JOIN categories c ON c.email = r.email AND c.id = r.category_id
           WHERE r.archived = 0 AND r.ask_first = 0 AND r.next_due <= z.target
             AND a.archived = 0
             AND (r.to_account_id IS NULL OR b.archived = 0)
             AND (c.archived IS NULL OR c.archived = 0)
             AND CASE r.schedule
               WHEN 'weekly' THEN r.day = (CAST(strftime('%w', z.target) AS INTEGER) + 6) % 7 + 1
               ELSE r.day = CAST(strftime('%d', z.target) AS INTEGER)
                 OR (r.day > CAST(strftime('%d', z.target) AS INTEGER)
                     AND strftime('%d', z.target, '+1 day') = '01')
             END)
         WHERE place <= ?2
         ORDER BY email, place`,
      )
      .bind(JSON.stringify(ahead), MAX_NAMED + 1)
      .all<ItemRow>();
    for (const r of results) {
      if (!fallsOn(r.schedule, r.day, r.target)) continue;
      const name = r.payee ?? r.categoryName ?? (r.kind === 'transfer' ? 'Transfer' : 'Scheduled');
      const theirs = due.get(r.email) ?? { items: [], count: r.count };
      theirs.items.push({ name, amountCents: r.amountCents, currency: r.currency });
      due.set(r.email, theirs);
    }
  }

  // Each person's messages, then their devices, a few at once
  const work: { device: DeviceRow; messages: ReminderMessage[] }[] = [];
  for (const [email, theirs] of people) {
    const { daily: isDaily, days } = theirs[0];
    const account = await accountTag(email);
    const messages: ReminderMessage[] = [];
    if (isDaily === 1 && !added.has(email)) messages.push(dailyReminder(account));
    const items = due.get(email);
    if (days != null && items != null && items.items.length > 0) {
      messages.push(scheduledReminder(items.items, items.count, days, account));
    }
    for (const device of theirs) work.push({ device, messages });
  }
  const failed = new Set<string>();
  await eachAtOnce(work, AT_ONCE, async ({ device, messages }) => {
    try {
      await remind(db, env, device, messages, keys, scheduledTime);
    } catch (err) {
      // Left for the next run; everyone else still goes
      failed.add(device.email);
      console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'Unknown error');
    }
  });
  if (failed.size > 0) throw new Error(`Reminders for ${failed.size} people couldn't be sent`);
}

/** Each kind of message's claim column */
const CLAIM = { daily: 'daily_on', scheduled: 'scheduled_on' } as const;

/**
 * Sends a device its messages, in order, each claimed for the day just before it goes;
 * then it's done with for the day, let go, or left to try again later
 */
async function remind(
  db: D1Database,
  env: PushEnv,
  device: DeviceRow,
  messages: ReminderMessage[],
  keys: VapidKeys,
  now: number,
): Promise<void> {
  const { email, endpoint, today } = device;
  const letGo = () =>
    db
      .prepare('DELETE FROM push_subscriptions WHERE email = ?1 AND endpoint = ?2')
      .bind(email, endpoint)
      .run();
  let okAt: number | null = null;
  // Kept from before the push services were narrowed, or a stand-in's: never sent to
  const messagesHere = isPushService(endpoint, env.PUSH_TEST_ORIGIN) ? messages : [];
  for (const message of messagesHere) {
    const column = CLAIM[message.tag];
    const claimed = await db
      .prepare(
        `UPDATE push_subscriptions SET ${column} = ?1
         WHERE email = ?2 AND endpoint = ?3 AND (${column} IS NULL OR ${column} < ?1)
         RETURNING endpoint`,
      )
      .bind(today, email, endpoint)
      .first();
    // Sent already today, by this run's twin or one before
    if (claimed == null) continue;
    const { outcome, status } = await sendPush(device, message, keys);
    if (outcome === 'gone' || outcome === 'broken') {
      if (outcome === 'broken' || (status !== 404 && status !== 410)) {
        console.error(`Push subscription let go: ${outcome === 'broken' ? 'bad keys' : status}`);
      }
      await letGo();
      return;
    }
    if (outcome === 'denied' && device.failures + 1 >= MAX_DENIED) {
      console.error(`Push subscription let go: ${status}`);
      await letGo();
      return;
    }
    if (outcome === 'later' || outcome === 'denied') {
      // The claim goes back, and the device waits a while
      const wait = Math.min(RETRY_MS * 2 ** device.failures, MAX_RETRY_MS);
      await db
        .prepare(
          `UPDATE push_subscriptions SET ${column} = NULL, failures = failures + 1,
             retry_at = ?1
           WHERE email = ?2 AND endpoint = ?3 AND ${column} = ?4`,
        )
        .bind(now + wait, email, endpoint, today)
        .run();
      return;
    }
    if (outcome === 'refused') console.error(`Push refused: ${status}`);
    else okAt = Date.now();
  }
  await db
    .prepare(
      `UPDATE push_subscriptions
       SET reminded_on = ?1, last_ok_at = COALESCE(?2, last_ok_at), failures = 0, retry_at = NULL
       WHERE email = ?3 AND endpoint = ?4`,
    )
    .bind(today, okAt, email, endpoint)
    .run();
}
