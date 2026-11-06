// What the API sends back, in one place: the Worker builds these and the app reads
// them, so a field changed on one side fails to compile on the other.

import type { CategoryKind } from './categories';
import type { AccountKind, TransactionKind } from './ledger';
import type { RateSource } from './rates';
import type { Schedule } from './recurring';

// ---------- Account ----------

export const THEMES = ['dark', 'light', 'auto'] as const;
export const ACCENTS = ['blurple', 'blue', 'teal', 'green', 'amber', 'rose'] as const;
/** Where an account's exchange rates come from first (see RATE_PROVIDERS) */
export const RATE_PREFERENCES = ['wise', 'ecb'] as const;

export type ThemeSetting = (typeof THEMES)[number];
export type Accent = (typeof ACCENTS)[number];
export type RatePreference = (typeof RATE_PREFERENCES)[number];

/** The longest display name an account can have */
export const MAX_DISPLAY_NAME = 32;

/** Private preferences that follow the account between devices */
export interface Settings {
  theme: ThemeSetting;
  accent: Accent;
  ratePreference: RatePreference;
}

/** Settings before anyone changes them */
export const DEFAULT_SETTINGS: Settings = {
  theme: 'auto',
  accent: 'blurple',
  ratePreference: 'wise',
};

/** The signed-in account and its private settings */
export interface Profile {
  email: string;
  displayName: string | null;
  settings: Settings;
}

export interface ProfilePatch {
  displayName?: string | null;
  settings?: Partial<Settings>;
}

// ---------- Rates ----------

/** A fetched rate (never a typed one) */
export type FetchedRateSource = Exclude<RateSource, 'manual'>;

/** The service each rate preference stands for: the ECB's rates come from Frankfurter */
export const RATE_PROVIDERS: Record<RatePreference, FetchedRateSource> = {
  wise: 'wise',
  ecb: 'frankfurter',
};

/** GET /api/rates: one currency into another */
export interface RateQuote {
  from: string;
  to: string;
  rate: number;
  source: FetchedRateSource;
  /** When it was fetched; for an earlier day's rate (?at=), noon UTC on that day */
  fetchedAt: number;
  /** The amount asked about (?amount=), converted */
  convertedCents?: number;
}

// ---------- Ledger ----------

/** One of a person's accounts: where their money is, or what they owe on a card */
export interface Account {
  id: string;
  name: string;
  kind: AccountKind;
  /** Its currency, MYR for now */
  currency: string;
  /** What it held when tracking began; below zero for what's owed on a card */
  openingCents: number;
  /** What it holds now, worked out by the server; below zero when owed */
  balanceCents: number;
  /** Its place in the person's list, first at 0 */
  position: number;
  /** Taken out of the list, never deleted; it can be brought back */
  archived: boolean;
}

/**
 * What a person's spending and income is sorted into. A subcategory names its parent,
 * a top-level category, and is that parent's kind (shared/categories.ts).
 */
export interface Category {
  id: string;
  name: string;
  kind: CategoryKind;
  /** The category it sits under; null at the top level */
  parentId: string | null;
  /** Its place among the categories beside it (same kind and parent), first at 0 */
  position: number;
  /** Taken out of the list, never deleted; it can be brought back */
  archived: boolean;
}

/**
 * Money spent from one of a person's accounts, money that came into it, or money moved
 * from it to another of theirs (a transfer). An amount is always above zero; the kind
 * says which way it went.
 */
export interface Transaction {
  id: string;
  kind: TransactionKind;
  /** The account it's on; for a transfer, the one the money left */
  accountId: string;
  /**
   * The account a transfer's money went to, never the one it left; null for spending and
   * income
   */
  toAccountId: string | null;
  /** Whole cents, above zero, at most MAX_TRANSACTION_CENTS */
  amountCents: number;
  /** A category of the matching kind, top level or a subcategory; null only for transfers */
  categoryId: string | null;
  /** Who was paid, or who paid; null when not said */
  payee: string | null;
  note: string | null;
  /** The person's own calendar day it happened on, as 2026-11-05 */
  date: string;
  /** When the server saved it (ms), which orders transactions on the same day */
  createdAt: number;
}

