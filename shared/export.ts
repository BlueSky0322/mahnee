// The file a person downloads to take their whole history with them: each account's
// opening balance, each bill or income still repeating, then every transaction, one line
// each of a CSV file, which Excel, Numbers and Google Sheets open. Every balance can be
// worked out again from it, and importing it sets the repeating ones up again. The Worker
// writes it (worker/ledger/export.ts) and the app's test stand-in the same way.
//
// Names are written as they are now: an account renamed since shows its new name on
// every line. Archived accounts and categories are written like any other.

import type { Recurring, Transaction } from './api';
import type { TransactionKind } from './ledger';
import type { Schedule } from './recurring';
import { MAX_RECURRING } from './recurring';

/** The file's first line: what each column holds */
export const EXPORT_COLUMNS = [
  'Date',
  'Kind',
  'Account',
  'To account',
  'Amount',
  'Currency',
  'Category',
  'Parent category',
  'Payee',
  'Note',
  'Id',
] as const;

/** How each kind of transaction is written */
export const EXPORT_KINDS: Record<TransactionKind, string> = {
  expense: 'Spent',
  income: 'Received',
  transfer: 'Transfer',
};

/** The kind written on an account's opening balance line */
export const OPENING_KIND = 'Opening balance';

/**
 * How each kind of repeating item is written: "Repeating spent", "Repeating received",
 * "Repeating transfer", so a spreadsheet can filter them and tell them apart
 */
export const REPEATING_KINDS = Object.fromEntries(
  Object.entries(EXPORT_KINDS).map(([kind, name]) => [kind, `Repeating ${name.toLowerCase()}`]),
) as Record<TransactionKind, string>;

/** How often a repeating item falls, as its line's Note says: "Monthly, day 15", "Weekly, day 3" */
export const scheduleText = (schedule: Schedule, day: number) =>
  `${schedule === 'monthly' ? 'Monthly' : 'Weekly'}, day ${day}`;

/**
 * Written first, before the header. Excel takes a CSV file without it for the computer's
 * own older encoding, which garbles "RM", accented and non-Latin names; with it, every
 * spreadsheet reads the file as UTF-8. Other programs skip it.
 */
export const CSV_BOM = '\uFEFF';

/** The file's name for the day it was made (2026-11-05): mahnee-2026-11-05.csv */
export const exportFileName = (day: string) => `mahnee-${day}.csv`;

/**
 * Whole cents written as an amount, 123450 as "1234.50", worked on the digits alone so
 * no amount is ever rounded. A transaction's amount is never below zero (its kind says
 * which way the money went); an opening balance is, for what's owed (-32000 as "-320.00").
 */
export function centsText(cents: number): string {
  const digits = String(Math.abs(cents)).padStart(3, '0');
  return `${cents < 0 ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * A cell holding a number this file wrote (an amount), as opposed to text: it's written
 * as it is, so "-320.00" stays a number a spreadsheet can add up
 */
export interface NumberCell {
  number: string;
}

/** A cell: text (names, payees, notes, and the rest), or a number this file wrote */
export type Cell = string | NumberCell;

/**
 * Text a spreadsheet would run as a formula if a cell began with it: a payee of
 * "=HYPERLINK(...)" could otherwise open a link, or worse, when the file is opened
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One cell. Text that starts like a formula gets a ' in front, which spreadsheets show as
 * plain text, and text holding a comma, a quote or a line break goes in quotes, its quotes
 * doubled. A number this file wrote is only ever digits, a point and a leading minus, so
 * it's written as it is: a ' would turn a negative amount into text.
 */
export function csvCell(cell: Cell): string {
  if (typeof cell !== 'string') return cell.number;
  const safe = FORMULA_START.test(cell) ? `'${cell}` : cell;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One line of the file, ending in CRLF as CSV files do */
export const csvLine = (cells: readonly Cell[]) => `${cells.map(csvCell).join(',')}\r\n`;

/** What an account's opening balance line needs to know of it */
export interface ExportAccount {
  id: string;
  name: string;
  currency: string;
  openingCents: number;
  /** When it was added (ms) */
  createdAt: number;
}

/**
 * An account's opening balance, in EXPORT_COLUMNS' order: dated the day it was added, in
 * UTC (the server doesn't know the person's time zone), and signed, below zero for what's
 * owed on a card. Every account has one, archived ones and ones with no transactions too.
 */
export const openingCells = (a: ExportAccount): Cell[] => [
  new Date(a.createdAt).toISOString().slice(0, 10),
  OPENING_KIND,
  a.name,
  '',
  { number: centsText(a.openingCents) },
  a.currency,
  '',
  '',
  '',
  '',
  a.id,
];

/** What a line needs to know about the person's accounts and categories, by id */
export interface ExportNames {
  accounts: Map<string, { name: string; currency: string }>;
  categories: Map<string, { name: string; parentId: string | null }>;
}

/**
 * A transaction's cells, in EXPORT_COLUMNS' order. A subcategory is written with its
 * parent beside it; a top-level category with none. An account or category missing from
 * `names` (never, while they're only archived) is written empty rather than dropped.
 */
export function exportCells(
  t: Omit<Transaction, 'createdAt'>,
  { accounts, categories }: ExportNames,
): Cell[] {
  const account = accounts.get(t.accountId);
  const category = t.categoryId == null ? null : categories.get(t.categoryId);
  const parent = category?.parentId == null ? null : categories.get(category.parentId);
  return [
    t.date,
    EXPORT_KINDS[t.kind],
    account?.name ?? '',
    t.toAccountId == null ? '' : accounts.get(t.toAccountId)?.name ?? '',
    { number: centsText(t.amountCents) },
    account?.currency ?? '',
    category?.name ?? '',
    parent?.name ?? '',
    t.payee ?? '',
    t.note ?? '',
    t.id,
  ];
}

/**
 * A repeating item's cells, in EXPORT_COLUMNS' order: dated its next due date, its kind as
 * REPEATING_KINDS writes it, what it records as a transaction's line has it (the amount
 * unsigned), how often it falls in the Note (Monday is day 1) and its own id
 */
export function repeatingCells(r: Omit<Recurring, 'startDate'>, names: ExportNames): Cell[] {
  const cells = exportCells({ ...r, note: null, date: r.nextDue }, names);
  cells[1] = REPEATING_KINDS[r.kind];
  cells[9] = scheduleText(r.schedule, r.day);
  return cells;
}

/**
 * The lines of a person's repeating items still running, in the order given (the order
 * they were set up), at most MAX_RECURRING; stopped ones are left out, as they don't come
 * back with an import
 */
export const repeatingLines = (
  items: readonly Omit<Recurring, 'startDate'>[],
  names: ExportNames,
): string =>
  items
    .filter((r) => !r.archived)
    .slice(0, MAX_RECURRING)
    .map((r) => csvLine(repeatingCells(r, names)))
    .join('');
