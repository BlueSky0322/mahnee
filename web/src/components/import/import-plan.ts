import type {
  Account,
  Category,
  LedgerChange,
  NewRecurring,
  NewTransaction,
  PayeeCategory,
  Recurring,
  Transaction,
} from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import { DEFAULT_CATEGORIES, MAX_CATEGORIES } from '@shared/categories';
import type { BankRow, Comparable, ExportRow, Read, Shortened } from '@shared/csv-import';
import { looksSaved, payeeKey } from '@shared/csv-import';
import type { AccountKind, TransactionKind } from '@shared/ledger';
import { MAX_ACCOUNTS, balanceEffect, whyNotBetween } from '@shared/ledger';
import { MAX_RECURRING, nextAfter } from '@shared/recurring';
import { newId } from '../../utils/id';

// What importing a file would do, worked out before anything is saved, for the preview to
// show: each row as the transaction it would add (or why it can't), whether it looks
// already saved, and for Mahnee's own export the accounts and categories it would add, the
// opening balances it differs on and the repeating items it would set up again. The changes are made from it only once the person
// says Import (importChanges), all through the ledger's change().

/** A row of the file as it would be imported */
export interface PlannedRow {
  row: number;
  /** Why it can't be imported; it can't be ticked */
  problem: string | null;
  /** The same account, day, amount and payee as one saved: left unticked */
  looksSaved: boolean;
  /** What was cut to fit */
  shortened: Shortened[];
  /** What it would add; null when it can't be, or when it's a repeating item */
  transaction: NewTransaction | null;
  /** From an export's Repeating line: the repeating item it would set up, first due on nextDue */
  recurring?: NewRecurring & { nextDue: string };
  /** From an export: the names the file gives ("Food › Coffee"), for showing */
  names?: { account: string; toAccount: string | null; category: string | null };
}

/** An account the file names that the person doesn't have yet */
export interface NewAccount {
  id: string;
  name: string;
  openingCents: number;
}

/** An account whose opening balance in the file differs from the one it has */
export interface OpeningChange {
  accountId: string;
  name: string;
  fromCents: number;
  toCents: number;
}

export interface Plan {
  source: 'bank' | 'export';
  rows: PlannedRow[];
  newAccounts: NewAccount[];
  openings: OpeningChange[];
  /** Categories to add, a parent before its subcategories */
  newCategories: { id: string; name: string; kind: CategoryKind; parentId: string | null }[];
  /** Why the whole file can't be imported */
  problem: string | null;
}

/**
 * New ids for a file's transactions, rising in the file's order: one random prefix and a
 * count, so rows on the same day keep the file's order when they're listed or exported
 */
function idsInOrder() {
  const prefix = newId().slice(0, 12);
  let n = 0;
  return () => `${prefix}${(n++).toString(16).padStart(4, '0')}`;
}

/** The listed category spending (or income) falls back to: Other (Other income), else the first */
export function otherCategory(categories: readonly Category[], kind: CategoryKind) {
  const listed = categories.filter((c) => c.kind === kind && !c.archived);
  const name = kind === 'income' ? 'Other income' : 'Other';
  const fixed = DEFAULT_CATEGORIES.find((c) => c.name === name)!.id;
  return (
    listed.find((c) => c.id === fixed) ??
    listed.find((c) => c.name === name && c.parentId == null) ??
    listed[0] ??
    null
  );
}

const skipped = (row: number, problem: string): PlannedRow => ({
  row,
  problem,
  looksSaved: false,
  shortened: [],
  transaction: null,
});

/**
 * A bank file's rows on `account`: money out as spending, money in as income, each in the
 * category its payee was last filed under (`filed`, newest first) while that's listed,
 * else Other or Other income
 */
