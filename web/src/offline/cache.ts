import { createStore, del, get, keys, set, update } from 'idb-keyval';
import { writeAs } from '../api';
import {
  LAST_EMAIL_KEY,
  acceptSignInReturn,
  accountCheckRequired,
  deviceAccount,
  logoutIntent,
  sessionEpoch,
  startSessionEpoch,
} from './device-session';
export { LAST_EMAIL_KEY } from './device-session';
import { quietly } from '../utils/quietly';

// Last-seen copies of API responses (the profile, the ledger) and the changes not yet
// saved (the outbox), kept in IndexedDB so pages show instantly on reload and work
// offline. Entries are tagged with the signed-in email, and nothing is served until it's
// known who that is, so a different person on the same browser never sees the previous
// person's data.

/**
 * The page a fresh start opens on ("Open the app on"), as { email, start }: that account's
 * choice, used only while it's the one last signed in here (see hooks/useRoute)
 */
export const START_SCREEN_KEY = 'mahnee:startScreen';
/**
 * The signed-in email in IndexedDB, read by public/sw.js to send only that account's
 * changes (USER_KEY there; sw.test.ts runs it against what the app keeps)
 */
export const SW_USER_KEY = 'mahnee:user';
/**
 * Profile pictures the service worker keeps, one cache per account named with its email
 * after this prefix (IMAGE_CACHE_PREFIX in public/sw.js; sw.test.ts runs it against this)
 */
export const IMAGE_CACHE_PREFIX = 'mahnee-pictures-v1:';
/**
 * Keys of work not yet on the server: the outbox of changes (OUTBOX_PREFIX in
 * outbox.ts) and profile changes (PROFILE_OUTBOX_PREFIX in profile/unsent.ts). Kept for their own account when someone else signs in, readable and
 * sendable by nobody else (outbox.test.ts checks these match)
 */
export const UNSENT_PREFIXES = ['outbox:', 'profile-outbox:'];
/**
 * Marks the page when the service worker opened it from the copy it keeps, because the
 * server didn't send it in time (OPENED_FROM_DEVICE in public/sw.js)
 */
export const OPENED_FROM_DEVICE = 'sf-opened-from-device';
/**
 * That marker's content when Cloudflare Access asked to sign in again, rather than the
 * server being out of reach (SIGNED_OUT in public/sw.js)
 */
export const OPENED_SIGNED_OUT = 'signed-out';
/**
 * Marks a page load as going to sign in: the service worker leaves it to the browser, so
 * Cloudflare Access's sign-in page shows rather than the kept page (SIGN_IN_PARAM in
 * public/sw.js)
 */
export const SIGN_IN_PARAM = 'sign-in';

/** An entry as stored; public/sw.js reads the same shape */
interface Entry<T> {
  email: string;
  value: T;
  /** When it was kept (ms): for a server's answer, when the server last confirmed it */
  at?: number;
}

/** Storage can be unavailable (private browsing, quota); the app works without it */
async function quietlyAsync<T>(access: () => Promise<T>): Promise<T | undefined> {
  try {
    return await access();
  } catch {
    return undefined;
  }
}

const lastEmail = () => deviceAccount() ?? null;

let establishedEpoch: string | null | undefined;
let persistedOwner = false;
export const sessionBlocked = () =>
  Boolean(logoutIntent()) ||
  accountCheckRequired() ||
  (user != null &&
    ((persistedOwner && deviceAccount() !== user) || establishedEpoch !== sessionEpoch()));

// Who the cache is for: unknown until the server says (or, offline, the last person
// here is assumed). Reads and writes wait until then. It can change once more, when
// the server answers after an offline start as someone else.
let user: string | null = null;
let waiting: ((email: string) => void)[] = [];

/** Whose the cache is now, or null while that isn't known */
export const cacheUser = () => user;

/** Resolves with whose the cache is, once that's known */
export const whenCacheUserKnown = (): Promise<string> =>
  user != null ? Promise.resolve(user) : new Promise((resolve) => waiting.push(resolve));

function confirmCacheUser(email: string) {
  user = email;
  establishedEpoch = sessionEpoch();
  persistedOwner = deviceAccount() === email;
  // The page's writes are made as this account, and refused once it's anyone else's
  writeAs(email);
  for (const resolve of waiting) resolve(email);
  waiting = [];
  knowers.forEach((know) => know(email));
}

// What else the page picks up once it knows whose the cache is (changes left unsent)
const knowers = new Set<(email: string) => void>();

