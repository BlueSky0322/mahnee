import { describe, expect, test } from 'vitest';
import type { Keypad, KeypadKey } from './keypad';
import {
  EMPTY_KEYPAD,
  amountShown,
  expressionLine,
  press,
  readTypedSum,
  totalCents,
  typeKeys,
} from './keypad';
import { MAX_TRANSACTION_CENTS } from './ledger';

// Add's calculator (design R-Add, digest 4.7): numbers joined by + − ×, × before + and −,
// each number in whole cents first, × rounding to a cent, at most 2 decimals and 9 digits
// a number, a second operator taking the first one's place, = putting the total in place of
// the sum, a digit after = starting afresh. Nothing is ever worked out in floating currency
// units, and no key takes the total past the largest amount a transaction can be.
// The figures here are made up for these tests.

/** The keypad after pressing each key in turn, from empty */
const keys = (...pressed: KeypadKey[]): Keypad => pressed.reduce(press, EMPTY_KEYPAD);
/** The keypad after pressing the key for each character: digits, '.', + − × = */
const chars = (text: string, from: Keypad = EMPTY_KEYPAD): Keypad =>
  [...text].reduce((state, c) => press(state, c as KeypadKey), from);

describe('typing a number', () => {
  test('digits join, a leading 0 gives way, and . starts with 0 when nothing is typed', () => {
    expect(chars('306').expr).toBe('306');
    expect(chars('07').expr).toBe('7');
    expect(chars('.4').expr).toBe('0.4');
    expect(chars('3+.4').expr).toBe('3+0.4');
    expect(chars('0.0').expr).toBe('0.0');
  });

  test('takes one decimal point and at most two decimals a number', () => {
    expect(chars('6.7.1').expr).toBe('6.71');
    expect(chars('6.719').expr).toBe('6.71');
    expect(chars('6.71+2.039').expr).toBe('6.71+2.03');
  });

  test('takes at most nine digits a number, the decimals counted', () => {
    expect(chars('1234567.891').expr).toBe('1234567.89');
    // Each number has its own nine
    expect(chars('1+234567.891').expr).toBe('1+234567.89');
    // Nine digits bind only with decimals: an eighth digit before the point is already past
    // the largest amount, which refuses it first
    expect(chars('1234567890')).toEqual({ expr: '1234567', fresh: false, tooMuch: true });
    // At the largest amount, a tenth digit is the nine-digit rule's to refuse, not the limit's
    expect(chars('10000000.00')).toEqual({ expr: '10000000.0', fresh: false, tooMuch: false });
  });

  test('a leading 0 gives way in every number', () => {
    expect(chars('3+07').expr).toBe('3+7');
    expect(chars('00').expr).toBe('0');
  });
});

describe('operators', () => {
  test('need a number before them, and a second one takes the first one’s place', () => {
    expect(keys('+')).toEqual(EMPTY_KEYPAD);
    expect(keys('×', '−')).toEqual(EMPTY_KEYPAD);
    expect(chars('9+').expr).toBe('9+');
    expect(chars('9+×').expr).toBe('9×');
    expect(chars('9+−3').expr).toBe('9−3');
  });

  test('a number left ending in a point loses it when an operator follows', () => {
    expect(chars('5.+2').expr).toBe('5+2');
  });
});

describe('totalCents', () => {
  test('works each number out in whole cents and adds them', () => {
    expect(totalCents('3.07+11.6')).toBe(1_467);
    expect(totalCents('0.1+0.2')).toBe(30);
    expect(totalCents('1.15+2.3')).toBe(345);
    expect(totalCents('')).toBe(0);
  });

  test('takes away, and can come out below zero', () => {
    expect(totalCents('4−9.25')).toBe(-525);
    expect(totalCents('20−20')).toBe(0);
  });

  test('multiplies before adding or taking away', () => {
    expect(totalCents('2+3×4')).toBe(1_400);
    expect(totalCents('10−1.5×3')).toBe(550);
    expect(totalCents('1.1×1.1')).toBe(121);
  });

  test('rounds each product to a cent, half a cent up, step by step', () => {
    // 0.05 × 0.5 is 2.5 cents; 0.05 × 0.3 is 1.5 cents; 0.07 × 0.1 is 0.7 of a cent
    expect(totalCents('0.05×0.5')).toBe(3);
    expect(totalCents('0.05×0.3')).toBe(2);
    expect(totalCents('0.07×0.1')).toBe(1);
    expect(totalCents('0.03×0.1')).toBe(0);
    // 1 × 1.25 = 1.25, then × 1.25 = 1.5625, so 1.56; never 1 × 1.5625 in one go
    expect(totalCents('1×1.25×1.25')).toBe(156);
    // A cent is rounded on each product, not on the whole sum
    expect(totalCents('0.05×0.5+0.05×0.5')).toBe(6);
  });

  test('rounds an exact half cent up, where a floating-point multiply lands under it', () => {
    // 25 cents × 4.14 is 103.5 cents exactly; 25 × 4.14 in floating point is 103.49999...
    expect(totalCents('0.25×4.14')).toBe(104);
    expect(totalCents('0.5×0.29')).toBe(15);
    expect(totalCents('0.29×0.5')).toBe(15);
    expect(totalCents('0.5×1.13')).toBe(57);
    expect(chars('0.5×0.29=').expr).toBe('0.15');
    // Left to right: 15 cents, then 30
    expect(totalCents('0.5×0.29×2')).toBe(30);
  });

  test('leaves out an operator at the end, and reads a number ending in a point', () => {
    expect(totalCents('7×')).toBe(700);
    expect(totalCents('7+')).toBe(700);
    expect(totalCents('7.')).toBe(700);
  });

  test('is exact for the largest numbers the keypad takes, with no floating point', () => {
    expect(totalCents('9999999.99')).toBe(999_999_999);
    expect(totalCents('0.29×100')).toBe(2_900);
    expect(totalCents('4.35×100')).toBe(43_500);
    expect(totalCents('1.15×3')).toBe(345);
    expect(totalCents('8.2×0.7')).toBe(574);
  });
});