/**
 * GET /api/transactions: one page of transactions, newest first (by day, then when
 * saved). nextBefore asks for the next page (?before=), and is null on the last one; it
 * means nothing to the app beyond that.
 */
export interface TransactionPage {
  transactions: Transaction[];
  nextBefore: string | null;
}

/** What was spent in one category, or received in one, over a month */
export interface CategoryTotal {
  /** The category the transactions name: a subcategory's own id, not its parent's */
  categoryId: string;
  /** Whole cents, above zero */
  cents: number;
}

/**
 * A month's budget on a top-level spending category (shared/budgets.ts): the amount set for
 * the month, whether last month's leftover carries over, and what last month left
 */
export interface MonthBudget {
  categoryId: string;
  /** Whole cents, above zero, at most MAX_TRANSACTION_CENTS */
  amountCents: number;
  /** Last month's leftover is added to this month's amount (its overspending taken away) */
  carryOver: boolean;
  /**
   * What the month before left of this category's budget, its own carried amount included,
   * less what was spent in it (subcategories included); below zero when overspent, 0 when
   * that month had no budget. Carried in only when carryOver is on.
   */
  lastMonthLeftCents: number;
}

/**
 * GET /api/summary: what a person spent and received in a month (2026-11), across every
 * account, worked out by the server. Only spending and income count; a transfer moves
 * money between the person's own accounts, so it is never spending. Each list holds
 * only categories with something in them, largest first.
 */
export interface MonthSummary {
  month: string;
  incomeCents: number;
  spentCents: number;
  /** Received less spent; below zero when more was spent than came in */
  leftCents: number;
  spentByCategory: CategoryTotal[];
  incomeByCategory: CategoryTotal[];
  /**
   * The month's budgets, in the categories' order, on categories at the top level now;
   * only when there are any. What's left of each is worked out where it's shown
   * (budgetFigures in shared/budgets.ts), from the spending as shown.
   */
  budgets?: MonthBudget[];
  /**
   * Of the change ids the read named (PENDING_CHANGES_HEADER), the ones counted in already;
   * only when it named any
   */
  alreadySaved?: string[];
}

/**
 * GET /api/export/summary: what the export file (GET /api/export) holds, so the app can
 * say so before it's downloaded. Accounts and categories are every one the person has,
 * archived ones too.
 */
export interface ExportSummary {
  /** Every transaction of the person's, on every account */
  transactions: number;
  /** The day of the earliest and of the latest (2026-01-03); null with none */
  firstDate: string | null;
  lastDate: string | null;
  accounts: number;
  categories: number;
}

/** The category a payee was last filed under, for spending or for income */
export interface PayeeCategory {
  /** As it was last written */
  payee: string;
  kind: CategoryKind;
  categoryId: string;
}

/**
 * GET /api/payee-categories?account=<id>: each payee's latest category, per kind, payees
 * compared trimmed and ignoring case; what was filed on that account comes first, then the
 * person's other accounts. Newest first, at most MAX_PAYEE_CATEGORIES.
 */
export interface PayeeCategories {
  payees: PayeeCategory[];
}

/** The most payees GET /api/payee-categories answers with, the latest filed first */
export const MAX_PAYEE_CATEGORIES = 10_000;

/** What a transaction is given when it's added: all of it but when it was saved */
export type NewTransaction = Omit<Transaction, 'createdAt'>;

/**
 * A bill or income that repeats, monthly or weekly (shared/recurring.ts), and what Log it
 * records each time: nothing is recorded until the person logs it. Stopped (archived), never
 * deleted.
 */