/**
 * Runs `know` each time it's known whose this device's cache is: signed in, or (offline)
 * the last person here assumed
 */
export const onCacheUserKnown = (know: (email: string) => void) => void knowers.add(know);

export async function readCache<T>(key: string): Promise<T | undefined> {
  return (await readCacheEntry<T>(key))?.value;
}

/**
 * What's kept under `key` for the signed-in person, with when it was kept (null for a
 * copy kept before that was noted)
 */
export async function readCacheEntry<T>(
  key: string,
): Promise<{ value: T; at: number | null } | undefined> {
  const email = await whenCacheUserKnown();
  const entry = await quietlyAsync(() => get<Entry<T>>(key));
  return entry?.email === email && user === email && !sessionBlocked()
    ? { value: entry.value, at: entry.at ?? null }
    : undefined;
}

/** Whether `access` worked; storage failing is reported, not thrown */
const succeeds = (access: () => Promise<unknown>): Promise<boolean> =>
  access().then(
    () => true,
    () => false,
  );

/** Resolves with whether it was kept */
export async function writeCache<T>(key: string, value: T): Promise<boolean> {
  const email = await whenCacheUserKnown();
  if (user !== email || sessionBlocked()) return false;
  return succeeds(() => set(key, { email, value, at: Date.now() } satisfies Entry<T>));
}

/**
 * What `email` kept under `key`, read only while they're the one signed in here: for
 * work kept for one account, which must never reach another
 */
export async function readCacheAs<T>(email: string, key: string): Promise<T | undefined> {
  if (user !== email || sessionBlocked()) return undefined;
  const entry = await quietlyAsync(() => get<Entry<T>>(key));
  return entry?.email === email && user === email && !sessionBlocked() ? entry.value : undefined;
}

/**
 * Keeps `value` for `email`, only while they're the one signed in here. Resolves with
 * whether it was kept.
 */
export async function writeCacheAs<T>(email: string, key: string, value: T): Promise<boolean> {
  if (user !== email || sessionBlocked()) return false;
  return succeeds(() => set(key, { email, value } satisfies Entry<T>));
}

/** Updates a device copy in one transaction. Returning undefined leaves the copy as it was. */
export async function updateCacheAs<T>(
  email: string,
  key: string,
  updater: (value: T | undefined, at: number | null) => T | undefined,
): Promise<boolean> {
  if (user !== email || sessionBlocked()) return false;
  try {
    await update<Entry<T> | undefined>(key, (entry) => {
      if (user !== email || sessionBlocked() || (entry != null && entry.email !== email))
        return entry;
      const value = updater(entry?.value, entry?.at ?? null);
      return value === undefined ? entry : { email, value, at: Date.now() };
    });
    return true;
  } catch {
    return false;
  }
}

/** Resolves with whether it was removed */
export const removeCacheEntry = (key: string) => succeeds(() => del(key));

/** The ids kept under a key prefix, whoever's they are */
export const listCacheIds = async (prefix: string): Promise<string[]> =>
  ((await quietlyAsync(() => keys())) ?? [])
    .filter((k): k is string => typeof k === 'string' && k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));

/** Whose the kept page to open on is, or null */
function keptFor(text: string): string | null {
  const kept = quietly(() => JSON.parse(text) as unknown);
  return typeof kept === 'object' &&
    kept != null &&
    typeof (kept as { email?: unknown }).email === 'string'
    ? (kept as { email: string }).email
    : null;
}

/**
 * Call once the signed-in email is known; someone else's cache is dropped
 */
export async function setCacheUser(email: string): Promise<void> {
  if (navigator.locks)
    return navigator.locks.request('mahnee-device-owner', () => establishOwner(email));
  return establishOwner(email);
}

async function establishOwner(email: string): Promise<void> {
  if (logoutIntent()) throw new Error('Signed out');
  if (lastEmail() !== email) {
    // The page to open on is kept when it's this person's own (nobody was signed in before)
    const start =
      lastEmail() == null ? quietly(() => localStorage.getItem(START_SCREEN_KEY)) : null;
    // What the last account hasn't sent yet stays, theirs alone, for when they're back
    await clearCache(() => true);
    if (logoutIntent() || (lastEmail() != null && lastEmail() !== email))
      throw new Error('Account changed');
    quietly(() => {
      if (start != null && keptFor(start) === email) localStorage.setItem(START_SCREEN_KEY, start);
      if (lastEmail() !== email) {
        startSessionEpoch();
        localStorage.setItem(LAST_EMAIL_KEY, email);
      }
    });
  }
  // For the service worker, which sends this account's changes and nobody else's
  await quietlyAsync(() => set(SW_USER_KEY, email));
  if (logoutIntent() || (lastEmail() != null && lastEmail() !== email))
    throw new Error('Account changed');
  confirmCacheUser(email);
}

