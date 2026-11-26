// What the API sends back, in one place: the Worker builds these and the app reads
// them, so a field changed on one side fails to compile on the other.

import type { CategoryKind } from './categories';
import type { AccountKind, TransactionKind } from './ledger';
import type { RateSource } from './rates';
import type { Schedule } from './recurring';

// ---------- Account ----------

export const THEMES = ['dark', 'light', 'auto'] as const;
/** The redesign's accents; every one is drawn cobalt until the accent setting is offered */
export const ACCENTS = ['cobalt', 'green', 'plum', 'rust', 'graphite'] as const;
/** Where an account's exchange rates come from first (see RATE_PROVIDERS) */
export const RATE_PREFERENCES = ['wise', 'ecb'] as const;
export const WEEK_STARTS = ['monday', 'sunday'] as const;
/** A month starts on a day of the month, or on the day a scheduled pay is due */
export const MONTH_START_MODES = ['date', 'payday'] as const;
export const START_SCREENS = ['home', 'activity', 'plan'] as const;
/** Home with the month end and what needs the person only, or everything */
export const HOME_DENSITIES = ['essentials', 'everything'] as const;
/** What Add asks for first */
export const START_WITH = ['amount', 'category'] as const;
/** Spending in ink or in red; income is always green */
export const EXPENSE_COLOURS = ['ink', 'red'] as const;

export type ThemeSetting = (typeof THEMES)[number];
export type Accent = (typeof ACCENTS)[number];
export type RatePreference = (typeof RATE_PREFERENCES)[number];
export type WeekStart = (typeof WEEK_STARTS)[number];
export type MonthStartMode = (typeof MONTH_START_MODES)[number];
export type StartScreen = (typeof START_SCREENS)[number];
export type HomeDensity = (typeof HOME_DENSITIES)[number];
export type StartWith = (typeof START_WITH)[number];
export type ExpenseColour = (typeof EXPENSE_COLOURS)[number];

/** The longest display name an account can have */
export const MAX_DISPLAY_NAME = 32;

/**
 * Private preferences that follow the account between devices. What each takes is in
 * shared/settings.ts.
 */
export interface Settings {
  /**
   * The home currency every amount is kept and shown in (one of HOME_CURRENCIES in
   * shared/rates.ts). Changing it converts every amount on the server (Profile.conversion).
   */
  currency: string;
  theme: ThemeSetting;
  accent: Accent;
  ratePreference: RatePreference;
  weekStart: WeekStart;
  monthStartMode: MonthStartMode;
  /** 1 to 28, or LAST_DAY_OF_MONTH (31) for each month's last day */
  monthStartDay: number;
  /**
   * The scheduled pay (a running monthly income) that payday follows; kept when the month
   * goes back to a date, and needed while it starts on payday
   */
  monthStartPayId: string | null;
  startScreen: StartScreen;
  homeDensity: HomeDensity;
  startWith: StartWith;
  /** The account Add starts on; null for the last one used */
  defaultAccountId: string | null;
  suggestAsYouType: boolean;
  /** Whether Add asks for a time of day */
  askForTime: boolean;
  expenseColour: ExpenseColour;
  /** Whether a new budget carries over */
  carryOverDefault: boolean;
  /** A reminder on days with nothing added, at reminderTime */
  dailyReminder: boolean;
  /** On the person's own clock, as 21:00 */
  reminderTime: string;
  /** How many days before a scheduled entry to remind, 1 to 7; null for not at all */
  scheduledReminderDays: number | null;
  /** The person's time zone as their device names it, sent by the app; null until then */
  timeZone: string | null;
  /**
   * The other currencies Add offers after the home one, in the person's order: at most
   * MAX_OTHER_CURRENCIES, each one of ENTRY_CURRENCIES (shared/rates.ts), each once
   */
  otherCurrencies: string[];
  /**
   * Whether Add opens in the currency of where the device is (or the one the last two
   * entries today were in) for the rest of that day, when it's one of otherCurrencies
   */
  travelSense: boolean;
}