export interface Recurring {
  id: string;
  kind: TransactionKind;
  /** The account it's on; for a transfer, the one the money leaves */
  accountId: string;
  /** Where a transfer goes; null for spending and income */
  toAccountId: string | null;
  /** Whole cents, above zero, at most MAX_TRANSACTION_CENTS */
  amountCents: number;
  /** A category of its kind; null only for a transfer */
  categoryId: string | null;
  payee: string | null;
  schedule: Schedule;
  /** 1 to 31 for monthly (the month's last day when shorter), 1 (Monday) to 7 for weekly */
  day: number;
  /** The day it was set up from, as 2026-11-05 */
  startDate: string;
  /** The next occurrence not yet logged or skipped, as 2026-12-05; falls on its schedule */
  nextDue: string;
  /** Stopped repeating; it can be brought back */
  archived: boolean;
}

/** What a repeating item is given when it's set up: its first due date is worked out */
export type NewRecurring = Omit<Recurring, 'nextDue' | 'archived'>;

/**
 * GET /api/accounts: the person's ledger, archived accounts and categories too, each in
 * the person's order. Categories are only what's saved: none until the first change,
 * which saves the defaults (categoriesOrDefaults in shared/categories.ts).
 */
export interface Ledger {
  accounts: Account[];
  categories: Category[];
  /**
   * Bills and income that repeat, stopped ones too, in the order they were set up; only
   * when the person has any
   */
  recurring?: Recurring[];
  /**
   * Of the change ids the read named (PENDING_CHANGES_HEADER), the ones these balances
   * hold already; only when it named any
   */
  alreadySaved?: string[];
}

/**
 * One change to the ledger, as the app makes it and POST /api/changes saves it. An
 * account's or category's kind is fixed once it's added.
 */
export type LedgerChange =
  | {
      op: 'addAccount';
      account: { id: string; name: string; kind: AccountKind; openingCents: number };
    }
  | { op: 'updateAccount'; id: string; name?: string; openingCents?: number }
  /** archived: true takes it out of the list, false brings it back */
  | { op: 'archiveAccount'; id: string; archived: boolean }
  /** parentId: the top-level category it goes under, of the same kind; null for top level */
  | {
      op: 'addCategory';
      category: { id: string; name: string; kind: CategoryKind; parentId: string | null };
    }
  /**
   * parentId moves it (last among its new siblings; null to the top level), and position
   * puts it at that place among its siblings, counted without it, after any move
   */
  | { op: 'updateCategory'; id: string; name?: string; parentId?: string | null; position?: number }
  | { op: 'archiveCategory'; id: string; archived: boolean }
  | { op: 'addTransaction'; transaction: NewTransaction }
  /**
   * Changes what it names. A new kind comes with what that kind needs: spending or
   * income a category of its kind and toAccountId null, a transfer categoryId null and
   * the account it goes to.
   */
  | ({ op: 'updateTransaction'; id: string } & Partial<Omit<NewTransaction, 'id'>>)
  /** Deletes it for good; Undo adds it again, with the same id */
  | { op: 'removeTransaction'; id: string }
  /**
   * Moves up to MAX_BULK_TRANSACTIONS spending or income transactions (each once) into one
   * category of their kind, all or none. Undo is one of these per category they came from.
   */
  | { op: 'recategoriseTransactions'; ids: string[]; categoryId: string }
  /**
   * Deletes up to MAX_BULK_TRANSACTIONS transactions (each once) for good, all or none; Undo
   * adds each again, with its own id
   */
  | { op: 'removeTransactions'; ids: string[] }
  /**
   * A top-level spending category's monthly budget from `fromMonth` (2026-11) on, replacing
   * what was set for it from any later month; null takes it away from that month on
   */
  | {
      op: 'setBudget';
      categoryId: string;
      fromMonth: string;
      amountCents: number | null;
      carryOver: boolean;
    }
  /** Sets one up; it's first due on its schedule's next day after startDate */
  | { op: 'addRecurring'; recurring: NewRecurring }
  /**
   * Changes what it records or when it falls; its kind is fixed. A new schedule or day comes
   * with nextDue, which falls on it; nextDue alone moves it (Undo of a log or a skip).
   */
  | ({ op: 'updateRecurring'; id: string } & Partial<
      Pick<
        Recurring,
        | 'accountId'
        | 'toAccountId'
        | 'amountCents'
        | 'categoryId'
        | 'payee'
        | 'schedule'
        | 'day'
        | 'nextDue'
      >
    >)
  /** archived: true stops it repeating, false brings it back */
  | { op: 'archiveRecurring'; id: string; archived: boolean }
  /**
   * Records the occurrence due on `due` (its next due date, else refused) as `transaction`,
   * on that day, and moves it on to the next, together
   */
  | { op: 'logRecurring'; id: string; due: string; transaction: NewTransaction }
  /** Moves the occurrence due on `due` (its next due date, else refused) on, recording nothing */
  | { op: 'skipRecurring'; id: string; due: string };

