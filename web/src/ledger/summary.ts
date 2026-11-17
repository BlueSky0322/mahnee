import type {
  CategoryTotal,
  DayTotal,
  LedgerChange,
  MonthBudget,
  MonthSummary,
  MonthTotals,
  MonthTrend,
  Transaction,
} from '@shared/api';
import type { Lookup } from './apply';
import { changedTransaction, idOf, isTransactionChange, oneByOne, tracker } from './apply';

// A month's totals with changes made to them before the server has them, worked out the
// way the server sums them (worker/ledger/summary.ts): spending and income in the month,
// on the days the server summed it over (firstDay to lastDay: the person's month),
// by category, with how many entries make each and the payee of a lone one; spending by
// day; and Tidy up's count of spending since the first day of the month before still in Other
// or under it. Transfers never count. A change takes away what the transaction was (if
// it counted) and adds what it is now (if it counts), so one moved to another month or
// category moves out of one total and into the other. `lookup` gives a transaction as it
// was before the changes; one not known isn't taken away, and the totals catch up when
// they're next fetched.
//
// A category's payee is known only while it has one entry: a first entry brings its own, a
// second leaves none named, and one taken out of two leaves none named until the totals
// are fetched again (which one is left isn't known here), so it reads "1 entry" meanwhile.
// Tidy up counts in the categories the server listed; one moved under Other since counts
// once the totals are fetched again.
//
// The 12 months up to a month (spending over time) are counted the same way, each month
// on its own, so a change counts in whichever of the 12 it falls in; they have no days or
// Tidy up of their own.
//
// A budget set shows in the months it applies to: the month it's set from, and later ones.
// What last month left stays as the server worked it out; a change to an earlier month's
// spending moves it once the totals are next fetched (after the changes are all saved).

/** Whether a transaction is on one of the days `totals` were summed over */
const within = (t: Transaction, totals: Pick<MonthTotals, 'firstDay' | 'lastDay'>) =>
  t.date >= totals.firstDay && t.date <= totals.lastDay;

/** Which total a transaction counts in, if any, for the month `totals` are */
function countsIn(t: Transaction | null | undefined, totals: MonthTotals) {
  if (t == null || !within(t, totals) || t.categoryId == null) return null;
  return t.kind === 'expense' ? 'spent' : t.kind === 'income' ? 'income' : null;
}

/** `totals` with `t` added to its category's (`by` 1) or taken out (-1) */
function addTo(totals: CategoryTotal[], t: Transaction & { categoryId: string }, by: 1 | -1) {
  const was = totals.find((c) => c.categoryId === t.categoryId);
  const entries = (was?.entries ?? 0) + by;
  const { payee: _payee, ...rest } = was ?? { categoryId: t.categoryId, cents: 0, entries: 0 };
  // A first entry names its own payee; any other count names none (see above)
  const payee = was == null && by === 1 && t.payee != null ? { payee: t.payee } : {};
  const next: CategoryTotal = {
    ...rest,
    cents: rest.cents + by * t.amountCents,
    entries,
    ...payee,
  };
  const others = totals.filter((c) => c !== was);
  return next.cents > 0 && next.entries > 0 ? [...others, next] : others;
}

/** `days` with `cents` added to a day's (taken away when below zero), oldest first */
function addToDay(days: DayTotal[], date: string, cents: number) {
  const was = days.find((d) => d.date === date);
  const next = { date, cents: (was?.cents ?? 0) + cents };
  const others = days.filter((d) => d !== was);
  return (next.cents > 0 ? [...others, next] : others).sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0,
  );
}

/** Largest first, then by id, as the server lists them */
const largestFirst = (a: CategoryTotal, b: CategoryTotal) =>
  b.cents - a.cents || (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0);

/** `totals` with `t` added to its totals (`by` 1) or taken out (-1) */
function count<T extends MonthTotals>(totals: T, t: Transaction | null | undefined, by: 1 | -1): T {
  const which = countsIn(t, totals);
  if (which == null || t?.categoryId == null) return totals;
  const counted = { ...t, categoryId: t.categoryId };
  const cents = by * t.amountCents;
  const next =
    which === 'spent'
      ? {
          ...totals,
          spentCents: totals.spentCents + cents,
          spentByCategory: addTo(totals.spentByCategory, counted, by),
        }
      : {
          ...totals,
          incomeCents: totals.incomeCents + cents,
          incomeByCategory: addTo(totals.incomeByCategory, counted, by),
        };
  return { ...next, leftCents: next.incomeCents - next.spentCents };
}