/** Settings before anyone changes them: as the redesign's settings pages draw them */
export const DEFAULT_SETTINGS: Settings = {
  currency: 'MYR',
  theme: 'auto',
  accent: 'cobalt',
  ratePreference: 'wise',
  weekStart: 'monday',
  monthStartMode: 'date',
  monthStartDay: 1,
  monthStartPayId: null,
  startScreen: 'home',
  homeDensity: 'everything',
  startWith: 'amount',
  defaultAccountId: null,
  suggestAsYouType: true,
  askForTime: false,
  expenseColour: 'ink',
  carryOverDefault: true,
  dailyReminder: true,
  reminderTime: '21:00',
  scheduledReminderDays: 1,
  timeZone: null,
  otherCurrencies: [],
  travelSense: true,
};

/**
 * The limit that refused a change of currency: an entry's amount, an opening balance
 * (either way), a budget or a scheduled item's amount would have gone past
 * MAX_TRANSACTION in the new currency
 */
export const CONVERSION_LIMITS = ['amount', 'opening', 'budget', 'scheduled'] as const;
export type ConversionLimit = (typeof CONVERSION_LIMITS)[number];

/**
 * Why a change of currency was refused: a limit, or `rates` when it couldn't be finished
 * (the rate services stayed down through every try), so the person got their currency back
 */
export const CONVERSION_REFUSALS = [...CONVERSION_LIMITS, 'rates'] as const;
export type ConversionRefusal = (typeof CONVERSION_REFUSALS)[number];

/**
 * The latest change of home currency, while its amounts are converted (refused null), or
 * once it was refused, naming the limit, until the currency is changed again
 */
export interface Conversion {
  from: string;
  to: string;
  /** When the currency was changed, in ms */
  since: number;
  refused: ConversionRefusal | null;
  /**
   * While it's under way, how many of the person's transactions have been worked out so far
   * of how many there are, for the app to show how far it has got; missing otherwise, or
   * from a server or a copy from before it was said
   */
  progress?: { done: number; total: number };
}

/** Where the picture shown in place of the initial came from */
export const PICTURE_SOURCES = ['upload', 'google'] as const;
export type PictureSource = (typeof PICTURE_SOURCES)[number];

/** The picture shown in place of the initial, served at pictureAddress() */
export interface ProfilePicture {
  /** One the person chose, or the copy of their Google picture */
  source: PictureSource;
  /** When it was saved (ms), naming this copy */
  version: number;
}

/** What shows when there's no chosen picture: the Google picture, or the initial */
export const PICTURE_CHOICES = ['google', 'initial'] as const;
export type PictureChoice = (typeof PICTURE_CHOICES)[number];

/** The largest picture the server keeps, in bytes; the app sends 256px, well under it */
export const MAX_PICTURE_BYTES = 64 * 1024;
/** The most pixels a picture may have on a side */
export const MAX_PICTURE_SIDE = 512;
/** The picture types the server takes, by their bytes */
export const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;

/** PUT /api/me/picture takes the image's bytes; GET serves the signed-in account's own */
export const PICTURE_PATH = '/api/me/picture';
/**
 * The picture's address, naming the copy (?v=), so the service worker keeps it per
 * account (IMAGE_VIEWER_HEADER) and a new one is a new address
 */
export const pictureAddress = (picture: ProfilePicture) =>
  `${PICTURE_PATH}?v=${picture.source}-${picture.version}`;
/**
 * Whose a picture is, as the server sends it: the service worker keeps a copy for that
 * account alone (web/public/sw.js keeps its own copy of this name)
 */
export const IMAGE_VIEWER_HEADER = 'X-Image-Viewer';

/** The signed-in account and its private settings */
export interface Profile {
  email: string;
  displayName: string | null;
  settings: Settings;
  /** Converting into a new home currency, or the last change refused; null otherwise */
  conversion: Conversion | null;
  /** What shows in place of the initial; null for the initial */
  picture: ProfilePicture | null;
  /** A copy of their Google picture is kept, to go back to */
  googlePicture: boolean;
}

/** Whether a profile's amounts are being converted into a new home currency */
export const isConverting = (profile: Pick<Profile, 'conversion'>) =>
  profile.conversion != null && profile.conversion.refused == null;

/**
 * The currency amounts are in now, as shown and as changes are typed in: until a
 * conversion is done they are still in the currency it's from
 */
export const currencyNow = (profile: Pick<Profile, 'conversion' | 'settings'>) =>
  isConverting(profile) ? profile.conversion!.from : profile.settings.currency;

