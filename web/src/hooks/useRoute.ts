import { useEffect, useState } from 'react';
import { isMonth } from '@shared/ledger';
import { LAST_PAGE_KEY } from '../offline/cache';
import { thisMonth } from '../utils/date-input';
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
  | { view: 'activity' }
  | { view: 'plan'; month: string | null }
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

/** An earlier month named in the address (?month=2026-10); null for this one or none */
function readMonth(params: URLSearchParams) {
  const month = params.get('month');
  return isMonth(month) && month < thisMonth() ? month : null;
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
  if (params.has('activity')) return { view: 'activity' };
  if (params.has('plan')) return { view: 'plan', month: readMonth(params) };
  if (params.has('accounts')) return { view: 'accounts' };
  const account = params.get('account');
  if (account) return { view: 'account', id: account };
  return { view: 'home', month: readMonth(params) };
}

const ROUTE_CHANGE = 'routechange';
const SESSION_KEY = 'mahnee:session';
/** One-off parts of an address, never reopened on a fresh start: Home opens on this month */
const TRANSIENT: string[] = ['month'];

/** Remembers the page that's open, so the app can reopen there */
function rememberPage() {
  const params = new URLSearchParams(window.location.search);
  for (const key of TRANSIENT) params.delete(key);
  const search = params.toString();
  // Without storage, the app opens on the home page
  quietly(() => localStorage.setItem(LAST_PAGE_KEY, search ? `?${search}` : ''));
}

/**
 * Opening the app afresh at its start address (the installed app's icon, or typing the
 * address) goes back to the page that was open last time. A reload, or a link to a
 * particular page, keeps its own address. Called once at start, before the first render.
 */
export function restoreLastPage() {
  // Without storage, the app opens where the address says
  quietly(() => {
    const fresh = sessionStorage.getItem(SESSION_KEY) == null;
    sessionStorage.setItem(SESSION_KEY, '1');
    if (!fresh || window.location.search !== '') return;
    const last = localStorage.getItem(LAST_PAGE_KEY);
    if (last?.startsWith('?')) {
      window.history.replaceState(null, '', `${window.location.pathname}${last}`);
    }
  });
}

export function navigate(search: string, { replace = false } = {}) {
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
    const update = () => {
      setRoute(readRoute());
      rememberPage();
    };
    rememberPage();
    window.addEventListener('popstate', update);
    window.addEventListener(ROUTE_CHANGE, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(ROUTE_CHANGE, update);
    };
  }, []);

  return route;
}
