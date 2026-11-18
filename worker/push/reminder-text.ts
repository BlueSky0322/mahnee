// What a reminder says (owner decision D6, "Push with details"): a scheduled entry is named
// with its amount, as the owner chose, so it shows on a locked phone.

import type { ReminderMessage } from './send';

/** The daily reminder, on a day with nothing added */
export const DAILY_REMINDER: ReminderMessage = {
  title: 'Nothing added today',
  body: 'Anything spent today? Add it before you forget.',
  url: '/',
  tag: 'daily',
};

/** How many of the others due that day the message names, after the first */
const MAX_NAMED = 3;

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
 * 189.00 and 2 more are added tomorrow", the others named after it
 */
export function scheduledReminder(items: DueItem[], days: number): ReminderMessage {
  const [first, ...others] = items;
  const when = days === 1 ? 'tomorrow' : `in ${days} days`;
  const named = (i: DueItem) => `${i.name} ${moneyText(i.amountCents, i.currency)}`;
  const title =
    others.length === 0
      ? `${named(first)} is added ${when}`
      : `${named(first)} and ${others.length} more are added ${when}`;
  const shown = others.slice(0, MAX_NAMED).map(named).join(', ');
  const rest = others.length - MAX_NAMED;
  const body =
    others.length === 0
      ? 'From Scheduled. Tap to check it.'
      : `Also ${shown}${rest > 0 ? `, and ${rest} more` : ''}. Tap to check them.`;
  return { title, body, url: '/?plan=scheduled', tag: 'scheduled' };
}
