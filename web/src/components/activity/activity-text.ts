import type { Account, Category, SearchTotals, Transaction } from '@shared/api';
import type { TransactionKind } from '@shared/ledger';
import { periodMonthOf, periodOf, shiftMonth } from '@shared/period';
import { foldCase, isCalendarDay } from '@shared/search';
import { clockText, fromDateInput, monthHeading, toDateInput } from '../../utils/date-input';
import { currencySymbol, formatAmount, formatMoney } from '../../utils/money';
import { categoryName } from '../common/category-name';
import { scheduledNote } from '../common/scheduled-note';
import { leavesOutCount } from '../common/typed-amount';

// Activity's words (R-Activity, R-Activity-Select, R-Activity-Move, R-Desk-Activity,
// R-Desk-Bulk, R-Empty-Search). Amounts say which way the money went (R-System): spending
// has a minus, income a plus, and a transfer no sign, since it's neither.

// ---------- Amounts ----------

/** How a list signs each kind */
export const SIGNS: Record<TransactionKind, string> = { expense: '−', income: '+', transfer: '' };

/** In a list, without the currency: "−7.25", "+3,250.00", a transfer's "75.00" */
export const listAmount = (t: Transaction, currency: string) =>
  `${SIGNS[t.kind]}${formatAmount(t.amountCents, currency)}`;

/** What comes before a headline's figure: "−RM", "+RM", a transfer's "RM" */
export const headlinePrefix = (kind: TransactionKind, currency: string) =>
  `${SIGNS[kind]}${currencySymbol(currency)}`;

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
  selecting?: { category: string | null } | null,
  partial = false,
) {
  // Counted from what this device holds, which isn't every day asked for
  const where = partial ? ' on this device' : '';
  if (selecting != null) {
    return `${found.entries} found${where}${selecting.category == null ? '' : ` in ${selecting.category}`}`;
  }
  const parts = [`${found.entries} found${where}`];
  if (found.spentCents > 0) parts.push(`${formatMoney(found.spentCents, currency)} spent`);
  if (found.receivedCents > 0) parts.push(`${formatMoney(found.receivedCents, currency)} received`);
  return parts.join(' · ');
}

/**
 * Offline, when the history on this device doesn't hold every day asked for, checked:
 * "Showing Oct 1 to Nov 20. Older entries aren't on this device yet.", from the first day
 * it holds whole (`held`, null for none) to the last asked for (today when not said). While
 * the older entries are held but being checked again (`refreshing`): "Checked from Oct 1 to
 * Nov 20. Older entries are being refreshed and may be out of date." Held in full, it says
 * when it was last checked ("Checked Nov 20."), or that that was too long ago ("Not checked
 * since Nov 12. Entries may be out of date."); null when there's nothing to say.
 */
export function onDeviceLine(
  {
    complete,
    expired,
    checkedAt,
    from: held,
    refreshing,
  }: {
    complete: boolean;
    expired: boolean;
    checkedAt: number | null;
    from: string | null;
    refreshing: boolean;
  },
  looked: Period,
  today: string,
): string | null {
  // Held in full: when it was last checked against the server, "Checked Nov 20."
  const checked = checkedAt == null ? null : shortDay(toDateInput(new Date(checkedAt)), today);
  if (complete) return checked == null ? null : `Checked ${checked}.`;
  // Held in full, but too long ago for anything to have refreshed it offline
  if (expired) {
    return checked == null
      ? 'Entries may be out of date.'
      : `Not checked since ${checked}. Entries may be out of date.`;
  }
  const from = held != null && looked.from != null && looked.from > held ? looked.from : held;
  const to = looked.to != null && looked.to < today ? looked.to : today;
  const whole = from != null && from <= to;
  if (refreshing) {
    return whole
      ? `Checked from ${shortDay(from, today)} to ${shortDay(to, today)}. Older entries are being refreshed and may be out of date.`
      : 'These entries are being refreshed and may be out of date.';
  }
  if (!whole) return "Entries for these days aren't on this device yet.";
  return `Showing ${shortDay(from, today)} to ${shortDay(to, today)}. Older entries aren't on this device yet.`;
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
 * accounts), then whether it came from Scheduled. A note the words found shows in place of
 * the category; while selecting, the day is added.
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
  subtitle = `${subtitle}${scheduledNote(t)}`;
  if (selecting) subtitle = `${subtitle} · ${shortDay(t.date, today)}`;
  if (t.time != null) subtitle = `${subtitle} · ${clockText(t.time)}`;
  return { title, subtitle };
}

