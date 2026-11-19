import type { AgainstAverage } from '@shared/trend';
import type { BudgetPace } from '@shared/budgets';
import type { PeriodDay } from '@shared/period';
import { budgetPace } from '@shared/budgets';
import type { BudgetLine } from '../../ledger/budgets';
import type { CategorySpending } from '../../ledger/derive';
import { monthHeading } from '../../utils/date-input';
import { formatAmount, formatMoney } from '../../utils/money';

// Plan's words: each category's share of the month's spending, the rows' subtitles, how a
// month compares with the usual and where it stands in its year, and each budget's
// figures. Money is whole cents, in the one currency accounts are kept in for now.

const money = (cents: number, currency: string) => formatMoney(cents, currency);
const amount = (cents: number, currency: string) => formatAmount(cents, currency);

/**
 * `part` of `whole` as a whole percent, rounded half up, worked in whole numbers so it is
 * exact however large the amounts (a person's spending reaches 5e15 cents)
 */
function wholePercent(part: number, whole: number): bigint {
  const [p, w] = [BigInt(part), BigInt(whole)];
  return (p * 200n + w) / (2n * w);
}

/** A category's share of the month's spending: "44%", or "under 1%" when it rounds to 0 */
export function sharePercent(cents: number, totalCents: number): string {
  if (totalCents <= 0) return '0%';
  const percent = wholePercent(cents, totalCents);
  return percent === 0n && cents > 0 ? 'under 1%' : `${percent}%`;
}

/** The share bar's name: "Share of expenses: Bills 44%, Groceries 26%, ..." */
export function shareLabel(rows: readonly { name: string; cents: number }[], totalCents: number) {
  return `Share of expenses: ${rows.map((r) => `${r.name} ${sharePercent(r.cents, totalCents)}`).join(', ')}`;
}

/** "1 entry", "6 entries" */
export const entriesText = (n: number) => (n === 1 ? '1 entry' : `${n} entries`);

/** What makes a category up: its payee for a single entry, else how many entries */
const entriesOrPayee = (row: CategorySpending) =>
  row.entries === 1 && row.payee != null ? row.payee : entriesText(row.entries);

/**
 * A phone row's subtitle: its share, then its subcategories with their amounts and what was
 * filed on the category itself ("Dining out 60.00, Coffee 15.00, Food 9.00"), or the payee
 * of its one entry, or how many entries
 */
export function phoneSubtitle(row: CategorySpending, totalCents: number, currency: string): string {
  const share = sharePercent(row.cents, totalCents);
  if (row.subcategories.length === 0) return `${share} · ${entriesOrPayee(row)}`;
  const parts = row.subcategories.map((sub) => `${sub.name} ${amount(sub.cents, currency)}`);
  if (row.ownCents > 0) parts.push(`${row.name} ${amount(row.ownCents, currency)}`);
  return `${share} · ${parts.join(', ')}`;
}

/**
 * A computer's row subtitle: its subcategories' names, or the payee or entries, and whether
 * its budget carries over; a category with nothing in the month says so
 */
export function deskSubtitle(
  row: CategorySpending | null,
  { carriesOver, month, isCurrent }: { carriesOver: boolean; month: string; isCurrent: boolean },
): string {
  if (row == null) {
    return isCurrent ? 'Nothing this month' : `Nothing in ${monthHeading(month, { short: true })}`;
  }
  const what =
    row.subcategories.length > 0
      ? row.subcategories.map((sub) => sub.name).join(', ')
      : entriesOrPayee(row);
  return carriesOver ? `${what} · carries over` : what;
}

/**
 * The same in two parts, so a page can stand out how far off it is: "RM 156.24 under" and
 * "your usual RM 371.46", or nothing and "the same as your usual RM 10.00"
 */
export function usualParts(
  { averageCents, byCents, direction }: AgainstAverage,
  currency: string,
): {
  by: string | null;
  rest: string;
} {
  const usual = `your usual ${money(averageCents, currency)}`;
  if (direction === 'same') return { by: null, rest: `the same as ${usual}` };
  return {
    by: `${money(byCents, currency)} ${direction === 'above' ? 'over' : 'under'}`,
    rest: usual,
  };
}

/** "RM 156.24 under your usual RM 371.46", or "the same as your usual RM 10.00" */
export function usualText(against: AgainstAverage, currency: string): string {
  const { by, rest } = usualParts(against, currency);
  return by == null ? rest : `${by} ${rest}`;
}

/**
 * Where the month shown (the last of 12) stands in its year: lower or higher than every
 * month before ("November lowest in 12 months"), else, when it is lower or higher than the
 * month before, since when ("November lowest since August": the latest earlier month at or
 * below it). Level with the month before, nothing.
 */
export function yearComparison(months: readonly { month: string; cents: number }[]) {
  if (months.length < 2) return null;
  const shown = months[months.length - 1];
  const before = months.slice(0, -1);
  const name = (month: string) => monthHeading(month, { short: true });
  const previous = before[before.length - 1].cents;
  if (shown.cents === previous) return null;
  const lower = shown.cents < previous;
  const word = lower ? 'lowest' : 'highest';
  const reaches = (cents: number) => (lower ? cents <= shown.cents : cents >= shown.cents);
  const since = [...before].reverse().find((m) => reaches(m.cents));
  return since == null
    ? `${name(shown.month)} ${word} in 12 months`
    : `${name(shown.month)} ${word} since ${name(since.month)}`;
}

/**
 * A budget's figures on Plan: what's left (or how far over), what's spent of what's
 * available with how it goes against the month (nothing said when on track), the bar's
 * name, and the pace. On a computer (`short`) what's left has no symbol, as drawn.
 */
export function budgetWords(
  line: BudgetLine,
  at: PeriodDay,
  { short, currency }: { short: boolean; currency: string },
) {
  const pace: BudgetPace = budgetPace(line.spentCents, line.availableCents, at);
  const figure = (cents: number) => (short ? amount(cents, currency) : money(cents, currency));
  const sign = line.availableCents < 0 ? '−' : '';
  const of = `${money(line.spentCents, currency)} of ${sign}${money(line.availableCents, currency)}`;
  const percent =
    line.availableCents > 0
      ? wholePercent(line.spentCents, line.availableCents)
      : line.spentCents > 0
        ? 100n
        : 0n;
  return {
    left:
      line.leftCents < 0
        ? `${figure(-line.leftCents)} over`
        : short
          ? figure(line.leftCents)
          : `${figure(line.leftCents)} left`,
    meta:
      pace === 'faster' ? `${of} · faster than the month` : pace === 'over' ? `${of} · over` : of,
    label: `${line.name}: ${percent}% spent`,
    pace,
  };
}
