import type { Category, ImportRecord, Settings, StartScreen, ThemeSetting } from '@shared/api';
import { DEFAULT_CURRENCY } from '@shared/ledger';

// What the Settings index says under each section (R-Settings), worked out from the
// person's settings, categories and imports, and how a recent import reads (R-Set-Data,
// R-Desk-Data)

/** The settings' last day of the month (shared/settings.ts LAST_DAY_OF_MONTH) */
const LAST_DAY = 31;

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st, 22nd, 23rd */
export function ordinal(n: number) {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th'}`;
}

/** "MYR · month from the 1st", "… from the last day", "… from payday" */
export function moneySummary(settings: Settings) {
  const start =
    settings.monthStartMode === 'payday'
      ? 'payday'
      : settings.monthStartDay === LAST_DAY
        ? 'the last day'
        : `the ${ordinal(settings.monthStartDay)}`;
  return `${DEFAULT_CURRENCY} · month from ${start}`;
}

/** "Amount first · suggestions on" */
export const addingSummary = (settings: Settings) =>
  `${settings.startWith === 'amount' ? 'Amount' : 'Category'} first · suggestions ${
    settings.suggestAsYouType ? 'on' : 'off'
  }`;

const THEME_NAMES: Record<ThemeSetting, string> = {
  auto: 'Match phone',
  light: 'Light',
  dark: 'Dark',
};

/** The page the app opens on, as Look and start names it */
export const START_NAMES: Record<StartScreen, string> = {
  home: 'Home',
  activity: 'Activity',
  plan: 'Plan',
};

/** "Match phone · opens on Home" */
export const lookSummary = (settings: Settings) =>
  `${THEME_NAMES[settings.theme]} · opens on ${START_NAMES[settings.startScreen]}`;

/** A time on the person's clock (21:00) as the app shows it: "9:00 PM" */
export function clockText(time: string) {
  const [hours, minutes] = time.split(':').map(Number);
  const twelve = hours % 12 === 0 ? 12 : hours % 12;
  return `${twelve}:${String(minutes).padStart(2, '0')} ${hours < 12 ? 'AM' : 'PM'}`;
}

/** "Carry over on · daily at 9:00 PM", or "… · no daily reminder" */
export const budgetsSummary = (settings: Settings) =>
  `Carry over ${settings.carryOverDefault ? 'on' : 'off'} · ${
    settings.dailyReminder ? `daily at ${clockText(settings.reminderTime)}` : 'no daily reminder'
  }`;

/** "8 expense, 2 income": the top-level categories in use, of each kind */
export function categoriesSummary(categories: readonly Category[]) {
  const listed = categories.filter((c) => c.parentId == null && !c.archived);
  const of = (kind: Category['kind']) => listed.filter((c) => c.kind === kind).length;
  return `${of('expense')} expense, ${of('income')} income`;
}

/** A day as Recent imports says it: "Nov 2", with the year when it isn't this one */
export function dayOf(at: number, now = Date.now()) {
  const day = new Date(at);
  const sameYear = day.getFullYear() === new Date(now).getFullYear();
  return day.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
}

/** "Last import Nov 2" for the latest import (newest first), or "No imports yet" */
export const importsSummary = (imports: readonly ImportRecord[], now = Date.now()) =>
  imports.length === 0 ? 'No imports yet' : `Last import ${dayOf(imports[0].createdAt, now)}`;

/**
 * A recent import's line: on phones all of it ("Nov 2 · into Maybank Savings · 38 added"),
 * on computers where it went and how many apart ("38 added, 4 skipped"). A Mahnee export
 * went into no one account (`account` null).
 */
export function importLine(record: ImportRecord, account: string | null, now = Date.now()) {
  const where = `${dayOf(record.createdAt, now)}${account == null ? '' : ` · into ${account}`}`;
  const added = `${record.addedCount.toLocaleString('en')} added`;
  return {
    line: `${where} · ${added}`,
    where,
    counts:
      record.skippedCount > 0
        ? `${added}, ${record.skippedCount.toLocaleString('en')} skipped`
        : added,
  };
}

const on = (yes: boolean) => (yes ? 'On' : 'Off');

/**
 * What a setting is set to, as its row says it until its section has controls (pieces to
 * come): "The 1st", "Monday", "Last used", "9:00 PM", "1 day before". `accountName` names
 * the account Add starts on.
 */
export function settingValue(
  key: string,
  settings: Settings,
  { accountName = null, desktop = false }: { accountName?: string | null; desktop?: boolean } = {},
): string | null {
  switch (key) {
    case 'currency':
      return `${DEFAULT_CURRENCY}, RM`;
    case 'monthStart':
      return settings.monthStartMode === 'payday'
        ? 'Payday'
        : settings.monthStartDay === LAST_DAY
          ? 'Last day'
          : `The ${ordinal(settings.monthStartDay)}`;
    case 'weekStart':
      return settings.weekStart === 'monday' ? 'Monday' : 'Sunday';
    case 'startWith':
      return settings.startWith === 'amount' ? 'Amount' : 'Category';
    case 'account':
      return settings.defaultAccountId == null ? 'Last used' : accountName ?? 'Last used';
    case 'suggest':
      return on(settings.suggestAsYouType);
    case 'time':
      return on(settings.askForTime);
    case 'theme':
      return settings.theme === 'auto'
        ? desktop
          ? 'Match device'
          : 'Match phone'
        : THEME_NAMES[settings.theme];
    case 'accent':
      return settings.accent[0].toUpperCase() + settings.accent.slice(1);
    case 'expenseColour':
      return settings.expenseColour === 'ink' ? 'Expenses in ink' : 'Expenses in red';
    case 'homeShows':
      return settings.homeDensity === 'everything' ? 'Everything' : 'Essentials';
    case 'start':
      return START_NAMES[settings.startScreen];
    case 'carryOver':
      return on(settings.carryOverDefault);
    case 'dailyReminder':
      return on(settings.dailyReminder);
    case 'remindAt':
      return clockText(settings.reminderTime);
    case 'beforeScheduled':
      return settings.scheduledReminderDays == null
        ? 'Off'
        : `${settings.scheduledReminderDays} ${settings.scheduledReminderDays === 1 ? 'day' : 'days'} before`;
    default:
      return null;
  }
}