/** POST /api/changes: saved in order, all or nothing */
export interface ChangesBody {
  changes: LedgerChange[];
  /**
   * The id the app gave each change (isRowId), one each in order: a change sent again
   * after its answer was lost then counts once, and an id sent with a different change
   * is refused
   */
  ids: string[];
}

/**
 * The most changes one request may carry; the app sends a longer queue in several, in
 * order. web/public/sw.js keeps its own copy (sw.test.ts checks they agree).
 */
export const MAX_CHANGES = 200;

/**
 * The most bytes of JSON one request of changes may carry; a single change bigger than
 * this still goes, on its own. It keeps a request under the 64 KB browsers allow one
 * that finishes after the page closes, and well under the Worker's 256 KB limit.
 * web/public/sw.js keeps its own copy (sw.test.ts checks they agree).
 */
export const MAX_CHANGES_BYTES = 48 * 1024;

// ---------- Requests ----------

/** The header a request names its tab in */
export const CLIENT_ID_HEADER = 'X-Client-Id';

/**
 * Whose a write is: the account it was made as, which the server checks against the one
 * signed in now before changing anything. Never chooses who's signed in.
 */
export const EXPECTED_ACCOUNT_HEADER = 'X-Expected-Account';

/**
 * On a read of balances or a month's totals (GET /api/accounts, /api/summary): the ids of
 * changes the app still has waiting that may have been saved already (sent, but the answer
 * never came), comma-separated, at most MAX_CHANGES (about 3.4 KB). The answer's
 * `alreadySaved` says which of them it holds, read together with the figures, so the app
 * never counts one of them on top a second time.
 */
export const PENDING_CHANGES_HEADER = 'X-Pending-Changes';

/** A row the app makes before it's saved: 16 hex characters */
export const ROW_ID_CHARS = '[0-9a-f]{16}';
const ROW_ID_PATTERN = new RegExp(`^${ROW_ID_CHARS}$`);
export const isRowId = (v: unknown): v is string => typeof v === 'string' && ROW_ID_PATTERN.test(v);

/**
 * The change ids a PENDING_CHANGES_HEADER names: none when it's missing or empty, null when
 * it isn't up to MAX_CHANGES row ids
 */
export function readPendingIds(header: string | null | undefined): string[] | null {
  if (header == null || header === '') return [];
  const ids = header.split(',');
  return ids.length <= MAX_CHANGES && ids.every(isRowId) ? ids : null;
}

// ---------- Writes ----------

/** What a change that returns nothing else sends back */
export interface Ok {
  ok: true;
}

/** What every refused or failed request sends back */
export interface ApiErrorBody {
  error: string;
  /** What went wrong, for the app to act on, where the status alone doesn't say */
  code?: ErrorCode;
}

/**
 * account_mismatch: the write was made for another account than the one signed in now,
 * so it's kept (not sent again) until that account is back. client_update_required: an
 * app too old to say whose a write is; kept until it updates.
 */
export type ErrorCode = 'account_mismatch' | 'client_update_required';