/**
 * Offline, the server can't say who's signed in: carry on as the last person signed
 * in on this device, so what they saw last is there. Returns
 * their email, or null if nobody has signed in here.
 */
export function assumeLastUser(): string | null {
  const email = logoutIntent() || accountCheckRequired() ? null : lastEmail();
  if (email) confirmCacheUser(email);
  return email;
}

/**
 * The service worker opened this page from the copy it keeps, as the server didn't send
 * it in time: the connection is down or slow, or the server is failing
 */
export const openedFromDevice = () =>
  document.querySelector(`meta[name="${OPENED_FROM_DEVICE}"]`) != null;

/** The service worker opened this page from its copy because Cloudflare Access asked to sign in */
export const openedSignedOut = () =>
  document.querySelector(`meta[name="${OPENED_FROM_DEVICE}"]`)?.getAttribute('content') ===
  OPENED_SIGNED_OUT;

/** This page's address, marked to go to sign in and come back to it */
export function signInAddress(): string {
  const url = new URL(window.location.href);
  url.searchParams.set(SIGN_IN_PARAM, '');
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Back from signing in: the mark comes off the address, which is otherwise as it was */
export function dropSignInMark() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has(SIGN_IN_PARAM)) return;
  acceptSignInReturn();
  url.searchParams.delete(SIGN_IN_PARAM);
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

// What else the page holds for the account, forgotten with the cache
const forgetters = new Set<() => void | Promise<void>>();

/** Runs `forget` whenever this device's cache is emptied: on signing out, or someone else signing in */
export const onCacheCleared = (forget: () => void | Promise<void>) => void forgetters.add(forget);

/**
 * Empties this device's cache, which is then nobody's until setCacheUser. Work not yet
 * sent is kept for the accounts `keepUnsentOf` names: tagged with their email, it's
 * nobody else's to see or send.
 */
export async function clearCache(
  keepUnsentOf: (email: string) => boolean = () => false,
  leaving?: string,
): Promise<void> {
  user = null;
  writeAs(null);
  const cleanup = [...forgetters].map((forget) => forget());
  quietly(() => {
    localStorage.removeItem(LAST_EMAIL_KEY);
    // The page they open on is theirs too
    localStorage.removeItem(START_SCREEN_KEY);
  });
  const storage = clearExceptUnsent(keepUnsentOf, leaving);
  // Pictures the service worker kept, so the next person can't see them
  if ('caches' in window) cleanup.push(clearImageCaches());
  const finished = Promise.all([storage, ...cleanup]);
  if (leaving === undefined) await finished.catch(() => undefined);
  else await finished;
}

async function clearImageCaches() {
  const names = (await caches.keys()).filter((name) => name.startsWith(IMAGE_CACHE_PREFIX));
  await Promise.all(names.map((name) => caches.delete(name)));
}

/** Purge and retain records in one transaction, including only refused changes for the departing user. */
const deviceStore = createStore('keyval-store', 'keyval');
async function clearExceptUnsent(keep: (email: string) => boolean, leaving?: string) {
  return deviceStore(
    'readwrite',
    (entries) =>
      new Promise<void>((resolve, reject) => {
        entries.transaction.oncomplete = () => resolve();
        entries.transaction.onabort = () =>
          reject(new Error('Could not clear stored account data'));
        const request = entries.openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (cursor == null) return;
          const key = cursor.key;
          const entry = cursor.value as Entry<unknown> | undefined;
          const pending =
            typeof key === 'string' && UNSENT_PREFIXES.some((prefix) => key.startsWith(prefix));
          if (!pending || !entry || !keep(entry.email) || key === `profile-outbox:${leaving}`)
            cursor.delete();
          else if (
            leaving &&
            entry.email === leaving &&
            key === `outbox:${leaving}` &&
            Array.isArray(entry.value)
          ) {
            const refused = entry.value.filter(
              (change: { refused?: unknown } | null) => change?.refused != null,
            );
            if (refused.length) cursor.update({ ...entry, value: refused });
            else cursor.delete();
          }
          cursor.continue();
        };
      }),
  );
}