export function planBankFile(
  rows: Read<BankRow>[],
  account: Account,
  categories: readonly Category[],
  filed: readonly PayeeCategory[],
): Plan {
  const listed = new Set(categories.filter((c) => !c.archived).map((c) => c.id));
  const lastFiled = new Map<string, string>();
  for (const f of filed) {
    const key = `${f.kind}|${payeeKey(f.payee)}`;
    if (!lastFiled.has(key) && listed.has(f.categoryId)) lastFiled.set(key, f.categoryId);
  }
  const nextId = idsInOrder();
  const planned = rows.map((r): PlannedRow => {
    if (r.problem !== undefined) return skipped(r.row, r.problem);
    const kind: CategoryKind = r.cents < 0 ? 'expense' : 'income';
    const categoryId =
      lastFiled.get(`${kind}|${payeeKey(r.payee)}`) ?? otherCategory(categories, kind)?.id;
    if (categoryId == null) return skipped(r.row, 'No category to put it in');
    return {
      row: r.row,
      problem: null,
      looksSaved: false,
      shortened: r.shortened ?? [],
      transaction: {
        id: nextId(),
        kind,
        accountId: account.id,
        toAccountId: null,
        amountCents: Math.abs(r.cents),
        categoryId,
        payee: r.payee,
        note: r.note,
        date: r.date,
      },
    };
  });
  return {
    source: 'bank',
    rows: planned,
    newAccounts: [],
    openings: [],
    newCategories: [],
    problem: null,
  };
}

/** What a repeating item is compared by, to see whether it's set up already: the owner's list */
const sameDetails = (
  r: Pick<Recurring, 'accountId' | 'kind' | 'amountCents' | 'schedule' | 'day' | 'payee'>,
) => `${r.accountId}|${r.kind}|${r.amountCents}|${r.schedule}|${r.day}|${payeeKey(r.payee)}`;

/** Whether a row adds something: a transaction or a repeating item */
export const adds = (r: PlannedRow) => r.transaction != null || r.recurring != null;

/**
 * Mahnee's own export: its accounts by name (those the person lacks are added, with the
 * file's opening balance), its categories by kind, name and parent (added when missing),
 * and each transaction as it was. An archived category matched falls back to Other.
 *
 * Each Repeating line sets its item up again, on an account the person has or the file
 * adds, first due on the file's next due date, or the next after `today` (the person's own
 * day) when that has passed. One with the same account, kind, amount, schedule, day and
 * payee as one still running looks already saved (each running one answers for one line;
 * stopped ones never count). Past MAX_RECURRING, stopped ones counted, a line says so.
 */
