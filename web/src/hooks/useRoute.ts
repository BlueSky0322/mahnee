import { useEffect, useRef, useState } from 'react';
import { START_SCREENS, type StartScreen, isRowId } from '@shared/api';
import { isMonth } from '@shared/ledger';
import { LAST_EMAIL_KEY, START_SCREEN_KEY } from '../offline/cache';
import { addMonths, thisMonth } from '../utils/date-input';
import { quietly } from '../utils/quietly';

/** The sections of Settings, each at ?settings=<section>; the index is plain ?settings */
export const SETTINGS_SECTIONS = [
  'account',
  'money',
  'adding',
  'look',
  'budgets',
  'categories',
  'data',
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

/** The page that's open; each page the app gains adds its own view here */
export type Route =
  /** month: an earlier month Home or Plan shows (2026-10); null for this month */
  | { view: 'home'; month: string | null }
  /**
   * query: the address's filters, Activity's to read (components/activity/address.ts);
   * select: a phone opens selecting, with no tab bar
   */
  | { view: 'activity'; query: string; select: boolean }
  /**
   * half: Budgets (?plan) or Scheduled (?plan=scheduled); category: the one open
   * (?plan&category=<id>), a page of its own on phones and tablets, beside the table on a
   * computer
   */
  | {
      view: 'plan';
      month: string | null;
      half: 'budgets' | 'scheduled';
      category: string | null;
    }
  | { view: 'accounts' }
  | { view: 'account'; id: string }
  /** section: null for the index, and for a section that has no page yet */
  | { view: 'settings'; section: SettingsSection | null }
  | { view: 'import' };

/** Places that are always a tap away: the tab bar's and the sidebar's */
export type Place = 'home' | 'activity' | 'plan' | 'accounts';

/** The place a page belongs to, marked as open in the tab bar and sidebar; null for none */
export function placeOf(route: Route): Place | null {
  if (route.view === 'account') return 'accounts';
  if (route.view === 'settings' || route.view === 'import') return null;
  return route.view;
}

/**
 * A month named in the address (?month=2026-10); null for none. The person's month can be
 * named for the calendar month after this one (from the 16th on, shared/period.ts), so any
 * up to that one is read; the page shows this month for one that isn't earlier.
 */
function readMonth(params: URLSearchParams) {
  const month = params.get('month');
  return isMonth(month) && month <= addMonths(thisMonth(), 1) ? month : null;
}

const isSection = (value: string | null): value is SettingsSection =>
  (SETTINGS_SECTIONS as readonly (string | null)[]).includes(value);

/**
 * Older addresses, and what each became: ?search is Activity, ?categories a section of
 * Settings. The rest of the address is kept.
 */
const ALIASES: Record<string, [string, string]> = {
  search: ['activity', ''],
  categories: ['settings', 'categories'],
};

/** A query string as the app writes it: a part with no value is written bare (?activity) */
const writeSearch = (parts: [string, string][]) => {
  const text = parts
    .map(([k, v]) =>
      v === '' ? encodeURIComponent(k) : `${encodeURIComponent(k)}=${encodeURIComponent(v)}`,
    )
    .join('&');
  return text ? `?${text}` : '';
};

/** Puts what an older address became in its place, so Back never lands on it */
function replaceAlias() {
  const parts = [...new URLSearchParams(window.location.search)];
  if (!parts.some(([k]) => k in ALIASES)) return;
  const search = writeSearch(parts.map(([k, v]) => ALIASES[k] ?? [k, v]));
  window.history.replaceState(window.history.state, '', `${window.location.pathname}${search}`);
}

// Any address that names no other page is the home page. A page named first wins over the
// filters after it: ?activity&account=<id> is Activity, narrowed to that account.
function readRoute(): Route {
  replaceAlias();
  const params = new URLSearchParams(window.location.search);
  if (params.has('settings')) {
    const section = params.get('settings');
    return { view: 'settings', section: isSection(section) ? section : null };
  }
  if (params.has('import')) return { view: 'import' };
  if (params.has('activity')) {
    return { view: 'activity', query: params.toString(), select: params.has('select') };
  }
  if (params.has('plan')) {
    return {
      view: 'plan',
      month: readMonth(params),
      half: params.get('plan') === 'scheduled' ? 'scheduled' : 'budgets',
      category: readCategory(params.get('category')),
    };
  }
  if (params.has('accounts')) return { view: 'accounts' };
  const account = params.get('account');
  if (account) return { view: 'account', id: account };
  return { view: 'home', month: readMonth(params) };
}

/**
 * What ?plan&category= names in place of a category for every expense, or all income, over
 * 12 months (Home's "Expenses so far" and "Income" open them). A category's id is 16
 * hexadecimal digits, so neither can be one.
 */
export const ALL_EXPENSES = 'expenses';
export const ALL_INCOME = 'income';

export const isAll = (category: string): category is typeof ALL_EXPENSES | typeof ALL_INCOME =>
  category === ALL_EXPENSES || category === ALL_INCOME;

/** The category an address opens: all of them, or one by its id; any other text opens none */
const readCategory = (category: string | null) =>
  category != null && (isAll(category) || isRowId(category)) ? category : null;

const ROUTE_CHANGE = 'routechange';
/** Marks this tab as started, so a reload isn't taken for a fresh start */
export const SESSION_KEY = 'mahnee:session';

/**
 * A fresh start at the app's own address, until the account is known: what it opened, and
 * whose choice that was ({ opened, chosenBy }), kept for this tab
 */
const FRESH_START_KEY = 'mahnee:freshStart';

/** The page a start screen is at: Home's address is bare */
const startAddress = (start: StartScreen) => (start === 'home' ? '' : `?${start}`);

/**
 * Opening the app afresh at its start address (the installed app's icon, or typing the
 * address) opens on the place chosen in Look and start: Home, Activity or Plan. The choice
 * kept on this device is used only while its account is the one last signed in here, so the
 * first paint is right; rememberStartScreen() puts it right once the account is known. A
 * reload, or a link to a particular page, keeps its own address. Called once at start,
 * before the first render.
 */
export function openStartScreen() {
  // Without storage, the app opens where the address says
  quietly(() => {
    sessionStorage.removeItem(FRESH_START_KEY);
    const fresh = sessionStorage.getItem(SESSION_KEY) == null;
    sessionStorage.setItem(SESSION_KEY, '1');
    if (!fresh || window.location.search !== '') return;
    const kept = readKept();
    const chosenBy = localStorage.getItem(LAST_EMAIL_KEY);
    const start = kept != null && kept.email === chosenBy ? kept.start : 'home';
    sessionStorage.setItem(
      FRESH_START_KEY,
      JSON.stringify({
        opened: startAddress(start),
        chosenBy: kept != null && kept.email === chosenBy ? chosenBy : null,
      }),
    );
    if (start !== 'home') {
      window.history.replaceState(null, '', `${window.location.pathname}${startAddress(start)}`);
    }
  });
}

/** The page to open on kept on this device, and whose choice it is */
function readKept(): { email: string; start: StartScreen } | null {
  const kept = quietly(
    () => JSON.parse(localStorage.getItem(START_SCREEN_KEY) ?? 'null') as unknown,
  ) as { email?: unknown; start?: unknown } | null | undefined;
  if (kept == null || typeof kept.email !== 'string') return null;
  return (START_SCREENS as readonly unknown[]).includes(kept.start)
    ? { email: kept.email, start: kept.start as StartScreen }
    : null;
}

/**
 * Once it's known who's signed in and where they open the app: keeps that for the next
 * fresh start, and if this was one that opened somewhere else (someone else's choice, or
 * none kept yet) and nothing has been opened since, goes there now
 */
export function rememberStartScreen(email: string, start: StartScreen) {
  quietly(() => localStorage.setItem(START_SCREEN_KEY, JSON.stringify({ email, start })));
  const started = quietly(() => {
    const text = sessionStorage.getItem(FRESH_START_KEY);
    sessionStorage.removeItem(FRESH_START_KEY);
    return text == null ? null : (JSON.parse(text) as { opened: string; chosenBy: string | null });
  });
  if (started == null || started.chosenBy === email) return;
  if (window.location.search !== started.opened || startAddress(start) === started.opened) return;
  navigate(startAddress(start), { replace: true });
}

/**
 * A page with changes not saved can stop the app moving off it: given the address asked
 * for and how to go there anyway, it answers true when it has taken over (to ask first)
 */
export type LeaveGuard = (search: string, go: () => void) => boolean;
let leaveGuard: LeaveGuard | null = null;

/** Sets the page's guard while it's drawn; null for none */
export function useLeaveGuard(guard: LeaveGuard | null) {
  const latest = useRef(guard);
  latest.current = guard;
  useEffect(() => {
    const mine: LeaveGuard = (search, go) => latest.current?.(search, go) ?? false;
    leaveGuard = mine;
    return () => {
      if (leaveGuard === mine) leaveGuard = null;
    };
  }, []);
}

export function navigate(search: string, { replace = false, force = false } = {}) {
  if (!force && leaveGuard?.(search, () => navigate(search, { replace, force: true }))) return;
  const url = `${window.location.pathname}${search}`;
  // A page opened from another remembers which, so going "up" can be Back
  const from = replace ? cameFrom() : window.location.search;
  if (replace) window.history.replaceState({ from }, '', url);
  else window.history.pushState({ from }, '', url);
  window.dispatchEvent(new Event(ROUTE_CHANGE));
}

/**
 * Goes "up" to `address`: Back when this page was opened from there, so the history
 * doesn't grow, else straight there in this page's place
 */
export function goUp(address: string) {
  if (cameFrom() === address) {
    window.history.back();
    return;
  }
  navigate(address, { replace: true });
}

/**
 * Closes Settings: back to the page it was opened over, or Home when it was opened at its
 * own address
 */
export function closeSettings() {
  const from = cameFrom();
  if (from != null && !new URLSearchParams(from).has('settings')) {
    window.history.back();
    return;
  }
  navigate('', { replace: true });
}

/** The address this page was opened from in the app, if it was */
const cameFrom = (): string | null => {
  const state: unknown = window.history.state;
  const from =
    typeof state === 'object' && state != null ? (state as { from?: unknown }).from : null;
  return typeof from === 'string' ? from : null;
};

// Pages are picked from the query string, as navigate() sets it
export function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const update = () => setRoute(readRoute());
    window.addEventListener('popstate', update);
    window.addEventListener(ROUTE_CHANGE, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(ROUTE_CHANGE, update);
    };
  }, []);

  return route;
}
