import { newId } from '../utils/id';
import { quietly } from '../utils/quietly';

export const LAST_EMAIL_KEY = 'mahnee:lastEmail';
const EPOCH_KEY = 'mahnee:session';
export const sessionEpoch = () => quietly(() => localStorage.getItem(EPOCH_KEY));
export const startSessionEpoch = () => quietly(() => localStorage.setItem(EPOCH_KEY, newId()));
// A confirmed account mismatch makes the saved identity ineligible for offline use.
const RECHECK_KEY = 'mahnee:recheckAccount';
let recheckHere = false;
export const accountCheckRequired = () =>
  recheckHere || Boolean(quietly(() => localStorage.getItem(RECHECK_KEY)));
export function requireAccountCheck() {
  if (accountCheckRequired()) return;
  recheckHere = !quietly(() => {
    localStorage.setItem(RECHECK_KEY, '1');
    return true;
  });
  window.dispatchEvent(new Event(SESSION_EVENT));
}
export function accountChecked() {
  if (!accountCheckRequired()) return;
  recheckHere = false;
  quietly(() => localStorage.removeItem(RECHECK_KEY));
  window.dispatchEvent(new Event(SESSION_EVENT));
}
const LOGOUT_KEY = 'mahnee:logout';
const RETURN_KEY = 'mahnee:signInRequest';
const SESSION_EVENT = 'mahnee-session';

export const deviceAccount = () => quietly(() => localStorage.getItem(LAST_EMAIL_KEY));
let localLock: string | null = null;
export const logoutIntent = () => quietly(() => localStorage.getItem(LOGOUT_KEY)) ?? localLock;

function saveIntent(value: string) {
  localLock = quietly(() => {
    localStorage.setItem(LOGOUT_KEY, value);
    return true;
  })
    ? null
    : value;
}
export const cleanupOwner = (intent: string) => intent.split(':').slice(2).join(':');
export function cleanedDevice(intent: string) {
  if (logoutIntent() === intent) saveIntent(`pending:${intent.split(':')[1]}`);
}

export function lockDevice(email: string | null) {
  const intent = `clearing:${newId()}:${email ?? ''}`;
  saveIntent(intent);
  window.dispatchEvent(new Event(SESSION_EVENT));
  return intent;
}

let finishing: Promise<void> | undefined;

/** Clear the Access session once connectivity returns. The local lock remains until Sign in. */
export function finishRemoteLogout(): Promise<void> {
  const intent = logoutIntent();
  if (!intent?.startsWith('pending:')) return Promise.resolve();
  if (!finishing) {
    const finish = async () => {
      if (logoutIntent() !== intent) return;
      const response = await fetch('/cdn-cgi/access/logout', {
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'manual',
      });
      if (!response.ok && response.type !== 'opaqueredirect') throw new Error('Logout incomplete');
      if (logoutIntent() === intent) saveIntent(`done:${intent.slice(8)}`);
    };
    finishing = (
      navigator.locks ? navigator.locks.request('mahnee-access-logout', finish) : finish()
    )
      .then(() => undefined)
      .finally(() => {
        finishing = undefined;
      });
  }
  return finishing;
}

export async function prepareSignIn() {
  if (!logoutIntent()) return;
  if (navigator.onLine === false) throw new Error('Connect to sign in');
  if (logoutIntent()?.startsWith('clearing:')) throw new Error('Device cleanup incomplete');
  await finishRemoteLogout();
  const intent = logoutIntent();
  if (intent) sessionStorage.setItem(RETURN_KEY, intent);
}

/** Only a marked network return from the user's Sign in can unlock this browser. */
export function acceptSignInReturn() {
  const intent = logoutIntent();
  if (intent && quietly(() => sessionStorage.getItem(RETURN_KEY)) === intent) {
    localStorage.removeItem(LOGOUT_KEY);
  }
  quietly(() => sessionStorage.removeItem(RETURN_KEY));
}

/** Storage events reach other tabs; restored pages may have slept through the event. */
export function watchDeviceSession(changed: () => void) {
  const storage = (event: StorageEvent) => {
    if (
      event.key == null ||
      event.key === LOGOUT_KEY ||
      event.key === RECHECK_KEY ||
      event.key === LAST_EMAIL_KEY ||
      event.key === EPOCH_KEY
    )
      changed();
  };
  window.addEventListener('storage', storage);
  window.addEventListener('pageshow', changed);
  window.addEventListener(SESSION_EVENT, changed);
  document.addEventListener('visibilitychange', changed);
  return () => {
    window.removeEventListener('storage', storage);
    window.removeEventListener('pageshow', changed);
    window.removeEventListener(SESSION_EVENT, changed);
    document.removeEventListener('visibilitychange', changed);
  };
}
