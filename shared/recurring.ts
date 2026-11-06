// Bills and income that repeat, monthly or weekly: when each one falls due. The app and the
// Worker work dates out the same way, so the next due date the app shows is the one the
// server saves. Days are calendar days (2026-11-05), worked out in UTC so no time zone ever
// moves them; which day is today is the app's to say (the person's own day).

/** How often an item repeats: once a month on a day of the month, or once a week on a weekday */
export const SCHEDULES = ['monthly', 'weekly'] as const;
export type Schedule = (typeof SCHEDULES)[number];

export const isSchedule = (v: unknown): v is Schedule =>
  (SCHEDULES as readonly unknown[]).includes(v);

/**
 * The most repeating items one person can have, stopped ones included, so a month's total
 * adds a bounded number of amounts and stays exact
 */
export const MAX_RECURRING = 200;

/**
 * Whether `day` is a day the schedule can fall on: 1 to 31 of a month (past a shorter
 * month's end, it falls on that month's last day), or 1 (Monday) to 7 (Sunday) of a week
 */
export const isScheduleDay = (schedule: Schedule, day: unknown): day is number =>
  typeof day === 'number' &&
  Number.isInteger(day) &&
  day >= 1 &&
  day <= (schedule === 'monthly' ? 31 : 7);

/** What a schedule's day can be, in words */
export const scheduleDayRange = (schedule: Schedule) =>
  schedule === 'monthly'
    ? 'Pick a day of the month from 1 to 31'
    : 'Pick a day of the week from 1 (Monday) to 7 (Sunday)';

const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const pad = (n: number) => String(n).padStart(2, '0');

/** The day at midnight UTC, or null when it isn't a real calendar day */
function readDay(day: string): Date | null {
  const m = DAY_PATTERN.exec(day);
  if (m == null) return null;
  const at = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return at.toISOString().slice(0, 10) === day ? at : null;
}

function mustRead(day: string) {
  const at = readDay(day);
  if (at == null) throw new Error(`Not a day: ${day}`);
  return at;
}

const dayOf = (at: Date) =>
  `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`;

/** Whether `day` is a real calendar day, as 2026-11-05 */
export const isCalendarDay = (day: unknown): day is string =>
  typeof day === 'string' && readDay(day) != null;

/** How many days a month has (month 0 is January) */
const daysIn = (year: number, month: number) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

/** A day's weekday: 1 is Monday, 7 Sunday */
const weekdayOf = (at: Date) => ((at.getUTCDay() + 6) % 7) + 1;

/** Where a monthly schedule falls in a month: on its day, or the month's last if that's shorter */
const monthlyIn = (year: number, month: number, day: number) =>
  new Date(Date.UTC(year, month, Math.min(day, daysIn(year, month))));

/** Whether an item repeating on `schedule` and `day` falls on `date` */
export function fallsOn(schedule: Schedule, day: number, date: string): boolean {
  const at = readDay(date);
  if (at == null) return false;
  if (schedule === 'weekly') return weekdayOf(at) === day;
  return at.getUTCDate() === Math.min(day, daysIn(at.getUTCFullYear(), at.getUTCMonth()));
}

/** The first day after `date` that an item repeating on `schedule` and `day` falls on */
export function nextAfter(schedule: Schedule, day: number, date: string): string {
  const at = mustRead(date);
  if (schedule === 'weekly') {
    const ahead = (day - weekdayOf(at) + 7) % 7 || 7;
    return dayOf(new Date(at.getTime() + ahead * DAY_MS));
  }
  const [year, month] = [at.getUTCFullYear(), at.getUTCMonth()];
  const inThisMonth = monthlyIn(year, month, day);
  return dayOf(inThisMonth > at ? inThisMonth : monthlyIn(year, month + 1, day));
}

/**
 * The schedule's day that `date` is on, for repeating what happened that day: its day of
 * the month, or its weekday
 */
export function dayFor(schedule: Schedule, date: string): number {
  const at = mustRead(date);
  return schedule === 'weekly' ? weekdayOf(at) : at.getUTCDate();
}

/** The last day of the month `date` is in */
export function monthEnd(date: string): string {
  const at = mustRead(date);
  return dayOf(new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 0)));
}

/** How far ahead a next due date can be moved: a year, so it stays a real, near date */
export const MAX_DUE_AHEAD_DAYS = 366;

/** The latest day a next due date can be moved to, as 2027-11-06, a year from `now` (UTC) */
export const latestDue = (now = Date.now()) =>
  new Date(now + MAX_DUE_AHEAD_DAYS * DAY_MS).toISOString().slice(0, 10);

/** The first day on or after `date` that an item repeating on `schedule` and `day` falls on */
export const onOrAfter = (schedule: Schedule, day: number, date: string): string =>
  fallsOn(schedule, day, date) ? date : nextAfter(schedule, day, date);