describe('= and starting afresh', () => {
  test('= puts the total in place of the sum, written by its digits', () => {
    expect(chars('3.07+11.6=')).toEqual({ expr: '14.67', fresh: true, tooMuch: false });
    expect(chars('2.5×4=').expr).toBe('10');
    expect(chars('0.01+0.04=').expr).toBe('0.05');
    expect(chars('1.2+0.3=').expr).toBe('1.5');
  });

  test('= with nothing typed does nothing; = again leaves the total as it is', () => {
    expect(keys('=')).toEqual(EMPTY_KEYPAD);
    expect(chars('6+1==')).toEqual({ expr: '7', fresh: true, tooMuch: false });
  });

  test('a digit or a point after = starts a new number; an operator carries on from the total', () => {
    expect(chars('6+1=5').expr).toBe('5');
    expect(chars('6+1=.5').expr).toBe('0.5');
    expect(chars('6+1=+2')).toEqual({ expr: '7+2', fresh: false, tooMuch: false });
    expect(totalCents(chars('6+1=×3').expr)).toBe(2_100);
  });

  test('Delete through a total below zero leaves nothing, never a lone sign', () => {
    let state = chars('2−5=+');
    state = press(press(state, 'delete'), 'delete');
    expect(state).toEqual(EMPTY_KEYPAD);
    expect(chars('4', state).expr).toBe('4');
  });

  test('a total below zero carries on as one', () => {
    const below = chars('2−5=');
    expect(below.expr).toBe('−3');
    expect(totalCents(below.expr)).toBe(-300);
    expect(totalCents(chars('+4', below).expr)).toBe(100);
  });
});

describe('Delete', () => {
  test('takes off the last character; holding it (clear) empties the keypad', () => {
    expect(press(chars('12+3'), 'delete').expr).toBe('12+');
    expect(press(press(chars('12+3'), 'delete'), 'delete').expr).toBe('12');
    expect(press(chars('12+3'), 'clear')).toEqual(EMPTY_KEYPAD);
    expect(press(EMPTY_KEYPAD, 'delete')).toEqual(EMPTY_KEYPAD);
  });

  test('after =, Delete empties the total rather than editing it', () => {
    expect(press(chars('6+1='), 'delete')).toEqual(EMPTY_KEYPAD);
  });
});

