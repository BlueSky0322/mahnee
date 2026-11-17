import type { Account, Category, SearchTotals, Transaction } from '@shared/api';
import type { TransactionKind } from '@shared/ledger';
import { periodMonthOf, periodOf, shiftMonth } from '@shared/period';
import { foldCase, isCalendarDay } from '@shared/search';
import { fromDateInput, monthHeading } from '../../utils/date-input';
import { formatAmount, formatMoney } from '../../utils/money';
import { categoryName } from '../common/category-name';

// Activity's words (R-Activity, R-Activity-Select, R-Activity-Move, R-Desk-Activity,
// R-Desk-Bulk, R-Empty-Search). Amounts say which way the money went (R-System): spending
// has a minus, income a plus, and a transfer no sign, since it's neither.

// ---------- Amounts ----------

const SIGNS: Record<TransactionKind, string> = { expense: '−', income: '+', transfer: '' };

/** In a list, without the currency: "−7.25", "+3,250.00", a transfer's "75.00" */
export const listAmount = (t: Transaction, currency: string) =>
  `${SIGNS[t.kind]}${formatAmount(t.amountCents, currency)}`;

/** As an entry's headline, with the currency: "−RM 212.00", a transfer's "RM 75.00" */
export const headlineAmount = (t: Transaction, currency: string) =>
  `${SIGNS[t.kind]}${formatMoney(t.amountCents, currency)}`;

/** A day's total, what came in less what went out ("−11.85"); null for transfers alone */
export function dayTotal(day: SearchTotals, currency: string): string | null {
  if (day.spentCents === 0 && day.receivedCents === 0) return null;
  const net = day.receivedCents - day.spentCents;
  return `${net < 0 ? '−' : net > 0 ? '+' : ''}${formatAmount(net, currency)}`;
}

// ---------- Days ----------

/** "Nov 7", with the year when it isn't `today`'s ("Oct 14, 2025") */
export function shortDay(day: string, today: string) {
  const at = fromDateInput(day);
  if (at == null) return day;
  return at.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(day.slice(0, 4) !== today.slice(0, 4) && { year: 'numeric' }),
  });
}

/** "Tue, Nov 10", with the year when it isn't `today`'s */
export function fullDay(day: string, today: string) {
  const at = fromDateInput(day);
  if (at == null) return day;
  return at.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(day.slice(0, 4) !== today.slice(0, 4) && { year: 'numeric' }),
  });
}

/**
 * The month (2026-11) whose days `from` and `to` are exactly, the person's month from
 * `start` (shared/period.ts), or null
 */
function wholeMonth(from: string | null, to: string | null, start: number): string | null {
  if (from == null || to == null || !isCalendarDay(from)) return null;
  const month = periodMonthOf(from, start);
  const { firstDay, lastDay } = periodOf(month, start);
  return firstDay === from && lastDay === to ? month : null;
}

type Period = { from: string | null; to: string | null };

/**
 * How the days are said in a sentence ("this month", "since Oct 1"); '' for every day.
 * Months are the person's, from `start` (the 1st when not given).
 */
function periodPhrase({ from, to }: Period, today: string, start: number) {
  const month = wholeMonth(from, to, start);
  if (month != null) {
    const current = periodMonthOf(today, start);
    if (month === current) return 'this month';
    if (month === shiftMonth(current, -1)) return 'last month';
    return `in ${monthHeading(month)}`;
  }
  if (from != null && from === to) return `on ${fullDay(from, today)}`;
  if (from != null && to != null) return `from ${shortDay(from, today)} to ${shortDay(to, today)}`;
  if (from != null) return `since ${shortDay(from, today)}`;
  if (to != null) return `until ${shortDay(to, today)}`;
  return '';
}

// ---------- The filters ----------

/**
 * The days' chip: "This month", "Since Oct 1", "Tue, Nov 10", "All months"; months are the
 * person's, from `start` (the 1st when not given)
 */
