// What the API sends back, in one place: the Worker builds these and the app reads
// them, so a field changed on one side fails to compile on the other.

import type { CategoryKind } from './categories';
import type { AccountKind, TransactionKind } from './ledger';
import type { RateSource } from './rates';

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
 * Money spent from one of a person's accounts, or that came into it. An amount is always
 * above zero; the kind says which way it went.
 */
export interface Transaction {
  id: string;
  kind: TransactionKind;
  accountId: string;
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

/** What a transaction is given when it's added: all of it but when it was saved */
export type NewTransaction = Omit<Transaction, 'createdAt'>;

/**
 * GET /api/accounts: the person's ledger, archived accounts and categories too, each in
 * the person's order. Categories are only what's saved: none until the first change,
 * which saves the defaults (categoriesOrDefaults in shared/categories.ts).
 */
export interface Ledger {
  accounts: Account[];
  categories: Category[];
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
   * Changes what it names. A kind changes only between spending and income, with a
   * category of the new kind.
   */
  | ({ op: 'updateTransaction'; id: string } & Partial<Omit<NewTransaction, 'id'>>)
  /** Deletes it for good; Undo adds it again, with the same id */
  | { op: 'removeTransaction'; id: string };

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

/** A row the app makes before it's saved: 16 hex characters */
export const ROW_ID_CHARS = '[0-9a-f]{16}';
const ROW_ID_PATTERN = new RegExp(`^${ROW_ID_CHARS}$`);
export const isRowId = (v: unknown): v is string => typeof v === 'string' && ROW_ID_PATTERN.test(v);

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