// ---------- Changing many ----------

/** The payee every one of them shares, or null */
const sharedPayee = (chosen: readonly Transaction[]) => {
  const payee = chosen[0]?.payee ?? null;
  return payee != null && chosen.every((t) => t.payee === payee) ? payee : null;
};

/** What a selection adds up to: spending, income and their net, in whole cents */
export interface Picked {
  /** Every kind counted, transfers too */
  entries: number;
  spentCents: number;
  receivedCents: number;
  /** What came in less what went out */
  netCents: number;
  /** Transfers between the person's own accounts, which are neither and aren't counted */
  transfers: number;
  /** Entries typed offline still waiting for a rate, counted as nothing until converted */
  waiting: number;
  /** The payee every one of them shares, or null */
  payee: string | null;
}

/**
 * What the ticked entries add up to, in the main currency: one typed in another currency
 * at what it came to (`amountCents`), as every total counts it. The rows are those loaded,
 * at most MAX_ACCOUNTS x MAX_TRANSACTIONS_PER_ACCOUNT of at most MAX_TRANSACTION_CENTS,
 * so every sum stays a safe whole number of cents.
 */
export function pickedOf(chosen: readonly Transaction[]): Picked {
  let spentCents = 0;
  let receivedCents = 0;
  let transfers = 0;
  let waiting = 0;
  for (const t of chosen) {
    if (t.original?.pending) waiting++;
    if (t.kind === 'expense') spentCents += t.amountCents;
    else if (t.kind === 'income') receivedCents += t.amountCents;
    else transfers++;
  }
  return {
    entries: chosen.length,
    spentCents,
    receivedCents,
    netCents: receivedCents - spentCents,
    transfers,
    waiting,
    payee: sharedPayee(chosen),
  };
}

/** "+RM 29.25", "−RM 30.90", "RM 0.00" */
export const signedMoney = (cents: number, currency: string) =>
  `${cents > 0 ? '+' : cents < 0 ? '−' : ''}${formatMoney(cents, currency)}`;

const transfersText = (n: number) => `${n} ${n === 1 ? 'transfer' : 'transfers'} not counted`;

/**
 * The selection in a line: "3 selected · Net −RM 42.50", then what the net leaves out:
 * "· 1 transfer not counted", "· 1 waiting for a rate"
 */
export function pickedLine(p: Picked, currency: string) {
  const parts = [`${p.entries} selected`, `Net ${signedMoney(p.netCents, currency)}`];
  if (p.transfers > 0) parts.push(transfersText(p.transfers));
  if (p.waiting > 0) parts.push(`${p.waiting} waiting for a rate`);
  return parts.join(' · ');
}

/** The selection's breakdown: expenses, income, net, then what to know about them */
export function pickedParts(p: Picked, currency: string) {
  const notes: string[] = [];
  if (p.transfers > 0) notes.push(transfersText(p.transfers));
  const waiting = leavesOutCount(p.waiting);
  if (waiting != null) notes.push(waiting);
  if (p.payee != null) notes.push(`All ${p.payee}`);
  return {
    expenses: formatMoney(p.spentCents, currency),
    income: formatMoney(p.receivedCents, currency),
    net: signedMoney(p.netCents, currency),
    notes,
  };
}

/** What a screen reader says once a selection settles: "3 selected. Net −RM 42.50" */
export function pickedSaid(p: Picked, currency: string) {
  if (p.entries === 0) return '';
  const said = [`${p.entries} selected`, `Net ${signedMoney(p.netCents, currency)}`];
  if (p.transfers > 0) said.push(transfersText(p.transfers));
  return said.join('. ');
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