export interface ProfilePatch {
  displayName?: string | null;
  settings?: Partial<Settings>;
  /** Lets the chosen picture go, showing the Google picture or the initial instead */
  picture?: PictureChoice;
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
  /** For an earlier day's rate, the calendar day it's from (2026-11-12), the same everywhere */
  day?: string;
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
  /**
   * When it was archived (ms), as the server saved it; null while it's running, or for one
   * archived before the day was kept. Missing from a copy kept on a device from before.
   */
  archivedAt?: number | null;
  /**
   * When it was added (ms): tracking began that day, so its opening balance is what it held
   * then. Missing from a copy kept on a device from before.
   */
  createdAt?: number;
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
  /**
   * The time of day on the person's own clock, as 08:12 (24-hour), when one was given
   * ("Ask for a time"); null or missing for none. Orders transactions on the same day.
   */
  time?: string | null;
  /**
   * The scheduled occurrence it was added from (by the nightly job, or Log it); only on an
   * entry from Scheduled
   */
  scheduled?: ScheduledMark;
  /** When the server saved it (ms), which orders transactions on the same day after the time */
  createdAt: number;
  /**
   * What it was typed as, when that wasn't the home currency: an entry typed in another
   * currency, or one converted when the home currency changed. Missing for one typed in the
   * home currency. Never sent in a change: a change says its currency in ChangesBody.
   */
  original?: Original;
}

/** An amount as it was typed, and the rate that converted it into the home currency */
export interface Original {
  currency: string;
  /** Whole cents of `currency` */
  cents: number;
  /** 1 of `currency` is `rate` of the home currency */
  rate: number;
  source: FetchedRateSource;
  /** When the rate is from (ms); for an earlier day's rate, noon UTC that day */
  at: number;
  /** For an earlier day's rate, the calendar day it's from (2026-11-12), the same everywhere */
  day?: string;
  /**
   * Only on the device, before it's saved: typed offline with no rate known here, so its
   * amount is 0 (out of every total) and its rate a placeholder until the server converts it
   * at the entry's own day's rate. Never sent or stored.
   */
  pending?: true;
}

