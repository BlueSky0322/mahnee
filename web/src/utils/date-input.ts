// Days as a date input reads and writes them ("2026-10-14"), in local time

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
