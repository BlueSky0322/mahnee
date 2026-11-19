// What each setting takes, for the Worker (the authority, which also checks the ones that
// name a row: an account, a scheduled pay) and the app. migrations/0007_settings.sql holds
// the same in its CHECKs; worker/test/migrations.test.ts keeps the two in step.

import {
  ACCENTS,
  EXPENSE_COLOURS,
  HOME_DENSITIES,
  MONTH_START_MODES,
  RATE_PREFERENCES,
  START_SCREENS,
  START_WITH,
  THEMES,
  WEEK_STARTS,
  type Settings,
  isRowId,
} from './api';
import { MAX_OTHER_CURRENCIES, isEntryCurrency, isHomeCurrency } from './rates';

/** monthStartDay for "Last day": each month starts on its last day (Feb 28, Apr 30) */
export const LAST_DAY_OF_MONTH = 31;
/** The latest day of the month a month can start on, other than its last */
export const MAX_MONTH_START_DAY = 28;
/** The most days before a scheduled entry a reminder can come */
export const MAX_SCHEDULED_REMINDER_DAYS = 7;
/** The longest time zone name kept */
export const MAX_TIME_ZONE = 64;

const oneOf =
  <T>(values: readonly T[]) =>
  (v: unknown): v is T =>
    (values as readonly unknown[]).includes(v);
const isBoolean = (v: unknown): v is boolean => typeof v === 'boolean';
const isRowIdOrNone = (v: unknown): v is string | null => v === null || isRowId(v);

/** A time of day on a 24-hour clock, as 08:12 */
export const isTimeOfDay = (v: unknown): v is string =>
  typeof v === 'string' && /^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v);

export const isMonthStartDay = (v: unknown): v is number =>
  Number.isInteger(v) &&
  (((v as number) >= 1 && (v as number) <= MAX_MONTH_START_DAY) || v === LAST_DAY_OF_MONTH);

const TIME_ZONE_SHAPE = new RegExp(`^[A-Za-z][A-Za-z0-9_+/-]{0,${MAX_TIME_ZONE - 1}}$`);

/**
 * A time zone by its name (Asia/Kuala_Lumpur), as written: one this runtime knows, never
 * an offset (+05:45), and not a known name in other letters (asia/kuala_lumpur)
 */
export function isTimeZone(v: unknown): v is string {
  if (typeof v !== 'string' || !TIME_ZONE_SHAPE.test(v)) return false;
  let known: string;
  try {
    known = new Intl.DateTimeFormat('en-US', { timeZone: v }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
  // The runtime may answer with another name for the same zone; only a difference in
  // letters' case alone is refused
  return known === v || known.toLowerCase() !== v.toLowerCase();
}

/** Other currencies: a list of ones the app converts, each once, at most MAX_OTHER_CURRENCIES */
const isOtherCurrencies = (v: unknown): v is string[] =>
  Array.isArray(v) &&
  v.length <= MAX_OTHER_CURRENCIES &&
  v.every(isEntryCurrency) &&
  new Set(v).size === v.length;

/** Each setting's check */
export const SETTING_CHECKS: { [K in keyof Settings]: (v: unknown) => v is Settings[K] } = {
  // Saved with the conversion it starts (worker/currency/convert.ts); 0011 holds the list
  currency: isHomeCurrency,
  theme: oneOf(THEMES),
  accent: oneOf(ACCENTS),
  ratePreference: oneOf(RATE_PREFERENCES),
  weekStart: oneOf(WEEK_STARTS),
  monthStartMode: oneOf(MONTH_START_MODES),
  monthStartDay: isMonthStartDay,
  monthStartPayId: isRowIdOrNone,
  startScreen: oneOf(START_SCREENS),
  homeDensity: oneOf(HOME_DENSITIES),
  startWith: oneOf(START_WITH),
  defaultAccountId: isRowIdOrNone,
  suggestAsYouType: isBoolean,
  askForTime: isBoolean,
  expenseColour: oneOf(EXPENSE_COLOURS),
  carryOverDefault: isBoolean,
  dailyReminder: isBoolean,
  reminderTime: isTimeOfDay,
  scheduledReminderDays: (v): v is number | null =>
    v === null ||
    (Number.isInteger(v) && (v as number) >= 1 && (v as number) <= MAX_SCHEDULED_REMINDER_DAYS),
  // Sent by the app, never taken away
  timeZone: (v): v is string => isTimeZone(v),
  otherCurrencies: isOtherCurrencies,
  travelSense: isBoolean,
};

/**
 * The settings a request changes, each checked on its own; or why they're refused. Rows
 * they name (an account, a pay) are checked by the Worker.
 */
export function readSettingChanges(raw: unknown): Partial<Settings> | { error: string } {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: 'Invalid settings' };
  }
  const changes: Partial<Settings> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(SETTING_CHECKS, key)) {
      return { error: `Unknown setting ${key}` };
    }
    if (key === 'otherCurrencies' && Array.isArray(value) && value.length > MAX_OTHER_CURRENCIES) {
      return { error: `Keep up to ${MAX_OTHER_CURRENCIES} other currencies` };
    }
    if (!SETTING_CHECKS[key as keyof Settings](value)) return { error: `Invalid ${key}` };
    (changes as Record<string, unknown>)[key] = value;
  }
  return changes;
}