describe('the largest amount', () => {
  const max = String(MAX_TRANSACTION_CENTS / 100);

  test('takes the largest amount exactly, and refuses a key that would go past it', () => {
    const full = chars(max);
    expect(totalCents(full.expr)).toBe(MAX_TRANSACTION_CENTS);
    expect(full.tooMuch).toBe(false);
    const past = chars('.01', full);
    expect(past.expr).toBe(`${max}.0`);
    expect(past.tooMuch).toBe(true);
    // A digit more is refused too
    expect(chars('5', full)).toEqual({ expr: max, fresh: false, tooMuch: true });
    // The limit is checked before the nine digits: after the largest amount and ".0", the
    // "1" is refused for the limit (both rules would refuse it; the limit is the one said)
  });

  test('the next key it takes clears the refusal', () => {
    const refused = chars('5', chars(max));
    expect(press(refused, 'delete')).toEqual({
      expr: max.slice(0, -1),
      fresh: false,
      tooMuch: false,
    });
  });

  test('a sum or product past it is refused at the key that would pass it', () => {
    const half = String(MAX_TRANSACTION_CENTS / 200);
    expect(totalCents(chars(`${half}+${half}`).expr)).toBe(MAX_TRANSACTION_CENTS);
    expect(chars(`${half}+${half}+1`).expr).toBe(`${half}+${half}+`);
    expect(chars(`${half}+${half}+1`).tooMuch).toBe(true);
    expect(chars(`${half}×3`)).toEqual({ expr: `${half}×`, fresh: false, tooMuch: true });
    // Below zero the same way
    expect(chars(`0−${max}`).tooMuch).toBe(false);
    expect(chars(`0−${max}.01`).tooMuch).toBe(true);
  });

  test('a long sum can never grow past it, so every total stays exact', () => {
    let state = EMPTY_KEYPAD;
    for (let i = 0; i < 200; i++) state = chars('99999999+', state);
    expect(Math.abs(totalCents(state.expr))).toBeLessThanOrEqual(MAX_TRANSACTION_CENTS);
    expect(Number.isSafeInteger(totalCents(state.expr))).toBe(true);
  });
});

describe('typeKeys: a computer keyboard', () => {
  test('reads digits, the point and + - * x as the keypad’s keys', () => {
    expect(typeKeys('3.07+11.6').expr).toBe('3.07+11.6');
    expect(typeKeys('9-4*2').expr).toBe('9−4×2');
    expect(typeKeys('9x2').expr).toBe('9×2');
    expect(typeKeys('6+1=').expr).toBe('7');
  });

  test('passes over thousands separators, spaces and anything else', () => {
    expect(typeKeys('1,250.75').expr).toBe('1250.75');
    expect(typeKeys(' 12 + 3 ').expr).toBe('12+3');
    expect(typeKeys('RM 12a').expr).toBe('12');
  });

  test('keeps every keypad rule', () => {
    expect(typeKeys('6.719').expr).toBe('6.71');
    expect(typeKeys('9+*3').expr).toBe('9×3');
    expect(typeKeys('1234567890')).toEqual({ expr: '1234567', fresh: false, tooMuch: true });
  });
});

describe('readTypedSum: a sum typed in a box', () => {
  test('comes to what the same keys come to on the keypad', () => {
    for (const typed of [
      '0.25*4.14',
      '0.1+0.2',
      '10-0.25x4.14',
      '1,250.5 - 0.5',
      '.5',
      '007',
      '100+',
    ]) {
      expect(readTypedSum(typed), typed).toEqual({ cents: totalCents(typeKeys(typed).expr) });
    }
    expect(readTypedSum('')).toEqual({ cents: 0 });
    // A box can start below zero, which the keypad's keys can't: an overdrawn balance
    expect(readTypedSum('-0.25x4.14')).toEqual({ cents: -104 });
  });

  test('a number past nine digits only as the keypad keeps it: no leading or trailing zeros', () => {
    expect(readTypedSum('10000000.00')).toEqual({ cents: MAX_TRANSACTION_CENTS });
    expect(readTypedSum('0×1234567890')).toEqual({ error: 'notASum' });
  });

  test('the largest amount is checked at every digit, as on the keypad', () => {
    expect(readTypedSum('20000000−10000000')).toEqual({ error: 'tooMuch' });
    expect(readTypedSum('0−10000000.01')).toEqual({ error: 'tooMuch' });
  });
});

describe('what the display shows', () => {
  test('the sum line spaces each operator and ends with =, or is empty for a lone number', () => {
    expect(expressionLine('3.07+11.6')).toBe('3.07 + 11.6 =');
    expect(expressionLine('2×3−1')).toBe('2 × 3 − 1 =');
    expect(expressionLine('3+')).toBe('3 +');
    expect(expressionLine('1250+4.')).toBe('1,250 + 4. =');
    expect(expressionLine('306')).toBe('');
    expect(expressionLine('')).toBe('');
  });

  test('the amount is the number as typed, or the total with two decimals', () => {
    expect(amountShown(EMPTY_KEYPAD)).toBe('0');
    expect(amountShown(chars('3'))).toBe('3');
    expect(amountShown(chars('3.'))).toBe('3.');
    expect(amountShown(chars('3.4'))).toBe('3.4');
    expect(amountShown(chars('3.40'))).toBe('3.40');
    expect(amountShown(chars('1234567.8'))).toBe('1,234,567.8');
    expect(amountShown(chars('3.07+11.6'))).toBe('14.67');
    expect(amountShown(chars('3+'))).toBe('3.00');
    expect(amountShown(chars('6+1='))).toBe('7.00');
    expect(amountShown(chars('2−5'))).toBe('−3.00');
    expect(amountShown(chars('1000000×2'))).toBe('2,000,000.00');
  });
});
