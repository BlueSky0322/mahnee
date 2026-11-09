// Reading a CSV file into rows to import: a bank's statement, mapped column by column by
// the person, or Mahnee's own export (shared/export.ts), which is known by its header and
// read back whole, its repeating items too. Nothing here saves anything: the app turns the rows into ledger changes
// once the person has looked them over, and the Worker checks each change as ever.
//
// Amounts are read digit by digit into whole cents, never through floating point.

import { CSV_BOM, EXPORT_COLUMNS, EXPORT_KINDS, OPENING_KIND, REPEATING_KINDS } from './export';
import type { TransactionKind } from './ledger';
import { MAX_NOTE, MAX_PAYEE, MAX_TRANSACTION_CENTS, isDay } from './ledger';
import type { Schedule } from './recurring';
import { fallsOn, isScheduleDay, latestDue } from './recurring';

/** The most rows one file may hold (its header aside); a longer one is refused whole */
export const MAX_IMPORT_ROWS = 5000;

/**
 * Which of a bank file's columns (by their names in its header) holds what: the day, and
 * either one column of amounts (below zero for money out) or one each for money in and
 * money out; a payee and a note if the file has them
 */
export interface ColumnMapping {
  date: string;
  amount: string | null;
  moneyIn: string | null;
  moneyOut: string | null;
  payee: string | null;
  note: string | null;
}

/** What was cut to fit what a transaction holds */
export type Shortened = 'payee' | 'note';

/**
 * A row read, numbered as a spreadsheet numbers it (the header is row 1), or why it can't
 * be imported
 */
export type Read<T> = ({ row: number; problem?: undefined } & T) | { row: number; problem: string };

/** A row of a bank's file */
export interface BankRow {
  /** 2026-11-05 */
  date: string;
  /** Whole cents, below zero for money out */
  cents: number;
  payee: string | null;
  note: string | null;
  /** Only when something was cut to fit */
  shortened?: Shortened[];
}

/** A line of Mahnee's export, names as written */
export interface ExportRow {
  kind: 'opening' | TransactionKind;
  date: string;
  account: string;
  toAccount: string | null;
  /** Whole cents: above zero for a transaction; signed for an opening balance */
  cents: number;
  category: string | null;
  parentCategory: string | null;
  payee: string | null;
  note: string | null;
  /**
   * Only on a repeating item's line: how often it falls. Its `date` is then its next due
   * date, `kind` what it records, and it has no note.
   */
  repeat?: { schedule: Schedule; day: number };
}

/** What two rows are compared by, to see whether one looks already saved */
export interface Comparable {
  accountId: string;
  date: string;
  /** What it does to the account's balance, in cents: below zero for money out */
  cents: number;
  payee: string | null;
}

/**
 * The cells of a CSV file, row by row: quoted cells may hold commas, line breaks and
 * doubled quotes. A byte-order mark and empty lines are skipped.
 */
export function parseCsv(text: string): string[][] {
  const source = text.startsWith(CSV_BOM) ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  const endRow = () => {
    row.push(cell);
    cell = '';
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch !== '"') cell += ch;
      else if (source[i + 1] === '"') {
        cell += '"';
        i++;
      } else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\r' || ch === '\n') {
      endRow();
      if (ch === '\r' && source[i + 1] === '\n') i++;
    } else cell += ch;
  }
  if (cell !== '' || row.length > 0) endRow();
  return rows;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/** A real calendar day, as 2026-11-05, or null */
function calendarDay(year: number, month: number, day: number): string | null {
  const at = new Date(Date.UTC(year, month - 1, day));
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return null;
  }
  return at.toISOString().slice(0, 10);
}

