// Days as a date input reads and writes them ("2026-10-14"), and months ("2026-10"), in
// local time

const pad = (n: number) => String(n).padStart(2, '0');

/** "2026-10-14" for a date input, in local time */
export const toDateInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** The start of the day a date input holds, or null when it doesn't hold one */
export const fromDateInput = (text: string) => {
  const [y, m, d] = text.split('-').map(Number);
  return y && m && d ? new Date(y, m - 1, d) : null;
};

/** Whether a date input holds a day from 2000 up to today */
export const isPastDay = (text: string) => {
  const day = fromDateInput(text);
  return day != null && day.getFullYear() >= 2000 && text <= toDateInput(new Date());
};

/** That day at the time it is now, never later than now */
export function atTimeNow(day: Date) {
  const now = new Date();
  const at = new Date(day);
  at.setHours(now.getHours(), now.getMinutes(), now.getSeconds(), now.getMilliseconds());
  return Math.min(at.getTime(), now.getTime());
}

/** That day at the time of day `at` has, never later than now (moving something to a day) */
export function keepTimeOf(day: Date, at: number) {
  const was = new Date(at);
  const moved = new Date(day);
  moved.setHours(was.getHours(), was.getMinutes(), was.getSeconds(), was.getMilliseconds());
  return Math.min(moved.getTime(), Date.now());
}

/**
 * A day as a heading over what happened on it: "Today", "Yesterday", "Wed, 14 Oct", with
 * the year when it isn't this year's
 */
export function dayHeading(text: string, now = new Date()) {
  const day = fromDateInput(text);
  if (day == null) return text;
  if (text === toDateInput(now)) return 'Today';
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (text === toDateInput(yesterday)) return 'Yesterday';
  return day.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    ...(day.getFullYear() !== now.getFullYear() && { year: 'numeric' }),
  });
}

/** A day in full, as the person's language writes it: "3 Jan 2026" */
export function dayText(text: string) {
  const day = fromDateInput(text);
  return day == null
    ? text
    : day.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

// ---------- Months ----------

/** This month in local time, as 2026-11 */
export const thisMonth = (now = new Date()) => toDateInput(now).slice(0, 7);

/** The month `by` months after `month` (before it, below zero), as 2026-11 */
export function addMonths(month: string, by: number) {
  const [y, m] = month.split('-').map(Number);
  const at = new Date(y, m - 1 + by, 1);
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}`;
}

/** A month as a heading, "November 2026"; with `short`, the month alone, "November" */
export function monthHeading(month: string, { short = false } = {}) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, {
    month: 'long',
    ...(!short && { year: 'numeric' }),
  });
}

/** A month as one bar of a year is labelled: "Dec 2025" */
export function monthLabel(month: string) {
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
}
