// Scheduled entries added on their day (owner decision D8): which day it is where the person
// is, the occurrences of an item their day has reached, and what scheduled items come to in
// a month. The nightly job (worker/ledger/post-scheduled.ts), the app and the test stand-in
// work these out the same way.

import type { Schedule } from './recurring';
import { fallsOn, nextAfter, onOrAfter } from './recurring';

/** The most occurrences of one item one run adds: a month of a daily-ish catch-up */
export const MAX_POSTED_PER_ITEM = 31;

/** The most entries one run adds in all; the rest come in the runs after */
export const MAX_POSTED_PER_RUN = 200;

/**
 * The calendar day (2026-11-20) it is in `timeZone` at the instant `at` (ms), or null for a
 * zone this runtime doesn't know
 */
export function dayIn(timeZone: string, at: number): string | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(at);
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    return `${part('year')}-${part('month')}-${part('day')}`;
  } catch {
    return null;
  }
}

/**
 * The occurrences of an item from its next due date up to and including `today`, oldest
 * first, at most `max`
 */
export function dueThrough(
  r: { schedule: Schedule; day: number; nextDue: string },
  today: string,
  max: number,
): string[] {
  const due: string[] = [];
  for (let at = r.nextDue; at <= today && due.length < max; at = nextAfter(r.schedule, r.day, at)) {
    due.push(at);
  }
  return due;
}

/**
 * What items come to in a month (`firstDay` to `lastDay`, the person's month): a monthly
 * item once, a weekly one each time it falls in the month, in whole cents. At most
 * MAX_RECURRING items of at most MAX_TRANSACTION_CENTS, five times each, stay exact.
 */
export function monthlyCents(
  items: readonly { amountCents: number; schedule: Schedule; day: number }[],
  { firstDay, lastDay }: { firstDay: string; lastDay: string },
): number {
  let cents = 0;
  for (const item of items) {
    if (item.schedule === 'monthly') {
      cents += item.amountCents;
      continue;
    }
    for (
      let at = onOrAfter(item.schedule, item.day, firstDay);
      at <= lastDay;
      at = nextAfter(item.schedule, item.day, at)
    ) {
      if (fallsOn(item.schedule, item.day, at)) cents += item.amountCents;
    }
  }
  return cents;
}