/** A day as banks write it: 05/11/2026 (day first), 2026-11-05 or 5 Nov 2026; else null */
export function readDay(text: string): string | null {
  const t = text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(t);
  if (m != null) return calendarDay(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (m != null) return calendarDay(Number(m[3]), Number(m[2]), Number(m[1]));
  m = /^(\d{1,2})[\s-]+([A-Za-z]{3,9})[\s-]+(\d{4})$/.exec(t);
  if (m == null) return null;
  // Its first three letters, or the whole name
  const name = m[2].toLowerCase();
  const month = MONTHS.findIndex((full) => name === full || name === full.slice(0, 3));
  return month < 0 ? null : calendarDay(Number(m[3]), month + 1, Number(m[1]));
}

/**
 * An amount as banks write it, in whole cents, or null: "1,234.50", "RM 1,234.50",
 * "-12.00" and "(12.00)" (below zero), at most two places after the point
 */
export function readCents(text: string): number | null {
  let t = text.replace(/\s+/g, '');
  let negative = false;
  const sign = () => {
    if (t.startsWith('-') || t.startsWith('+')) {
      if (negative && t.startsWith('-')) return false;
      negative ||= t.startsWith('-');
      t = t.slice(1);
    }
    if (/^rm/i.test(t)) t = t.slice(2);
    return true;
  };
  if (!sign()) return null;
  if (t.startsWith('(') && t.endsWith(')')) {
    if (negative) return null;
    negative = true;
    t = t.slice(1, -1);
    if (/^rm/i.test(t)) t = t.slice(2);
  } else if (!sign()) return null;
  const m = /^(\d{1,3}(?:,\d{3})+|\d*)(?:\.(\d{1,2}))?$/.exec(t);
  if (m == null || (m[1] === '' && m[2] == null)) return null;
  const whole = m[1] === '' ? 0 : Number(m[1].replace(/,/g, ''));
  const cents = whole * 100 + Number((m[2] ?? '').padEnd(2, '0'));
  if (!Number.isSafeInteger(cents)) return null;
  return negative && cents !== 0 ? -cents : cents;
}

/** Whether a file's header is Mahnee's own export's */
export const isMahneeExport = (header: readonly string[]): boolean =>
  header.length === EXPORT_COLUMNS.length && header.every((h, i) => h === EXPORT_COLUMNS[i]);

/** Text that's empty once trimmed is none */
const textOf = (cell: string | undefined) => {
  const t = (cell ?? '').trim();
  return t === '' ? null : t;
};

/** Text cut to `max`, and whether it was */
function fit(text: string | null, max: number): [string | null, boolean] {
  if (text == null || text.length <= max) return [text, false];
  return [text.slice(0, max).trim(), true];
}

const NO_AMOUNT = "Can't read the amount";
const DAY_RANGE = 'The date is before 2000 or after today';
const AMOUNT_RANGE = 'The amount is over 10,000,000';

/** A day a transaction can be on, or why not */
function dayOrProblem(text: string, now: number): string | { problem: string } {
  const day = readDay(text);
  if (day == null) return { problem: `Can't read the date "${text.trim()}"` };
  if (!isDay(day, now)) return { problem: DAY_RANGE };
  return day;
}

/** The signed cents in a bank row's money in or money out column, whichever is filled */
function inOrOut(inText: string, outText: string): number | null {
  if ((inText.trim() === '') === (outText.trim() === '')) return null;
  const cents = readCents(inText.trim() !== '' ? inText : outText);
  if (cents == null) return null;
  return inText.trim() !== '' ? Math.abs(cents) : -Math.abs(cents);
}

/** Each row of a bank's file, by `mapping`, or why it can't be imported */
export function readBankRows(
  table: string[][],
  mapping: ColumnMapping,
  now = Date.now(),
): Read<BankRow>[] {
  const header = table[0] ?? [];
  const at = (name: string | null) => (name == null ? -1 : header.indexOf(name));
  const columns = {
    date: at(mapping.date),
    amount: at(mapping.amount),
    moneyIn: at(mapping.moneyIn),
    moneyOut: at(mapping.moneyOut),
    payee: at(mapping.payee),
    note: at(mapping.note),
  };
  return table.slice(1).map((cells, i): Read<BankRow> => {
    const row = i + 2;
    const cell = (column: keyof typeof columns) =>
      columns[column] < 0 ? '' : cells[columns[column]] ?? '';
    const day = dayOrProblem(cell('date'), now);
    if (typeof day !== 'string') return { row, ...day };
    const cents =
      mapping.amount != null
        ? readCents(cell('amount'))
        : inOrOut(cell('moneyIn'), cell('moneyOut'));
    if (cents == null || cents === 0) return { row, problem: NO_AMOUNT };
    if (Math.abs(cents) > MAX_TRANSACTION_CENTS) return { row, problem: AMOUNT_RANGE };
    const [payee, payeeCut] = fit(textOf(cell('payee')), MAX_PAYEE);
    const [note, noteCut] = fit(textOf(cell('note')), MAX_NOTE);
    const shortened = [payeeCut && 'payee', noteCut && 'note'].filter(Boolean) as Shortened[];
    return { row, date: day, cents, payee, note, ...(shortened.length > 0 && { shortened }) };
  });
}

/** Text the export kept a spreadsheet from running as a formula, as it was */
const unguarded = (cell: string | undefined) => {
  const text = cell ?? '';
  return /^'[=+\-@\t\r]/.test(text) ? text.slice(1) : text;
};

const KIND_BY_NAME = new Map<string, ExportRow['kind']>([
  [OPENING_KIND, 'opening'],
  ...Object.entries(EXPORT_KINDS).map(([kind, name]) => [name, kind as TransactionKind] as const),
]);

/** A repeating item's line, by its kind ("Repeating spent"): what it records */
const REPEATING_BY_NAME = new Map(
  Object.entries(REPEATING_KINDS).map(([kind, name]) => [name, kind as TransactionKind] as const),
);

/** "Monthly, day 15" or "Weekly, day 3" (1 is Monday) read back, or null */
function readSchedule(text: string): ExportRow['repeat'] | null {
  const m = /^(Monthly|Weekly), day (\d{1,2})$/.exec(text.trim());
  if (m == null) return null;
  const schedule: Schedule = m[1] === 'Monthly' ? 'monthly' : 'weekly';
  const day = Number(m[2]);
  return isScheduleDay(schedule, day) ? { schedule, day } : null;
}

type Column = (typeof EXPORT_COLUMNS)[number];

/** Each line of Mahnee's export (header first), or why it can't be imported */
export function readExportRows(table: string[][], now = Date.now()): Read<ExportRow>[] {
  return table.slice(1).map((cells, i): Read<ExportRow> => {
    const row = i + 2;
    const raw = (name: Column) => cells[EXPORT_COLUMNS.indexOf(name)] ?? '';
    const text = (name: Column) => textOf(unguarded(raw(name)));
    const repeats = REPEATING_BY_NAME.get(raw('Kind').trim());
    if (repeats != null) return readRepeating(row, repeats, raw, text, now);
    const kind = KIND_BY_NAME.get(raw('Kind').trim());
    if (kind == null) return { row, problem: 'Unknown kind of line' };
    const account = text('Account');
    if (account == null) return { row, problem: 'No account named' };
    const toAccount = kind === 'transfer' ? text('To account') : null;
    if (kind === 'transfer' && toAccount == null) {
      return { row, problem: 'No account named to move it to' };
    }
    // An opening balance is dated the day its account was added, in UTC: taken as it is
    const date = kind === 'opening' ? readDay(raw('Date')) : dayOrProblem(raw('Date'), now);
    if (date == null) return { row, problem: `Can't read the date "${raw('Date').trim()}"` };
    if (typeof date !== 'string') return { row, ...date };
    const cents = readCents(raw('Amount'));
    if (cents == null || (kind !== 'opening' && cents <= 0)) return { row, problem: NO_AMOUNT };
    if (Math.abs(cents) > MAX_TRANSACTION_CENTS) return { row, problem: AMOUNT_RANGE };
    const categorised = kind === 'expense' || kind === 'income';
    return {
      row,
      kind,
      date,
      account,
      toAccount,
      cents,
      category: categorised ? text('Category') : null,
      parentCategory: categorised ? text('Parent category') : null,
      payee: kind === 'opening' ? null : fit(text('Payee'), MAX_PAYEE)[0],
      note: kind === 'opening' ? null : fit(text('Note'), MAX_NOTE)[0],
    };
  });
}

/**
 * A repeating item's line: dated its next due date, which may well be after today (so read
 * as any day, as an opening balance is), and must fall on the schedule its Note gives
 */
function readRepeating(
  row: number,
  kind: TransactionKind,
  raw: (name: Column) => string,
  text: (name: Column) => string | null,
  now: number,
): Read<ExportRow> {
  const account = text('Account');
  if (account == null) return { row, problem: 'No account named' };
  const toAccount = kind === 'transfer' ? text('To account') : null;
  if (kind === 'transfer' && toAccount == null) {
    return { row, problem: 'No account named to move it to' };
  }
  const date = readDay(raw('Date'));
  if (date == null) return { row, problem: `Can't read the date "${raw('Date').trim()}"` };
  const repeat = readSchedule(raw('Note'));
  if (repeat == null) return { row, problem: "Can't read the schedule" };
  if (!fallsOn(repeat.schedule, repeat.day, date)) {
    return { row, problem: "The next due date isn't on the schedule" };
  }
  if (date > latestDue(now)) return { row, problem: 'Next due has to be within a year' };
  const cents = readCents(raw('Amount'));
  if (cents == null || cents <= 0) return { row, problem: NO_AMOUNT };
  if (cents > MAX_TRANSACTION_CENTS) return { row, problem: AMOUNT_RANGE };
  const categorised = kind !== 'transfer';
  return {
    row,
    kind,
    date,
    account,
    toAccount,
    cents,
    category: categorised ? text('Category') : null,
    parentCategory: categorised ? text('Parent category') : null,
    payee: fit(text('Payee'), MAX_PAYEE)[0],
    note: null,
    repeat,
  };
}

/** A payee as rows are compared by: trimmed, ignoring case; none is empty */
export const payeeKey = (payee: string | null): string => (payee ?? '').trim().toLowerCase();

const keyOf = (r: Comparable) => `${r.accountId}|${r.date}|${r.cents}|${payeeKey(r.payee)}`;

/**
 * Which `rows` look already saved: the same account, day, amount and payee as one of
 * `existing`. Each existing one answers for one row, so two alike in a file are both new
 * against one saved.
 */
export function looksSaved(rows: Comparable[], existing: Comparable[]): boolean[] {
  const left = new Map<string, number>();
  for (const e of existing) left.set(keyOf(e), (left.get(keyOf(e)) ?? 0) + 1);
  return rows.map((r) => {
    const n = left.get(keyOf(r)) ?? 0;
    if (n > 0) left.set(keyOf(r), n - 1);
    return n > 0;
  });
}