export function planExport(
  rows: Read<ExportRow>[],
  accounts: readonly Account[],
  categories: readonly Category[],
  recurring: readonly Recurring[],
  today: string,
): Plan {
  const newAccounts: NewAccount[] = [];
  const openings: OpeningChange[] = [];
  const newCategories: Plan['newCategories'] = [];
  // Listed ones first, so an archived account of the same name is only used if it's the only one
  const byName = new Map<string, Account | NewAccount>();
  for (const a of [...accounts].sort((x, y) => Number(x.archived) - Number(y.archived))) {
    if (!byName.has(a.name)) byName.set(a.name, a);
  }
  const accountFor = (name: string, openingCents = 0) => {
    const found = byName.get(name);
    if (found != null) return found;
    const added = { id: newId(), name, openingCents };
    newAccounts.push(added);
    byName.set(name, added);
    return added;
  };
  // Opening balances first, so accounts are added in the file's order
  for (const r of rows) {
    if (r.problem !== undefined || r.kind !== 'opening') continue;
    const had = byName.get(r.account);
    if (had == null) accountFor(r.account, r.cents);
    else if ('balanceCents' in had && had.openingCents !== r.cents) {
      if (!openings.some((o) => o.accountId === had.id)) {
        openings.push({
          accountId: had.id,
          name: had.name,
          fromCents: had.openingCents,
          toCents: r.cents,
        });
      }
    }
  }

  const known = [...categories];
  const categoryFor = (kind: CategoryKind, name: string | null, parentName: string | null) => {
    if (name == null) return otherCategory(known, kind)?.id ?? null;
    const find = (n: string, parentId: string | null) => {
      const alike = known.filter((c) => c.kind === kind && c.name === n && c.parentId === parentId);
      return alike.find((c) => !c.archived) ?? alike[0];
    };
    let parentId: string | null = null;
    if (parentName != null) {
      const parent = find(parentName, null);
      if (parent?.archived) return otherCategory(known, kind)?.id ?? null;
      if (parent == null) {
        const added = { id: newId(), name: parentName, kind, parentId: null };
        newCategories.push(added);
        known.push({ ...added, position: 0, archived: false });
        parentId = added.id;
      } else parentId = parent.id;
    }
    const found = find(name, parentId);
    if (found?.archived) return otherCategory(known, kind)?.id ?? null;
    if (found != null) return found.id;
    const added = { id: newId(), name, kind, parentId };
    newCategories.push(added);
    known.push({ ...added, position: 0, archived: false });
    return added.id;
  };

  const nextId = idsInOrder();
  const planned: PlannedRow[] = [];
  // Repeating lines are planned once every account the file adds is known
  const repeatingAt: [
    number,
    ExportRow & { row: number; kind: TransactionKind; repeat: NonNullable<ExportRow['repeat']> },
  ][] = [];
  for (const r of rows) {
    if (r.problem !== undefined) {
      planned.push(skipped(r.row, r.problem));
      continue;
    }
    if (r.kind === 'opening') continue;
    if (r.repeat != null) {
      repeatingAt.push([planned.length, { ...r, kind: r.kind, repeat: r.repeat }]);
      planned.push(skipped(r.row, ''));
      continue;
    }
    const from = accountFor(r.account);
    const to = r.toAccount == null ? null : accountFor(r.toAccount);
    const archived = [from, to].find((a) => a != null && 'archived' in a && a.archived);
    const category =
      r.category == null || r.parentCategory == null
        ? r.category
        : `${r.parentCategory} › ${r.category}`;
    const names = { account: r.account, toAccount: r.toAccount, category };
    if (archived != null) {
      planned.push({ ...skipped(r.row, `${archived.name} is archived`), names });
      continue;
    }
    const between = to == null ? null : whyNotBetween(from.id, to.id);
    if (between != null) {
      planned.push({ ...skipped(r.row, between), names });
      continue;
    }
    const categoryId =
      r.kind === 'transfer' ? null : categoryFor(r.kind, r.category, r.parentCategory);
    if (r.kind !== 'transfer' && categoryId == null) {
      planned.push({ ...skipped(r.row, 'No category to put it in'), names });
      continue;
    }
    planned.push({
      row: r.row,
      problem: null,
      looksSaved: false,
      shortened: [],
      names,
      transaction: {
        id: nextId(),
        kind: r.kind,
        accountId: from.id,
        toAccountId: to?.id ?? null,
        amountCents: r.cents,
        categoryId,
        payee: r.payee,
        note: r.note,
        date: r.date,
      },
    });
  }

  // Each running item answers for one line alike; past the limit, lines say so
  const running = new Map<string, number>();
  for (const r of recurring) {
    if (!r.archived) running.set(sameDetails(r), (running.get(sameDetails(r)) ?? 0) + 1);
  }
  let room = MAX_RECURRING - recurring.length;
  for (const [at, r] of repeatingAt) {
    const from = byName.get(r.account);
    const to = r.toAccount == null ? null : byName.get(r.toAccount);
    const category =
      r.category == null || r.parentCategory == null
        ? r.category
        : `${r.parentCategory} › ${r.category}`;
    const names = { account: r.account, toAccount: r.toAccount, category };
    const missing =
      from == null ? r.account : r.toAccount != null && to == null ? r.toAccount : null;
    if (from == null || missing != null) {
      planned[at] = {
        ...skipped(r.row, `${missing} is not an account here or in this file`),
        names,
      };
      continue;
    }
    const archived = [from, to].find((a) => a != null && 'archived' in a && a.archived);
    if (archived != null) {
      planned[at] = { ...skipped(r.row, `${archived.name} is archived`), names };
      continue;
    }
    const between = to == null ? null : whyNotBetween(from.id, to.id);
    if (between != null) {
      planned[at] = { ...skipped(r.row, between), names };
      continue;
    }
    const categoryId =
      r.kind === 'transfer' ? null : categoryFor(r.kind, r.category, r.parentCategory);
    if (r.kind !== 'transfer' && categoryId == null) {
      planned[at] = { ...skipped(r.row, 'No category to put it in'), names };
      continue;
    }
    const item = {
      id: newId(),
      kind: r.kind,
      accountId: from.id,
      toAccountId: to?.id ?? null,
      amountCents: r.cents,
      categoryId,
      payee: r.payee,
      schedule: r.repeat.schedule,
      day: r.repeat.day,
      startDate: today,
      // Passed: the next after today, as the weeks since are taken as handled
      nextDue: r.date >= today ? r.date : nextAfter(r.repeat.schedule, r.repeat.day, today),
    };
    const alike = running.get(sameDetails(item)) ?? 0;
    if (alike > 0) running.set(sameDetails(item), alike - 1);
    else if (room-- <= 0) {
      planned[at] = {
        ...skipped(
          r.row,
          `You can have up to ${MAX_RECURRING} repeating items, stopped ones included`,
        ),
        names,
      };
      continue;
    }
    planned[at] = {
      row: r.row,
      problem: null,
      looksSaved: alike > 0,
      shortened: [],
      names,
      transaction: null,
      recurring: item,
    };
  }

  const tooMany =
    accounts.length + newAccounts.length > MAX_ACCOUNTS
      ? `This file would make more than ${MAX_ACCOUNTS} accounts.`
      : categoriesOrNone(categories) + newCategories.length > MAX_CATEGORIES
        ? `This file would make more than ${MAX_CATEGORIES} categories.`
        : null;
  return {
    source: 'export',
    rows: planned,
    newAccounts,
    openings,
    newCategories,
    problem: tooMany,
  };
}

