import type { SearchPage, SearchTotals, Transaction } from '@shared/api';

// Activity's figures: how many are found and what they spent and received, in all and on
// each day. They are what's shown (as the server has it, with the changes still to send
// on top) plus what the server says matches beyond the last page loaded, so each one is
// counted once: an entry is either among the rows shown or beyond the last one. An add
// still to send that falls beyond the last row loaded, while more are to come, isn't shown
// (applyToPages leaves it off), so it's counted once the server holds it, in its rest.
// Transfers are found, but are never spending or income.

export interface Found {
  /** Everything found */
  found: SearchTotals;
  /** Each day's, by day (2026-11-05), for the days shown */
  days: Map<string, SearchTotals>;
  /** How many match outside the days asked for; null when not said */
  elsewhere: number | null;
}

const none = (): SearchTotals => ({ entries: 0, spentCents: 0, receivedCents: 0 });

function add(to: SearchTotals, more: SearchTotals) {
  to.entries += more.entries;
  to.spentCents += more.spentCents;
  to.receivedCents += more.receivedCents;
}

function count(to: SearchTotals, t: Transaction) {
  to.entries++;
  if (t.kind === 'expense') to.spentCents += t.amountCents;
  if (t.kind === 'income') to.receivedCents += t.amountCents;
}

/** The figures for `shown` (the rows as shown, newest first) out of the `pages` loaded */
export function searchTotals(shown: readonly Transaction[], pages: readonly SearchPage[]): Found {
  const found = none();
  const days = new Map<string, SearchTotals>();
  for (const t of shown) {
    count(found, t);
    let day = days.get(t.date);
    if (day == null) days.set(t.date, (day = none()));
    count(day, t);
  }
  const last = pages.at(-1);
  if (last != null) {
    add(found, last.rest);
    if (last.restOfLastDay != null) {
      const { date, ...rest } = last.restOfLastDay;
      let day = days.get(date);
      if (day == null) days.set(date, (day = none()));
      add(day, rest);
    }
  }
  return { found, days, elsewhere: pages[0]?.elsewhere ?? null };
}
