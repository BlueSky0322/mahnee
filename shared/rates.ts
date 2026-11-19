// Converting between currencies. Amounts are whole cents (hundredths of the currency's
// main unit) everywhere, so a conversion is one multiplication and one rounding, done
// the same way by the app's preview and the server that saves it.

/** Where a rate came from: a live mid-market rate, the daily ECB rate, or typed in */
export type RateSource = 'wise' | 'frankfurter' | 'manual';

/** A currency code, like MYR */
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export const isCurrency = (v: unknown): v is string =>
  typeof v === 'string' && CURRENCY_PATTERN.test(v);

/**
 * The currencies a person's home currency can be: the ones the ECB publishes (through
 * Frankfurter), so every amount can be converted at its own day's rate without Wise.
 * migrations/0011_currency.sql holds the same list in its CHECK.
 */
export const HOME_CURRENCIES = [
  'AUD',
  'BRL',
  'CAD',
  'CHF',
  'CNY',
  'CZK',
  'DKK',
  'EUR',
  'GBP',
  'HKD',
  'HUF',
  'IDR',
  'ILS',
  'INR',
  'ISK',
  'JPY',
  'KRW',
  'MXN',
  'MYR',
  'NOK',
  'NZD',
  'PHP',
  'PLN',
  'RON',
  'SEK',
  'SGD',
  'THB',
  'TRY',
  'USD',
  'ZAR',
] as const;

export const isHomeCurrency = (v: unknown): v is string =>
  (HOME_CURRENCIES as readonly unknown[]).includes(v);

/**
 * The currencies an entry can be typed in (the person's other currencies, or a one-off):
 * every home currency, and those Wise has rates for that people here often spend in. An
 * entry in one is converted into the home currency at its day's rate on saving.
 */
export const ENTRY_CURRENCIES = [...HOME_CURRENCIES, 'TWD', 'VND'].sort();

export const isEntryCurrency = (v: unknown): v is string =>
  (ENTRY_CURRENCIES as readonly unknown[]).includes(v);

/** The most other currencies a person keeps (Settings › Money), offered in Add in their order */
export const MAX_OTHER_CURRENCIES = 8;

/** Offered first in currency pickers: the currencies people here travel and spend in */
export const COMMON_CURRENCIES = [
  'MYR',
  'SGD',
  'USD',
  'THB',
  'JPY',
  'IDR',
  'PHP',
  'KRW',
  'CNY',
  'HKD',
  'TWD',
  'VND',
  'AUD',
  'NZD',
  'GBP',
  'EUR',
] as const;

/**
 * The day a rate is for: the UTC day of a time, as 2026-10-12. An amount is converted at
 * the rate on the day it was spent, so the app's preview and the server use this one.
 */
export const rateDay = (at: number) => new Date(at).toISOString().slice(0, 10);

/** An amount in the currency's main unit (12.34), in whole cents (1234) */
export const toCents = (amount: number) => Math.round(amount * 100);

/** `cents` in one currency, at `rate` units of the other per unit, in the other's cents */
export const convertCents = (cents: number, rate: number) => Math.round(cents * rate);

/**
 * The same for an amount that may be below zero (an opening balance): the size is
 * converted and the sign kept, so a balance and its opposite convert to opposites
 */
export const convertSignedCents = (cents: number, rate: number) =>
  cents < 0 ? -convertCents(-cents, rate) : convertCents(cents, rate);

/** The largest amount anyone can type, in currency units, whatever its currency */
export const MAX_AMOUNT = 1_000_000_000;

/**
 * The most an amount typed in another currency than the home one can be, in its cents:
 * MAX_AMOUNT units (an IDR 15,000,000 hotel bill fits), well within what a number holds
 * exactly. What it converts to is still held to its own limit (MAX_TRANSACTION_CENTS for
 * an entry), so every total, which sums converted amounts, stays exact.
 */
export const MAX_TYPED_CENTS = MAX_AMOUNT * 100;

/**
 * The most an amount can come to in cents once converted. A typed amount (MAX_AMOUNT) at
 * a high rate could go past it, and past what a number holds exactly; kept well under
 * that, so a total of up to 1,800 such amounts is still a whole number held exactly.
 * Each feature that sums amounts states its own list maximum.
 */
export const MAX_AMOUNT_CENTS = 5_000_000_000_000;

/** Whether cents are a whole amount within MAX_AMOUNT_CENTS */
export const fitsAmountCents = (cents: number) =>
  Number.isSafeInteger(cents) && cents >= 0 && cents <= MAX_AMOUNT_CENTS;

/** Rates people type in, or that services return, outside this range are refused */
export const MIN_RATE = 1e-6;
export const MAX_RATE = 1e6;

export const isValidRate = (rate: unknown): rate is number =>
  typeof rate === 'number' && Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE;