/** `summary` with `t` added to its days and Tidy up (`by` 1) or taken out (-1) */
function countDays(summary: MonthSummary, t: Transaction | null | undefined, by: 1 | -1) {
  if (t == null || t.kind !== 'expense' || t.categoryId == null) return summary;
  let next = summary;
  if (within(t, summary)) {
    next = { ...next, spentByDay: addToDay(next.spentByDay, t.date, by * t.amountCents) };
  }
  const { tidyUp } = summary;
  if (
    tidyUp.categoryIds.includes(t.categoryId) &&
    t.date >= tidyUp.from &&
    t.date <= summary.lastDay
  ) {
    next = { ...next, tidyUp: { ...tidyUp, entries: tidyUp.entries + by } };
  }
  return next;
}

/**
 * `totals` with `changes` made to them, in order, `more` counting what else they hold;
 * the one passed in is left as it was, and given back when nothing changed
 */
function applyTo<T extends MonthTotals>(
  totals: T,
  changes: LedgerChange[],
  lookup: Lookup,
  more: (totals: T, t: Transaction | null | undefined, by: 1 | -1) => T,
  setBudget: (totals: T, change: Extract<LedgerChange, { op: 'setBudget' }>) => T,
): T {
  const transactions = tracker(lookup);
  let next = totals;
  for (const change of oneByOne(changes)) {
    if (change.op === 'setBudget') {
      next = setBudget(next, change);
      continue;
    }
    if (!isTransactionChange(change)) continue;
    const id = idOf(change);
    const before = transactions.find(id);
    // An addition already known as saved is in these totals too
    if (change.op === 'addTransaction' && before != null) continue;
    const after = changedTransaction(change, before);
    if (after === undefined) continue;
    transactions.set(id, after);
    next = more(count(more(count(next, before, -1), before, -1), after, 1), after, 1);
  }
  if (next === totals) return totals;
  return {
    ...next,
    spentByCategory: [...next.spentByCategory].sort(largestFirst),
    incomeByCategory: [...next.incomeByCategory].sort(largestFirst),
  };
}

/** A month's totals with `changes` made to them, in order; the one passed in is left as it was */
export function applyToSummary(
  summary: MonthSummary,
  changes: LedgerChange[],
  lookup: Lookup,
): MonthSummary {
  return applyTo(summary, changes, lookup, countDays, setBudget);
}

/** `summary` with a budget set from a month (shared/budgets.ts), if it applies to this one */
function setBudget(
  summary: MonthSummary,
  change: Extract<LedgerChange, { op: 'setBudget' }>,
): MonthSummary {
  if (change.fromMonth > summary.month) return summary;
  const { budgets: kept = [], ...rest } = summary;
  const was = kept.find((b) => b.categoryId === change.categoryId);
  const others = kept.filter((b) => b.categoryId !== change.categoryId);
  let budgets: MonthBudget[] = others;
  if (change.amountCents != null) {
    const set: MonthBudget = {
      categoryId: change.categoryId,
      amountCents: change.amountCents,
      carryOver: change.carryOver,
      // What last month left doesn't change with this month's amount
      lastMonthLeftCents: was?.lastMonthLeftCents ?? 0,
    };
    budgets = was == null ? [...kept, set] : kept.map((b) => (b === was ? set : b));
  }
  return budgets.length === 0 ? rest : { ...rest, budgets };
}

/**
 * The 12 months up to a month with `changes` made to them, in order, each month counted as
 * a month's totals are; budgets play no part. The one passed in is left as it was.
 */
export function applyToTrend(
  trend: MonthTrend,
  changes: LedgerChange[],
  lookup: Lookup,
): MonthTrend {
  const counted = changes.filter((change) => change.op !== 'setBudget');
  if (counted.length === 0) return trend;
  const months = trend.months.map((month) =>
    applyTo(
      month,
      counted,
      lookup,
      (m) => m,
      (m) => m,
    ),
  );
  return months.every((month, i) => month === trend.months[i]) ? trend : { ...trend, months };
}
