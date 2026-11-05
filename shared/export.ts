// The file a person downloads to take their whole history with them: every transaction
// as one line of a CSV file, which Excel, Numbers and Google Sheets open. The Worker
// writes it (worker/ledger/export.ts) and the app's test stand-in the same way.
//
// Names are written as they are now: an account renamed since shows its new name on
// every line. Archived accounts and categories are written like any other.

import type { Transaction } from './api';
import type { TransactionKind } from './ledger';

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

/**
 * Written first, before the header. Excel takes a CSV file without it for the computer's
 * own older encoding, which garbles "RM", accented and non-Latin names; with it, every
 * spreadsheet reads the file as UTF-8. Other programs skip it.
 */
export const CSV_BOM = '﻿';

/** The file's name for the day it was made (2026-11-05): mahnee-2026-11-05.csv */
export const exportFileName = (day: string) => `mahnee-${day}.csv`;

/**
 * Whole cents written as an amount, 123450 as "1234.50", worked on the digits alone so
 * no amount is ever rounded. Amounts are never below zero; the kind says which way the
 * money went.
 */
export function centsText(cents: number): string {
  const digits = String(cents).padStart(3, '0');
  return `${digits.slice(0, -2)}.${digits.slice(-2)}`;
}

/**
 * Text a spreadsheet would run as a formula if a cell began with it: a payee of
 * "=HYPERLINK(...)" could otherwise open a link, or worse, when the file is opened
 */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * One cell: text that starts like a formula gets a ' in front, which spreadsheets show as
 * plain text, and a cell holding a comma, a quote or a line break goes in quotes, its
 * quotes doubled
 */
export function csvCell(text: string): string {
  const safe = FORMULA_START.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One line of the file, ending in CRLF as CSV files do */
export const csvLine = (cells: readonly string[]) => `${cells.map(csvCell).join(',')}\r\n`;

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
): string[] {
  const account = accounts.get(t.accountId);
  const category = t.categoryId == null ? null : categories.get(t.categoryId);
  const parent = category?.parentId == null ? null : categories.get(category.parentId);
  return [
    t.date,
    EXPORT_KINDS[t.kind],
    account?.name ?? '',
    t.toAccountId == null ? '' : accounts.get(t.toAccountId)?.name ?? '',
    centsText(t.amountCents),
    account?.currency ?? '',
    category?.name ?? '',
    parent?.name ?? '',
    t.payee ?? '',
    t.note ?? '',
    t.id,
  ];
}