/** Where an entry from Scheduled came from, and whether its amount is still to check */
export interface ScheduledMark {
  /** The person's own repeating item */
  recurringId: string;
  /** The day the occurrence was due, as 2026-11-20 */
  due: string;
  /** Added at an amount that changes, not yet confirmed by the person */
  toCheck: boolean;
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

/** How many transactions, and what the spending and the income among them came to */
export interface SearchTotals {
  /** Every kind counted, transfers too */
  entries: number;
  /** Spending alone, whole cents */
  spentCents: number;
  /** Income alone, whole cents */
  receivedCents: number;
}

/**
 * GET /api/search: a page of what a search finds, newest first, with what matches beyond
 * it, so the app can say how many are found and what they came to, in all and on each day,
 * by adding what it has loaded (as shown) to the last page's rest. Each figure stays exact:
 * a person holds at most MAX_ACCOUNTS x MAX_TRANSACTIONS_PER_ACCOUNT transactions of at
 * most MAX_TRANSACTION_CENTS (shared/ledger.ts), under 5e15 cents.
 */
export interface SearchPage extends TransactionPage {
  /** Everything that matches after this page's last transaction; nothing on the last page */
  rest: SearchTotals;
  /** Of `rest`, those on the day of this page's last transaction; null on the last page */
  restOfLastDay: (SearchTotals & { date: string }) | null;
  /**
   * The first page only, when the search asks for days (from or to): how many match
   * outside them, the rest of it the same
   */
  elsewhere?: number;
  /** The first page only: whether the person has any transaction at all, matching or not */
  anywhere?: boolean;
}

/** What was spent in one category, or received in one, over a month */
export interface CategoryTotal {
  /** The category the transactions name: a subcategory's own id, not its parent's */
  categoryId: string;
  /** Whole cents, above zero */
  cents: number;
  /** How many transactions make it, at least 1 */
  entries: number;
  /**
   * Who was paid (or paid) when it is a single transaction naming one, as Plan's rows say
   * "Rent" rather than "1 entry"; left out otherwise
   */
  payee?: string;
}

/** What was spent on one day (2026-11-05) */
export interface DayTotal {
  date: string;
  /** Whole cents, above zero */
  cents: number;
}

/**
 * Tidy up: how many spending transactions since a day are still in Other, the catch-all
 * spending category (OTHER_EXPENSE_ID), or in a category under it
 */
export interface TidyUp {
  /** The first day counted (the first of the month before), as 2026-10-01 */
  from: string;
  /** Spending transactions from `from` to the month's last day in those categories */
  entries: number;
  /** Other first, then the categories under it now, so changes can be counted on top */
  categoryIds: string[];
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
 * GET /api/summary: what a person spent and received in a month (2026-11, their own, from
 * their month start day), across every account, worked out by the server. Only spending and income count; a transfer moves
 * money between the person's own accounts, so it is never spending. Each list holds
 * only categories with something in them, largest first.
 */
export interface MonthSummary {
  /** The month's name (2026-11): the person's month, from their month start day */
  month: string;
  /**
   * The days it was summed over, both included (shared/period.ts): 2026-11-01 to
   * 2026-11-30 from the 1st, 2026-10-25 to 2026-11-24 from the 25th
   */
  firstDay: string;
  lastDay: string;
  incomeCents: number;
  spentCents: number;
  /** Received less spent; below zero when more was spent than came in */
  leftCents: number;
  spentByCategory: CategoryTotal[];
  incomeByCategory: CategoryTotal[];
  /** Spending by day, oldest first, only days with any: at most one per day of the month */
  spentByDay: DayTotal[];
  tidyUp: TidyUp;
  /**
   * The month's budgets, in the categories' order, on categories at the top level now;
   * only when there are any. What's left of each is worked out where it's shown
   * (budgetFigures in shared/budgets.ts), from the spending as shown.
   */
  budgets?: MonthBudget[];
  /**
   * The entries from Scheduled in the month, by item, in the order of each item's first
   * one (then the order the items were set up); only when there are any
   */
  fromScheduled?: ScheduledInMonth[];
  /**
   * Of the change ids the read named (PENDING_CHANGES_HEADER), the ones counted in already;
   * only when it named any
   */
  alreadySaved?: string[];
}

/** One scheduled item's entries in a month */
export interface ScheduledInMonth {
  recurringId: string;
  /** How many, at least 1 */
  entries: number;
  /** The day of its first in the month */
  firstDate: string;
  /** Those still to check, oldest first */
  toCheck: { id: string; date: string; amountCents: number }[];
}

/**
 * A month's spending and income in total and by category, as a month's totals have them,
 * without the month's own days, Tidy up and budgets
 */
export type MonthTotals = Omit<
  MonthSummary,
  'budgets' | 'alreadySaved' | 'spentByDay' | 'tidyUp' | 'fromScheduled'
>;

/**
 * GET /api/summary/trend: a person's spending and income in each of the 12 months ending at
 * a month (shared/trend.ts), oldest first, each summed as GET /api/summary sums one month
 * (each category under its own id, largest first), a month with nothing in it included
 */
export interface MonthTrend {
  /** The last of the 12, as asked */
  month: string;
  months: MonthTotals[];
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

/** Days an export holds, both included (2026-01-01 to 2026-12-31) */
export interface ExportRange {
  from: string;
  to: string;
}

/**
 * A file imported, as Recent imports lists it on every device. Undo deletes exactly the
 * entries that came in with it (undoImport).
 */
export interface ImportRecord {
  id: string;
  /** The file's name, as it was picked */
  fileName: string;
  /** The account a bank's file went into; null for a Mahnee export, which names its own */
  accountId: string | null;
  /** Transactions it added, and lines of the file left out; each at most MAX_IMPORT_ROWS */
  addedCount: number;
  skippedCount: number;
  /**
   * Whether it changed its account's opening balance, so rows from before tracking began
   * didn't count twice (updateAccount with importId); Undo changes it back by as much.
   * Missing from a copy kept on a device from before.
   */
  openingChanged?: boolean;
  /** When it was imported (ms, by the server's clock) */
  createdAt: number;
}

/** GET /api/imports: the person's imports not undone, newest first, at most MAX_RECENT_IMPORTS */
export interface RecentImports {
  imports: ImportRecord[];
}

/** The most imports Recent imports lists */
export const MAX_RECENT_IMPORTS = 10;

/** The longest file name an import keeps */
export const MAX_FILE_NAME = 255;

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
export type NewTransaction = Omit<Transaction, 'createdAt' | 'original'>;

/**
 * A bill or income that repeats, monthly or weekly (shared/recurring.ts), and what is added
 * each time: on its day, by the nightly job, or with Log it while it asks first. Stopped
 * (archived), never deleted.
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
  /** Its amount changes ("It changes"): each one added is for the person to check */
  amountVaries?: boolean;
  /**
   * It waits for Log it or Skip on Home rather than being added on its day: it was overdue
   * when saved, moved back or brought back (owner decision D19). Read only; the server says.
   */
  askFirst?: boolean;
}

/**
 * What a repeating item is given when it's set up. `nextDue`, its first due date, is the
 * app's to say (the first after the person's today, or an imported one's); without it (an
 * app from before) it's the schedule's next day after startDate.
 */
export type NewRecurring = Omit<Recurring, 'nextDue' | 'archived' | 'askFirst'> & {
  nextDue?: string;
};

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
 * One change to the ledger, as the app makes it and POST /api/changes saves it. A
 * category's kind is fixed once it's added; an account's can change.
 */
export type LedgerChange =
  | {
      op: 'addAccount';
      account: { id: string; name: string; kind: AccountKind; openingCents: number };
    }
  /**
   * A new kind keeps openingCents as kept (below zero is owed on a card, overdrawn on the
   * others) unless the change names a new one too
   */
  /**
   * importId: the opening balance is changed as part of that import (recorded first, with
   * addImport, into this account), so its Undo changes it back by as much
   */
  | {
      op: 'updateAccount';
      id: string;
      name?: string;
      kind?: AccountKind;
      openingCents?: number;
      importId?: string;
    }
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
  /** importId: the import it came in with (recorded first, with addImport) */
  | { op: 'addTransaction'; transaction: NewTransaction; importId?: string }
  /**
   * Changes what it names. A new kind comes with what that kind needs: spending or
   * income a category of its kind and toAccountId null, a transfer categoryId null and
   * the account it goes to.
   */
  | ({ op: 'updateTransaction'; id: string } & Partial<Omit<NewTransaction, 'id' | 'scheduled'>> & {
        /** false: the person confirmed the amount of an entry from Scheduled (never true) */
        toCheck?: false;
      })
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
  /**
   * Sets one up, first due on nextDue (on its schedule, at most a year ahead, and never
   * refused for having passed, so one sent from a device offline for days still applies);
   * without nextDue, on its schedule's next day after startDate
   */
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
        | 'amountVaries'
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
  | { op: 'skipRecurring'; id: string; due: string }
  /** Records a file imported, before the transactions that name it (createdAt is the server's) */
  | { op: 'addImport'; import: Omit<ImportRecord, 'createdAt' | 'openingChanged'> }
  /**
   * Deletes, for good, every transaction that came in with the import, wherever it is now,
   * changes back the opening balance it changed (openingChanged) and marks the import
   * undone; one undone already is left as it is
   */
  | { op: 'undoImport'; id: string };

/** POST /api/changes: saved in order, all or nothing */
export interface ChangesBody {
  changes: LedgerChange[];
  /**
   * The id the app gave each change (isRowId), one each in order: a change sent again
   * after its answer was lost then counts once, and an id sent with a different change
   * is refused
   */
  ids: string[];
  /**
   * The home currency each change was typed in, one each in order (currencyNow when it was
   * made), null for one that doesn't say (kept from before): an amount typed before the
   * currency changed is converted from it on saving; one that doesn't say is taken as typed
   * in the home currency
   */
  currencies?: (string | null)[];
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
 * On a read of balances or months' totals (GET /api/accounts, /api/summary and
 * /api/summary/trend): the ids of changes the app still has waiting that may have been saved
 * already (sent, but the answer never came), comma-separated, at most MAX_CHANGES (about
 * 3.4 KB). The answer's `alreadySaved` says which of them it holds, read together with the
 * figures, so the app never counts one of them on top a second time.
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
 * rate_lookup_limit: send fewer changes together to fit the request's exchange-rate allowance.
 * account_mismatch: the write was made for another account than the one signed in now,
 * so it's kept (not sent again) until that account is back. client_update_required: an
 * app too old to say whose a write is; kept until it updates. converting: the person's
 * amounts are being converted into a new home currency (503), so the write is kept and sent
 * again once that's done.
 */
export type ErrorCode =
  | 'account_mismatch'
  | 'client_update_required'
  | 'converting'
  | 'rate_lookup_limit';
