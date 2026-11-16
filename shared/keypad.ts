// Add's calculator: what the keypad (or a computer's keyboard) has typed, as a sum of
// numbers joined by + − ×, and what it comes to in whole cents. × goes before + and −.
// Each number is read by its digits into cents, never through floating point, and each
// product is rounded to the cent, half a cent up, as it's worked out left to right. A
// number takes at most two decimals and nine digits. No key is taken that would bring the
// total, or any sum on the way, past the largest amount a transaction can be, so every
// figure stays exact.

import { MAX_TRANSACTION_CENTS } from './ledger';

export const KEYPAD_OPERATORS = ['+', '−', '×'] as const;
export type KeypadOperator = (typeof KEYPAD_OPERATORS)[number];
export type KeypadDigit = '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9';
export type KeypadKey = KeypadDigit | '.' | KeypadOperator | '=' | 'delete' | 'clear';

export interface Keypad {
  /** What's been typed: "3.07+11.6", or after =, the total: "14.67" or "−3" */
  expr: string;
  /** Just worked out with =: a digit starts a new number */
  fresh: boolean;
  /** The last key was refused, as it would have gone past the largest amount */
  tooMuch: boolean;
}

export const EMPTY_KEYPAD: Keypad = { expr: '', fresh: false, tooMuch: false };

/** The most digits a number can have, decimals counted */
const MAX_DIGITS = 9;

const isOperator = (c: string | undefined): c is KeypadOperator =>
  c != null && (KEYPAD_OPERATORS as readonly string[]).includes(c);
const isDigit = (c: string): c is KeypadDigit => c.length === 1 && c >= '0' && c <= '9';

/**
 * The sum as numbers and the operators between them. A leading − (a total below zero
 * carried on after =) belongs to the first number.
 */
function split(expr: string): {
  negative: boolean;
  numbers: string[];
  operators: KeypadOperator[];
} {
  const negative = expr.startsWith('−');
  const body = negative ? expr.slice(1) : expr;
  const numbers: string[] = [];
  const operators: KeypadOperator[] = [];
  let current = '';
  for (const c of body) {
    if (isOperator(c)) {
      numbers.push(current);
      operators.push(c);
      current = '';
    } else current += c;
  }
  numbers.push(current);
  return { negative, numbers, operators };
}

/** A number's digits as hundredths: "12.5" is 1250, "7." is 700, "" is 0 */
function hundredths(number: string): bigint {
  const [whole, decimals = ''] = number.split('.');
  return BigInt(whole === '' ? '0' : whole) * 100n + BigInt(`${decimals}00`.slice(0, 2));
}

function evaluate(expr: string): bigint {
  const { negative, numbers, operators } = split(expr);
  // An operator left at the end counts for nothing
  if (numbers.length > 1 && numbers.at(-1) === '') {
    numbers.pop();
    operators.pop();
  }
  let total = 0n;
  let term = hundredths(numbers[0]) * (negative ? -1n : 1n);
  let sign = 1n;
  for (let i = 0; i < operators.length; i++) {
    const next = hundredths(numbers[i + 1]);
    if (operators[i] === '×') {
      // Cents times the number, rounded to the cent, half up (away from zero)
      const product = term * next;
      const half = product < 0n ? -50n : 50n;
      term = (product + half) / 100n;
    } else {
      total += sign * term;
      sign = operators[i] === '−' ? -1n : 1n;
      term = next;
    }
  }
  return total + sign * term;
}

/** What the sum comes to, in whole cents (below zero when more is taken away) */
export const totalCents = (expr: string): number => Number(evaluate(expr));

const withinLimit = (expr: string) => {
  const total = evaluate(expr);
  return total <= BigInt(MAX_TRANSACTION_CENTS) && total >= -BigInt(MAX_TRANSACTION_CENTS);
};

/** A total in cents written by its digits: "14.67", "10", "0.05", "−3" */
function writeCents(cents: bigint): string {
  const sign = cents < 0n ? '−' : '';
  const abs = cents < 0n ? -cents : cents;
  const whole = abs / 100n;
  const part = Number(abs % 100n);
  if (part === 0) return `${sign}${whole}`;
  return `${sign}${whole}.${part % 10 === 0 ? part / 10 : String(part).padStart(2, '0')}`;
}

