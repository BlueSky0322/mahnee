import type {
  Account,
  Category,
  LedgerChange,
  NewTransaction,
  PayeeCategory,
  Transaction,
} from '@shared/api';
import type { CategoryKind } from '@shared/categories';
import { DEFAULT_CATEGORIES, MAX_CATEGORIES } from '@shared/categories';
import type { BankRow, Comparable, ExportRow, Read, Shortened } from '@shared/csv-import';
import { looksSaved, payeeKey } from '@shared/csv-import';
import type { AccountKind } from '@shared/ledger';
import { MAX_ACCOUNTS, balanceEffect, whyNotBetween } from '@shared/ledger';
import { newId } from '../../utils/id';

// What importing a file would do, worked out before anything is saved, for the preview to
// show: each row as the transaction it would add (or why it can't), whether it looks
// already saved, and for Mahnee's own export the accounts and categories it would add and
// the opening balances it differs on. The changes are made from it only once the person
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
  /** What it would add; null when it can't be */
  transaction: NewTransaction | null;
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

/**
 * Mahnee's own export: its accounts by name (those the person lacks are added, with the
 * file's opening balance), its categories by kind, name and parent (added when missing),
 * and each transaction as it was. An archived category matched falls back to Other.
 */
export function planExport(
  rows: Read<ExportRow>[],
  accounts: readonly Account[],
  categories: readonly Category[],
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
  for (const r of rows) {
    if (r.problem !== undefined) {
      planned.push(skipped(r.row, r.problem));
      continue;
    }
    if (r.kind === 'opening') continue;
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
  return { ...plan, rows: plan.rows.map((r) => ({ ...r, looksSaved: marked.get(r) ?? false })) };
}

/**
 * The changes importing makes, in order: accounts added (each of the kind asked), opening
 * balances ticked, categories the ticked rows need (parents first), then each ticked row
 * with its category as picked
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
  const used = new Set(transactions.map((t) => t.categoryId));
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
  ];
}