export function periodText(period: Period, today: string, start = 1) {
  const month = wholeMonth(period.from, period.to, start);
  if (month != null) {
    const current = periodMonthOf(today, start);
    if (month === current) return 'This month';
    if (month === shiftMonth(current, -1)) return 'Last month';
    return monthHeading(month);
  }
  if (period.from != null && period.from === period.to) return fullDay(period.from, today);
  if (period.from != null && period.to != null) {
    return `${shortDay(period.from, today)} to ${shortDay(period.to, today)}`;
  }
  if (period.from != null) return `Since ${shortDay(period.from, today)}`;
  if (period.to != null) return `Until ${shortDay(period.to, today)}`;
  return 'All months';
}

const KIND_NAMES: Record<TransactionKind, string> = {
  expense: 'Expenses',
  income: 'Income',
  transfer: 'Transfers',
};

/** The kind's chip: "All kinds", "Expenses", "Expenses and income" */
export function kindText(kinds: readonly TransactionKind[] | null) {
  if (kinds == null || kinds.length === 0 || kinds.length === 3) return 'All kinds';
  const [first, ...more] = kinds.map((k) => KIND_NAMES[k]);
  return [first, ...more.map((name) => name.toLowerCase())].join(' and ');
}

// ---------- What's found ----------

/** "1 entry", "3 entries" */
export const entriesText = (n: number) => `${n} ${n === 1 ? 'entry' : 'entries'}`;

/**
 * "12 found · RM 43.18 spent", with what was received when any was; while selecting,
 * "4 found in Other" (the category filtered by)
 */
export function foundLine(
  found: SearchTotals,
  currency: string,
  selecting?: { category: string | null },
) {
  if (selecting != null) {
    return `${found.entries} found${selecting.category == null ? '' : ` in ${selecting.category}`}`;
  }
  const parts = [`${found.entries} found`];
  if (found.spentCents > 0) parts.push(`${formatMoney(found.spentCents, currency)} spent`);
  if (found.receivedCents > 0) parts.push(`${formatMoney(found.receivedCents, currency)} received`);
  return parts.join(' · ');
}

/** 'No "bolt" in Transport this month. 2 in other months.' */
export function noMatchLine(
  looked: Period & { q: string; category: string | null; elsewhere: number | null },
  today: string,
  start = 1,
) {
  const phrase = periodPhrase(looked, today, start);
  const said = [
    looked.q === '' ? 'Nothing' : `No "${looked.q}"`,
    looked.category == null ? null : `in ${looked.category}`,
    phrase || null,
  ]
    .filter(Boolean)
    .join(' ');
  const n = looked.elsewhere ?? 0;
  if (n === 0 || phrase === '') return `${said}.`;
  const months = wholeMonth(looked.from, looked.to, start) != null;
  const other = months
    ? n === 1
      ? 'in another month'
      : 'in other months'
    : n === 1
      ? 'on another day'
      : 'on other days';
  return `${said}. ${n} ${other}.`;
}

/** The name an account goes by, or a stand-in while it isn't known */
const accountName = (accounts: readonly Pick<Account, 'id' | 'name'>[], id: string | null) =>
  accounts.find((a) => a.id === id)?.name ?? 'another account';

/**
 * A row's title (its payee, else its note, else what it was: its category, or a
 * transfer's two accounts) and subtitle (its category and account, or a transfer's two
 * accounts). A note the words found shows in place of the category; while selecting, the
 * day is added.
 */