/** How many categories are saved, the defaults counted while none are */
const categoriesOrNone = (categories: readonly Category[]) =>
  Math.max(categories.length, DEFAULT_CATEGORIES.length);

/** What a transaction is compared by: its own account, and what it does to its balance */
const comparable = (t: Omit<Transaction, 'createdAt'>, accountId = t.accountId): Comparable => ({
  accountId,
  date: t.date,
  cents: balanceEffect(t, accountId),
  payee: t.payee,
});

/** Which accounts the plan adds transactions to that the person has already */
export const accountsToCheck = (plan: Plan) => {
  const added = new Set(plan.newAccounts.map((a) => a.id));
  return [
    ...new Set(
      plan.rows.flatMap((r) =>
        r.transaction == null || added.has(r.transaction.accountId)
          ? []
          : [r.transaction.accountId],
      ),
    ),
  ];
};

/** The earliest day the plan adds a transaction on, or null */
export const earliestDay = (plan: Plan) =>
  plan.rows.reduce<string | null>(
    (first, r) =>
      r.transaction != null && (first == null || r.transaction.date < first)
        ? r.transaction.date
        : first,
    null,
  );

/** The plan with each row that looks already saved (against `saved`, by account) marked */
export function markSaved(plan: Plan, saved: Map<string, Transaction[]>): Plan {
  const importable = plan.rows.filter((r) => r.transaction != null);
  const existing = [...saved].flatMap(([accountId, list]) =>
    list.map((t) => comparable(t, accountId)),
  );
  const marks = looksSaved(
    importable.map((r) => comparable(r.transaction!)),
    existing,
  );
  const marked = new Map(importable.map((r, i) => [r, marks[i]]));
  // A repeating item's row was marked as it was planned
  return {
    ...plan,
    rows: plan.rows.map((r) => ({ ...r, looksSaved: marked.get(r) ?? r.looksSaved })),
  };
}

/**
 * The changes importing makes, in order: accounts added (each of the kind asked), opening
 * balances ticked, categories the ticked rows need (parents first), then each ticked row
 * with its category as picked, then each ticked repeating item
 */
export function importChanges(
  plan: Plan,
  {
    ticked,
    categoryOf,
    kinds,
    openingsTicked,
  }: {
    ticked: ReadonlySet<number>;
    categoryOf: ReadonlyMap<number, string>;
    kinds: ReadonlyMap<string, AccountKind>;
    openingsTicked: ReadonlySet<string>;
  },
): LedgerChange[] {
  const rows = plan.rows.filter((r) => r.transaction != null && ticked.has(r.row));
  const transactions = rows.map((r) => {
    const t = r.transaction!;
    return { ...t, categoryId: categoryOf.get(r.row) ?? t.categoryId };
  });
  const repeating = plan.rows.flatMap((r) =>
    r.recurring != null && ticked.has(r.row) ? [r.recurring] : [],
  );
  const used = new Set([...transactions, ...repeating].map((t) => t.categoryId));
  for (const c of plan.newCategories) if (used.has(c.id) && c.parentId) used.add(c.parentId);
  return [
    ...plan.newAccounts.map(
      (a): LedgerChange => ({
        op: 'addAccount',
        account: { ...a, kind: kinds.get(a.id) ?? 'bank' },
      }),
    ),
    ...plan.openings
      .filter((o) => openingsTicked.has(o.accountId))
      .map(
        (o): LedgerChange => ({ op: 'updateAccount', id: o.accountId, openingCents: o.toCents }),
      ),
    ...plan.newCategories
      .filter((c) => used.has(c.id))
      .map((category): LedgerChange => ({ op: 'addCategory', category })),
    ...transactions.map((transaction): LedgerChange => ({ op: 'addTransaction', transaction })),
    ...repeating.map((recurring): LedgerChange => ({ op: 'addRecurring', recurring })),
  ];
}