/** The keypad after `key` is pressed */
export function press(state: Keypad, key: KeypadKey): Keypad {
  const { expr, fresh } = state;
  const kept: Keypad = { expr, fresh, tooMuch: false };
  if (key === 'clear') return EMPTY_KEYPAD;
  if (key === 'delete') {
    if (fresh || expr === '') return EMPTY_KEYPAD;
    const shorter = expr.slice(0, -1);
    // Never a sign left on its own
    return { expr: shorter === '−' ? '' : shorter, fresh: false, tooMuch: false };
  }
  if (key === '=') {
    if (expr === '' || expr === '−') return kept;
    return { expr: writeCents(evaluate(expr)), fresh: true, tooMuch: false };
  }
  if (isOperator(key)) {
    if (expr === '' || expr === '−') return kept;
    let base = expr;
    if (isOperator(base.at(-1))) base = base.slice(0, -1);
    else if (base.endsWith('.')) base = base.slice(0, -1);
    return { expr: base + key, fresh: false, tooMuch: false };
  }

  // A digit or the point: after =, a new number
  const before = fresh ? '' : expr;
  const { numbers } = split(before);
  const current = numbers.at(-1) ?? '';
  let next: string;
  if (key === '.') {
    if (current.includes('.')) return { expr: before, fresh: false, tooMuch: false };
    next = before + (current === '' ? '0.' : '.');
  } else {
    if (!isDigit(key)) return kept;
    const decimals = current.split('.')[1];
    if (decimals != null && decimals.length >= 2)
      return { expr: before, fresh: false, tooMuch: false };
    next = current === '0' ? before.slice(0, -1) + key : before + key;
    // The largest amount is checked first, so it's the one said when both would refuse
    if (!withinLimit(next)) return { ...state, tooMuch: true };
    if (current.replace('.', '').length >= MAX_DIGITS) {
      return { expr: before, fresh: false, tooMuch: false };
    }
  }
  return { expr: next, fresh: false, tooMuch: false };
}

/**
 * The keys a computer's keyboard typed, from `from`: digits, the point, + and -, * or x
 * for ×, and =; anything else (thousands separators, spaces, letters) passes by
 */
export function typeKeys(text: string, from: Keypad = EMPTY_KEYPAD): Keypad {
  let state = from;
  for (const c of text) {
    const key: KeypadKey | null = isDigit(c)
      ? c
      : c === '.' || c === '+' || c === '=' || c === '×' || c === '−'
        ? c
        : c === '-'
          ? '−'
          : c === '*' || c === 'x' || c === 'X'
            ? '×'
            : null;
    if (key != null) state = press(state, key);
  }
  return state;
}

const NUMBER = /^\d+(\.\d{0,2})?$/;

/** Whether `expr` is a sum the keypad could have typed: kept drafts are checked with it */
export function isKeypadSum(expr: string): boolean {
  if (expr === '') return true;
  const { numbers } = split(expr);
  const last = numbers.at(-1);
  const all = last === '' && numbers.length > 1 ? numbers.slice(0, -1) : numbers;
  return (
    all.every((n) => NUMBER.test(n) && n.replace('.', '').length <= MAX_DIGITS) && withinLimit(expr)
  );
}

/** "1250" as "1,250" */
const grouped = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

/** A number as typed, its whole part grouped: "1,250.5", "4." */
function shown(number: string) {
  const [whole, ...rest] = number.split('.');
  return grouped(whole) + (rest.length > 0 ? `.${rest[0]}` : '');
}

/** The sum line above the amount: "3.07 + 11.6 =", "3 +", or nothing for a lone number */
export function expressionLine(expr: string): string {
  const { negative, numbers, operators } = split(expr);
  if (operators.length === 0) return '';
  const parts: string[] = [`${negative ? '−' : ''}${shown(numbers[0])}`];
  operators.forEach((op, i) => {
    parts.push(op);
    if (numbers[i + 1] !== '') parts.push(shown(numbers[i + 1]));
  });
  return isOperator(expr.at(-1)) ? parts.join(' ') : `${parts.join(' ')} =`;
}

/** A total in cents with two decimals: "14.67", "−3.00", "2,000,000.00" */
export function centsShown(cents: number): string {
  const abs = Math.abs(cents);
  return `${cents < 0 ? '−' : ''}${grouped(String(Math.floor(abs / 100)))}.${String(abs % 100).padStart(2, '0')}`;
}

/** The big amount: the number as it's being typed, or the total with two decimals */
export function amountShown({ expr, fresh }: Keypad): string {
  if (expr === '') return '0';
  const { negative, operators, numbers } = split(expr);
  if (operators.length > 0 || fresh || negative) return centsShown(totalCents(expr));
  return shown(numbers[0]);
}
