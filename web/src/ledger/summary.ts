import type {
  CategoryTotal,
  LedgerChange,
  MonthBudget,
  MonthSummary,
  Transaction,
} from '@shared/api';
import type { Lookup } from './apply';
import { changedTransaction, idOf, isTransactionChange, oneByOne, tracker } from './apply';

// A month's totals with changes made to them before the server has them, worked out the
// way the server sums them (worker/ledger/summary.ts): spending and income in the month,
// by category; transfers never count. A change takes away what the transaction was (if
// it was in this month) and adds what it is now (if it is in this month), so one moved
// to another month or category moves out of one total and into the other. `lookup`
// gives a transaction as it was before the changes; one not known isn't taken away, and
// the totals catch up when they're next fetched.
//
// A budget set shows in the months it applies to: the month it's set from, and later ones.
// What last month left stays as the server worked it out; a change to an earlier month's
// spending moves it once the totals are next fetched (after the changes are all saved).

/** Which total a transaction counts in, if any, for `month` */
function countsIn(t: Transaction | null | undefined, month: string) {
  if (t == null || !t.date.startsWith(`${month}-`) || t.categoryId == null) return null;
  return t.kind === 'expense' ? 'spent' : t.kind === 'income' ? 'income' : null;
}

/** `totals` with `cents` added to a category's (taken away when below zero) */
function addTo(totals: CategoryTotal[], categoryId: string, cents: number) {
  const found = totals.some((t) => t.categoryId === categoryId);
  const next = found
    ? totals.map((t) => (t.categoryId === categoryId ? { ...t, cents: t.cents + cents } : t))
    : [...totals, { categoryId, cents }];
  return next.filter((t) => t.cents > 0);
}

/** Largest first, then by id, as the server lists them */
const largestFirst = (a: CategoryTotal, b: CategoryTotal) =>
  b.cents - a.cents || (a.categoryId < b.categoryId ? -1 : a.categoryId > b.categoryId ? 1 : 0);

/** `summary` with `t` added to its totals (`by` 1) or taken out (-1) */
function count(summary: MonthSummary, t: Transaction | null | undefined, by: 1 | -1) {
  const which = countsIn(t, summary.month);
  if (which == null || t?.categoryId == null) return summary;
  const cents = by * t.amountCents;
  const next =
    which === 'spent'
      ? {
          ...summary,
          spentCents: summary.spentCents + cents,
          spentByCategory: addTo(summary.spentByCategory, t.categoryId, cents),
        }
      : {
          ...summary,
          incomeCents: summary.incomeCents + cents,
          incomeByCategory: addTo(summary.incomeByCategory, t.categoryId, cents),
        };
  return { ...next, leftCents: next.incomeCents - next.spentCents };
}

/** A month's totals with `changes` made to them, in order; the one passed in is left as it was */
export function applyToSummary(
  summary: MonthSummary,
  changes: LedgerChange[],
  lookup: Lookup,
): MonthSummary {
  const transactions = tracker(lookup);
  let next = summary;
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
    next = count(count(next, before, -1), after, 1);
  }
  if (next === summary) return summary;
  return {
    ...next,
    spentByCategory: [...next.spentByCategory].sort(largestFirst),
    incomeByCategory: [...next.incomeByCategory].sort(largestFirst),
  };
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
