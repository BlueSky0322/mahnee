// What a reminder says (owner decision D6, "Push with details"): a scheduled entry is named
// with its amount, as the owner chose, so it shows on a locked phone.

import type { ReminderMessage } from './send';

/**
 * Which account a message is for, without naming it: the first 16 hex characters of the
 * SHA-256 of "mahnee-push:" and the email in small letters. web/public/sw.js works out the
 * same from the account signed in there (accountTag, sw.test.ts checks both).
 */
export async function accountTag(email: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`mahnee-push:${email.toLowerCase()}`),
  );
  return [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The daily reminder, on a day with nothing added */
export const dailyReminder = (account: string): ReminderMessage => ({
  title: 'Nothing added today',
  body: 'Anything spent today? Add it before you forget.',
  url: '/',
  tag: 'daily',
  account,
});

/** How many of the others due that day the message names, after the first */
export const MAX_NAMED = 3;

/** "RM 189.00": the currency's symbol, a space, the amount, as the app shows money */
export function moneyText(cents: number, currency: string): string {
  let parts: Intl.NumberFormatPart[];
  try {
    parts = new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      currencyDisplay: 'narrowSymbol',
    }).formatToParts(Math.abs(cents) / 100);
  } catch {
    parts = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'XXX' })
      .formatToParts(Math.abs(cents) / 100)
      .map((p) => (p.type === 'currency' ? { ...p, value: currency } : p));
  }
  const symbol = parts.find((p) => p.type === 'currency')?.value ?? currency;
  const amount = parts
    .filter((p) => p.type !== 'currency' && p.type !== 'literal' && p.type !== 'minusSign')
    .map((p) => p.value)
    .join('');
  return `${symbol} ${amount}`;
}

/** A scheduled item as the reminder names it */
export interface DueItem {
  name: string;
  amountCents: number;
  currency: string;
}

/**
 * "TNB RM 189.00 is added tomorrow" (or "in 3 days"); with others due that day, "TNB RM
 * 189.00 and 2 more are added tomorrow", up to MAX_NAMED of the others named after it.
 * `items` are the first few, in Scheduled's order; `count` how many are due in all.
 */
export function scheduledReminder(
  items: DueItem[],
  count: number,
  days: number,
  account: string,
): ReminderMessage {
  const [first, ...others] = items;
  const more = count - 1;
  const when = days === 1 ? 'tomorrow' : `in ${days} days`;
  const named = (i: DueItem) => `${i.name} ${moneyText(i.amountCents, i.currency)}`;
  const title =
    more === 0
      ? `${named(first)} is added ${when}`
      : `${named(first)} and ${more} more are added ${when}`;
  const shown = others.slice(0, MAX_NAMED).map(named).join(', ');
  const rest = more - Math.min(others.length, MAX_NAMED);
  const body =
    more === 0
      ? 'From Scheduled. Tap to check it.'
      : `Also ${shown}${rest > 0 ? `, and ${rest} more` : ''}. Tap to check them.`;
  return { title, body, url: '/?plan=scheduled', tag: 'scheduled', account };
}
