import type { WeekStart } from '@shared/api';
import type { BudgetPace } from '@shared/budgets';
import type { PeriodDay } from '@shared/period';
import { budgetPace } from '@shared/budgets';
import { DEFAULT_CURRENCY } from '@shared/ledger';
import type { BudgetLine } from '../../ledger/budgets';
import type { DaySpent } from '../../ledger/day-by-day';
import { formatAmount, formatMoney } from '../../utils/money';

// Home's words: the line under the month-end figure, the two cards' lines, Tidy up, each
// calendar day's name, the weekdays, and each budget's figures. Money is whole cents,
// shown in the one currency accounts are kept in for now.

/** "RM 248.00", or "−RM 25.00" below zero */
export const signedMoney = (cents: number, currency = DEFAULT_CURRENCY) =>
  `${cents < 0 ? '−' : ''}${formatMoney(cents, currency)}`;

/** A day as "Nov 25" */
export function shortDate(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A day as "November 25" */
function longDate(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
}

/** "Rent", "Rent and Netflix", "Rent, Netflix and TNB" */
export function namesText(names: readonly string[]) {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The month end's line names the one account, with nothing due: words, not figures */
export function namesAccount(
  accounts: readonly unknown[],
  billsCents: number,
  payCents: number,
): boolean {
  return accounts.length === 1 && billsCents === 0 && payCents === 0;
}

/**
 * The line under the month-end figure: today's balances, the bills still due and the pay
 * still due, each part only when there's something in it. With the one account and nothing
 * due, it names the account ("Maybank Savings today").
 */
export function heroLine({
  accounts,
  balancesCents,
  billsCents,
  payCents,
  currency,
}: {
  accounts: readonly { name: string }[];
  balancesCents: number;
  billsCents: number;
  payCents: number;
  currency: string;
}): { today: string; bills: string | null; pay: string | null } {
  const alone = namesAccount(accounts, billsCents, payCents);
  return {
    today: `${alone ? accounts[0].name : signedMoney(balancesCents, currency)} today`,
    bills: billsCents > 0 ? `− ${formatMoney(billsCents, currency)}` : null,
    pay: payCents > 0 ? `+ ${formatMoney(payCents, currency)}` : null,
  };
}

/** "None yet", "Day 10 of 30", or "Day 10 of 30 · Shopping running fast" */
export function expensesLine(spentCents: number, at: PeriodDay, fast: string | null) {
  if (spentCents === 0) return 'None yet';
  const day = `Day ${at.day} of ${at.days}`;
  return fast == null ? day : `${day} · ${fast} running fast`;
}

/**
 * The budget furthest ahead of the month, among those faster than it: the largest
 * spent x days - available x day, in whole numbers (each budget is at most about 1e12
 * cents, so this stays exact), the first in the categories' order when two are level
 */
export function runningFast(lines: readonly BudgetLine[], at: PeriodDay): string | null {
  let best: { name: string; lead: number } | null = null;
  for (const line of lines) {
    if (budgetPace(line.spentCents, line.availableCents, at) !== 'faster') continue;
    const lead = line.spentCents * at.days - line.availableCents * at.day;
    if (best == null || lead > best.lead) best = { name: line.name, lead };
  }
  return best?.name ?? null;
}

/** "Salary due Nov 25", or "No pay scheduled" */
export function incomeLine(next: { name: string; date: string } | null) {
  return next == null ? 'No pay scheduled' : `${next.name} due ${shortDate(next.date)}`;
}

/** Tidy up's banner: "9 entries", "since Oct 1, still in Other" */
export function tidyText(entries: number, from: string, otherName: string) {
  return {
    count: entries === 1 ? '1 entry' : `${entries} entries`,
    rest: `since ${shortDate(from)}, still in ${otherName}`,
  };
}

/**
 * A calendar day's name: what was spent against the middle day so far, then what's due on
 * it ("November 10, spent RM 9.00, more than the middle day, TNB electricity due")
 */
export function dayLabel(day: DaySpent, due: readonly string[]) {
  let label = longDate(day.date);
  if (day.against != null) {
    label += `, spent ${formatMoney(day.cents, DEFAULT_CURRENCY)}, ${day.against} than the middle day`;
  }
  if (due.length > 0) label += `, ${namesText(due)} due`;
  return label;
}

const WEEK_FROM_MONDAY = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];

/** The weekdays' letters, from the day weeks start on */
export const weekdays = (weekStart: WeekStart) =>
  weekStart === 'monday' ? WEEK_FROM_MONDAY : ['S', ...WEEK_FROM_MONDAY.slice(0, 6)];

/** How many days of its week come before `firstDay`, weeks starting on `weekStart` */
export function leadingBlanks(firstDay: string, weekStart: WeekStart) {
  const [y, m, d] = firstDay.split('-').map(Number);
  // 0 is Sunday
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekStart === 'monday' ? (weekday + 6) % 7 : weekday;
}

const PACE_WORDS: Record<BudgetPace, string> = {
  onTrack: 'on track',
  faster: 'faster than the month',
  over: 'over',
};

/** A whole percent of `part` in `whole`, nearest; all of it when there's nothing to have */
const percentOf = (part: number, whole: number) =>
  whole > 0 ? Math.round((part * 100) / whole) : part > 0 ? 100 : 0;

/**
 * A budget's figures: what's left (or how far over), what's spent of what's available and
 * how that goes against the month, and the bar's name. On a computer (`short`) the
 * symbol goes from what's left and what's spent, as drawn.
 */
export function budgetText(line: BudgetLine, at: PeriodDay, { short }: { short: boolean }) {
  const pace = budgetPace(line.spentCents, line.availableCents, at);
  const amount = (cents: number) =>
    short ? formatAmount(cents, DEFAULT_CURRENCY) : formatMoney(cents, DEFAULT_CURRENCY);
  const of = `of ${signedMoney(line.availableCents)}`;
  return {
    left: line.leftCents < 0 ? `${amount(-line.leftCents)} over` : `${amount(line.leftCents)} left`,
    meta: `${short ? of : `${formatMoney(line.spentCents, DEFAULT_CURRENCY)} ${of}`} · ${PACE_WORDS[pace]}`,
    pace,
    label: `${line.name}: ${percentOf(line.spentCents, line.availableCents)}% of budget spent, ${percentOf(at.day, at.days)}% of the month gone`,
  };
}

/**
 * What Coming up lists when Home shows Essentials (owner decision D13): the next scheduled
 * item, and every one whose amount is to check, in their order
 */
export const essentialRows = <T extends { toCheck: boolean }>(rows: readonly T[]): T[] =>
  rows.filter((row, i) => i === 0 || row.toCheck);