export function rowText(
  t: Transaction,
  {
    accounts,
    categories,
    q,
    selecting,
    today,
  }: {
    accounts: readonly Pick<Account, 'id' | 'name'>[];
    categories: readonly Category[];
    q: string;
    selecting: boolean;
    today: string;
  },
) {
  const what =
    t.kind === 'transfer'
      ? `${accountName(accounts, t.accountId)} to ${accountName(accounts, t.toAccountId)}`
      : categoryName(categories, t.categoryId);
  const title = t.payee ?? t.note ?? what;
  const noteFound =
    q !== '' && t.note != null && t.note !== title && foldCase(t.note).includes(foldCase(q));
  let subtitle: string;
  if (t.kind === 'transfer') {
    subtitle = noteFound ? `${t.note} · ${what}` : title === what ? 'Transfer' : what;
  } else {
    const account = accountName(accounts, t.accountId);
    subtitle = noteFound
      ? `${t.note} · ${account}`
      : title === what
        ? account
        : `${what} · ${account}`;
  }
  if (selecting) subtitle = `${subtitle} · ${shortDay(t.date, today)}`;
  return { title, subtitle };
}

// ---------- Changing many ----------

/** The payee every one of them shares, or null */
const sharedPayee = (chosen: readonly Transaction[]) => {
  const payee = chosen[0]?.payee ?? null;
  return payee != null && chosen.every((t) => t.payee === payee) ? payee : null;
};

/**
 * "3 entries · RM 30.90 · all Kedai": the sum when they're all one kind, the payee when
 * they share one
 */
export function selectionLine(chosen: readonly Transaction[], currency: string) {
  const parts = [entriesText(chosen.length)];
  if (chosen.length > 0 && chosen.every((t) => t.kind === chosen[0].kind)) {
    // At most MAX_BULK_TRANSACTIONS of at most MAX_TRANSACTION_CENTS: exact
    parts.push(
      formatMoney(
        chosen.reduce((sum, t) => sum + t.amountCents, 0),
        currency,
      ),
    );
  }
  const payee = sharedPayee(chosen);
  if (payee != null) parts.push(`all ${payee}`);
  return parts.join(' · ');
}

/** Where they are now: "Other", or "2 categories" */
export function nowIn(chosen: readonly Transaction[], name: (id: string | null) => string) {
  const from = [...new Set(chosen.map((t) => t.categoryId))];
  return from.length === 1 ? name(from[0]) : `${from.length} categories`;
}

/**
 * Which they are and where they are now: "Kedai, Nov 8, Oct 21 and 12 · now in Other",
 * the first few days and how many more
 */
export function movingLine(
  chosen: readonly Transaction[],
  name: (id: string | null) => string,
  today: string,
) {
  const shown = chosen.length > 3 ? chosen.slice(0, 2) : chosen;
  const days = shown.map((t, i) => {
    const before = shown[i - 1];
    // A day in the same month as the one before it is its number alone
    return before != null && before.date.slice(0, 7) === t.date.slice(0, 7)
      ? String(Number(t.date.slice(8)))
      : shortDay(t.date, today);
  });
  if (chosen.length > 3) days.push(`${chosen.length - 2} more`);
  const listed = days.length === 1 ? days[0] : `${days.slice(0, -1).join(', ')} and ${days.at(-1)}`;
  const payee = sharedPayee(chosen);
  return `${payee == null ? '' : `${payee}, `}${listed} · now in ${nowIn(chosen, name)}`;
}

const leftText = (cents: number, currency: string) =>
  cents < 0 ? `${formatMoney(-cents, currency)} over` : `${formatMoney(cents, currency)} left`;

/**
 * What moving `movedCents` into a category does to its budget this month: "Food budget:
 * RM 312.50 → RM 291.75 left", "Groceries has no budget"
 */
export function budgetEffect(
  name: string,
  budget: { leftCents: number } | null,
  movedCents: number,
  currency: string,
) {
  if (budget == null) return `${name} has no budget`;
  const before = budget.leftCents;
  if (movedCents === 0) return `${name} budget: ${leftText(before, currency)}`;
  const after = before - movedCents;
  return before >= 0 && after >= 0
    ? `${name} budget: ${formatMoney(before, currency)} → ${leftText(after, currency)}`
    : `${name} budget: ${leftText(before, currency)} → ${leftText(after, currency)}`;
}
