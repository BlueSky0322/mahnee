import { useMantineColorScheme } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import type { Profile } from '../api';
import { ApiError, api } from '../api';
import {
  accountCheckRequired,
  accountChecked,
  cleanedDevice,
  cleanupOwner,
  deviceAccount,
  finishRemoteLogout,
  lockDevice,
  logoutIntent,
  prepareSignIn,
  watchDeviceSession,
} from '../offline/device-session';
import { ME_KEY, queryClient } from '../query-client';
import { isOffline, isOfflineFailure } from '../offline/network';
import { isRetryable } from '../offline/outbox';
import type { Pending } from './unsent';
import {
  canWait,
  eachField,
  fieldsOf,
  keepUnsent,
  keepUnsentUnder,
  merged,
  readPending,
  settleUnsent,
  withPatch,
} from './unsent';
import {
  assumeLastUser,
  cacheUser,
  clearCache,
  openedFromDevice,
  openedSignedOut,
  readCache,
  setCacheUser,
  sessionBlocked,
  signInAddress,
  writeCacheAs,
} from '../offline/cache';
import { isAccent } from '@shared/accents';
import { isTimeZone } from '@shared/settings';
import {
  DEFAULT_SETTINGS,
  THEMES,
  currencyNow,
  isConverting,
  type Accent,
  type Conversion,
  type PictureChoice,
  type ProfilePatch,
  type Settings,
  type ThemeSetting,
} from '@shared/api';
import { rememberStartScreen } from '../hooks/useRoute';
import { letGoHere, releaseForOthers } from '../reminders/push-device';
import { showAccent, showExpenseColour } from '../theme/appearance';
import { showError } from '../utils/notify';
import { showToast } from '../utils/toasts';
import { quietly } from '../utils/quietly';

// The signed-in user's profile. Theme and accent are also kept in localStorage so
// the app paints in the right colours before /api/me answers.
/** Also read by index.html's first screen, before the app's code loads */
export const APPEARANCE_KEY = 'sf-appearance';

export interface Appearance {
  theme: ThemeSetting;
  accent: Accent;
}

const isTheme = (value: unknown): value is ThemeSetting =>
  (THEMES as readonly unknown[]).includes(value);

export function readAppearance(): Appearance {
  // Whatever was saved, checked field by field
  const saved = quietly(
    () => JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? '{}') as Record<string, unknown>,
  );
  return {
    theme: isTheme(saved?.theme) ? saved.theme : DEFAULT_SETTINGS.theme,
    accent: isAccent(saved?.accent) ? saved.accent : DEFAULT_SETTINGS.accent,
  };
}

// Without storage, the colours just load a moment later next time
const saveAppearance = (appearance: Appearance) =>
  quietly(() => localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance)));

/** What a save answers with: the saved profile, what it changed, or nothing new */
type Saved = Profile | ((profile: Profile) => Profile) | void;

interface ProfileContextValue {
  profile: Profile | null;
  /** Signed out, with nothing kept on this device to show meanwhile */
  signedOut: boolean;
  /**
   * Cloudflare Access asked to sign in again, and what the last account saw is shown
   * meanwhile, until they've signed in
   */
  signInToSync: boolean;
  /** The server couldn't be reached, or failed, before the profile loaded */
  unreachable: boolean;
  /** Asks the server again */
  retry: () => void;
  /**
   * Saves profile fields or settings, showing the change straight away. Rejects if it
   * isn't saved (the change is undone), for the caller to say so.
   */
  update: (patch: ProfilePatch) => Promise<void>;
  /**
   * Shows a change straight away and saves it, as update() does: rejects if it isn't
   * saved (the change is undone). `save` may answer with the saved profile, or with what
   * the save changed, applied to the profile as it is then.
   */
  change: (show: (profile: Profile) => Profile, save: () => Promise<Saved>) => Promise<void>;
  /**
   * For preferences and the name: shown at once, then saved in the background with any
   * others changed in the moments after it (SETTINGS_QUIET_MS), as one save, and said with
   * a quiet message once it lands; a failure is explained, with Retry. `track` follows the
   * save, to the end of its batch's (resolving whatever the outcome).
   */
  rememberSettings: (
    settings: Partial<Settings>,
    track?: (saving: Promise<void>) => Promise<unknown>,
  ) => void;
  /** The same for the display name */
  rememberName: (displayName: string | null) => void;
  /** Sends the settings still in their pause now (leaving Settings, signing out) */
  flushSettings: () => Promise<void>;
  /**
   * Shows a chosen photo (made small already), or the Google picture or the initial, in
   * place of the initial, and saves it; rejects if it isn't saved (what was there comes back)
   */
  changePicture: (to: Blob | PictureChoice) => Promise<void>;
  /** Replaces the profile with one the server returned */
  replace: (profile: Profile) => void;
  /** Changes the profile on screen from its latest value */
  patch: (change: (profile: Profile) => Profile) => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

/** Versioned like the other saved copies: one in an older shape is never read */
const ME_CACHE_KEY = 'me-v2';
/**
 * How long an app opened from the device's copy waits on the server before showing the
 * last account's saved profile
 */
export const DEVICE_START_WAIT_MS = 2000;
/** How often the server is asked whether amounts have finished converting */
export const CONVERSION_POLL_MS = 2000;

export const useProfile = () => {
  const value = useContext(ProfileContext);
  if (value == null) throw new Error('useProfile needs a ProfileProvider');
  return value;
};

/**
 * The currency amounts are in, to show them in: the home currency, or while amounts are
 * converting into a new one, the one they're still in
 */
export function useCurrency() {
  // Drawn alone (a part on its own in a test), the default
  const profile = useContext(ProfileContext)?.profile;
  return profile == null ? DEFAULT_SETTINGS.currency : currencyNow(profile);
}

/**
 * How far the conversion under way has got, as the server last said while the app asked:
 * kept apart from the profile, so each answer redraws only what shows it
 */
let progressNow: { since: number; progress: Conversion['progress'] | null } | null = null;
const progressListeners = new Set<() => void>();
function showProgress(conversion: Conversion | null) {
  const progress = conversion?.progress ?? null;
  const now = progressNow;
  if (
    now?.since === conversion?.since &&
    now?.progress?.done === progress?.done &&
    now?.progress?.total === progress?.total
  ) {
    return;
  }
  progressNow = conversion == null ? null : { since: conversion.since, progress };
  progressListeners.forEach((listener) => listener());
}
const subscribeProgress = (listener: () => void) => {
  progressListeners.add(listener);
  return () => progressListeners.delete(listener);
};

/**
 * How long settings wait after the last change before they're sent, together. Every
 * settings control saves a choice made (a tap, a pick, a sheet's Done or Save); none saves
 * while typing, so one pause serves them all.
 */
export const SETTINGS_QUIET_MS = 300;
/** How long a change the server couldn't take just then waits before it's sent again */
export const SETTINGS_RESEND_MS = 15_000;
/** How long the message saying they were saved stays */
const SAVED_SAY_MS = 2500;
/** The message saying settings were saved, or weren't: one at a time, the latest replacing it */
const SAVED_TOAST = 'settings-saved';

/**
 * How many settings are changed and not yet answered for: waiting out their pause or on
 * their way. The sync cloud counts them with the ledger's changes, to say Saving.
 */
let settingsOnTheirWay = 0;
const savingListeners = new Set<() => void>();
function countSaving(by: number) {
  if (by === 0) return;
  settingsOnTheirWay += by;
  savingListeners.forEach((listener) => listener());
}
const subscribeSaving = (listener: () => void) => {
  savingListeners.add(listener);
  return () => void savingListeners.delete(listener);
};
export const useSettingsSaving = () =>
  useSyncExternalStore(subscribeSaving, () => settingsOnTheirWay);

/** One field of the profile as shown: the name, or a setting */
const valueOf = (profile: Profile, field: string): unknown =>
  field === 'displayName'
    ? profile.displayName
    : (profile.settings as unknown as Record<string, unknown>)[field];

/** The fields named, with the values `of` gives them, as a patch */
function patchOf(fields: string[], of: (field: string) => unknown): ProfilePatch {
  const patch: ProfilePatch = {};
  const settings: Record<string, unknown> = {};
  for (const field of fields) {
    if (field === 'displayName') patch.displayName = of(field) as string | null;
    else settings[field] = of(field);
  }
  if (Object.keys(settings).length > 0) patch.settings = settings;
  return patch;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Settings changed within moments of each other, sent as one save */
interface Batch {
  email: string;
  /** What each field changed showed before its first change here */
  before: Map<string, unknown>;
  /** Fields that were already waiting on this device before this batch changed them */
  waitedBefore: Set<string>;
  /** Fields whose earlier waiting has been looked up */
  looked: Set<string>;
  /** What this batch kept on the device, with each field's revision; null until kept */
  kept: Pending | null;
  /** The device couldn't keep one of its changes */
  unkept: boolean;
  /**
   * One of its changes was made without a connection: it waits with the others kept so,
   * and is sent as they are (a failure keeps it waiting rather than putting it back)
   */
  madeOffline: boolean;
  /** Its changes being kept on the device, in order */
  writes: Promise<void>;
  /** The change it last made, to know whether a newer one came since */
  lastId: number;
  /** Each field's latest change in this batch, to know whether a newer one came since */
  edits: Map<string, number>;
  /** How many of its fields the sync cloud counts */
  counted: number;
  /** Those following it (`track`), told once it has been dealt with */
  done: (() => void)[];
}

/** How a batch's save went: what the message says */
type Outcome =
  | { kind: 'saved' | 'offline' | 'signedOut' | 'waiting' | 'said' }
  | {
      kind: 'failed';
      err: unknown;
      /** What wasn't saved, as it was sent: what Retry sends again */
      again: ProfilePatch;
      /** Each of those fields' latest change then, so Retry skips one changed since */
      edits: Map<string, number>;
    };

/** Why a save didn't land, as far as what's kept on the device goes */
type Unsaved = 'offline' | 'signedOut' | 'waiting' | 'refused';

/**
 * Without a connection, or signed in no longer, it waits; an answer that says nothing
 * about the change (busy, unavailable, too slow, another account's) waits too, as the
 * outbox treats it (isRetryable). Anything else is a refusal, put back: the server's own
 * failure (500) among them, since sending it again could fail the same way for ever.
 */
function unsavedBy(err: unknown): Unsaved {
  if (isOfflineFailure(err)) return 'offline';
  if (err instanceof ApiError && err.status === 401) return 'signedOut';
  if (isRetryable(err) && !(err instanceof ApiError && err.status === 500)) return 'waiting';
  return 'refused';
}

/** Two profiles the same but for how far a conversion has got */
const sameButProgress = (a: Profile, b: Profile | null) =>
  b != null &&
  JSON.stringify({ ...a, conversion: a.conversion && { ...a.conversion, progress: null } }) ===
    JSON.stringify({ ...b, conversion: b.conversion && { ...b.conversion, progress: null } });

/**
 * How far the conversion into a new home currency has got, while one is under way: the
 * latest the server said, else what the profile came with; null when it isn't said
 */
export function useConversionProgress(): Conversion['progress'] | null {
  const profile = useContext(ProfileContext)?.profile;
  const asked = useSyncExternalStore(subscribeProgress, () => progressNow);
  const conversion = profile?.conversion;
  if (conversion == null || conversion.refused != null) return null;
  // Only what was said about this conversion, never one before it
  const said = asked?.since === conversion.since ? asked.progress : null;
  return said ?? conversion.progress ?? null;
}

/** The name to show for someone: their display name, else the part of the email before @ */
export const nameFor = (email: string, displayName?: string | null) =>
  displayName?.trim() || email.split('@')[0];

/**
 * Keeps a profile the server answered with as the device's copy, for whoever it's for,
 * only while they're the one signed in here
 */
const keepCopy = (profile: Profile) => void writeCacheAs(profile.email, ME_CACHE_KEY, profile);

const profileSends = new Map<string, Promise<unknown>>();

/** Serialize profile sends in this tab, or across tabs when Web Locks are available. */
function withProfileSendLock<T>(email: string, send: () => Promise<T>): Promise<T> {
  if (navigator.locks != null) {
    return navigator.locks.request(`mahnee-profile-send:${email}`, send) as Promise<T>;
  }
  const next = (profileSends.get(email) ?? Promise.resolve()).then(send, send);
  profileSends.set(email, next);
  const done = () => {
    if (profileSends.get(email) === next) profileSends.delete(email);
  };
  void next.then(done, done);
  return next;
}

/** Cloudflare Access sent the request to sign in: the session ran out */
const isSignInAnswer = (err: unknown) => err instanceof ApiError && err.status === 401;

/**
 * Goes to Cloudflare Access to sign in, then back to this page. Marked so the service
 * worker lets Access answer rather than showing its kept copy.
 */
export function signIn() {
  const go = () => {
    window.location.href = signInAddress();
  };
  if (!logoutIntent()) return go();
  void completeDeviceCleanup()
    .then(prepareSignIn)
    .then(go)
    .catch((err) => showError(err, 'Connect to finish signing out, then sign in again.'));
}

let cleaning: Promise<void> | undefined;
function completeDeviceCleanup() {
  const intent = logoutIntent();
  if (!intent?.startsWith('clearing:')) return Promise.resolve();
  return (cleaning ??= clearCache(() => true, cleanupOwner(intent))
    .then(() => cleanedDevice(intent))
    .finally(() => {
      cleaning = undefined;
    }));
}

export async function signOut() {
  const leaving = cacheUser() ?? deviceAccount() ?? null;
  lockDevice(leaving);
  // Start unsubscribing while this page can still name the account on its write.
  try {
    await Promise.all([letGoHere(leaving), completeDeviceCleanup()]);
  } catch (err) {
    showError(err, 'Could not finish clearing this device. Cleanup will be retried.');
    return;
  }
  if (!isOffline()) window.location.href = '/cdn-cgi/access/logout';
}

export function ProfileProvider({
  children,
  sayChanged,
}: {
  children: ReactNode;
  /**
   * What a saved change of one setting says ("Accent set to Plum"); null for one that
   * reads better as "Settings saved"
   */
  sayChanged?: (patch: ProfilePatch, profile: Profile) => string | null;
}) {
  const blocked = useSyncExternalStore(watchDeviceSession, sessionBlocked);
  const [staleTab, setStaleTab] = useState(false);
  const restarting = useRef(false);
  const initialDeviceOwner = useRef(deviceAccount());
  const reloadWithOwner = useCallback(() => {
    if (restarting.current || logoutIntent()) return;
    restarting.current = true;
    window.location.reload();
  }, []);
  useEffect(() => {
    if (!blocked || !logoutIntent()) return;
    queryClient.clear();
    const finish = () => {
      if (!isOffline())
        void completeDeviceCleanup()
          .then(finishRemoteLogout)
          .catch(() => undefined);
    };
    // The initiating page owns its cleanup until the logout navigation; a later launch retries it.
    if (cacheUser() == null) finish();
    window.addEventListener('online', finish);
    return () => window.removeEventListener('online', finish);
  }, [blocked]);
  const fromDevice = useRef(false);
  // Sends what was changed here without a connection (set below, once update's parts are)
  const sendUnsent = useRef<() => Promise<void>>(() => Promise.resolve());
  const [signInToSync, setSignInToSync] = useState(false);
  // Whose saved copies were shown while the server couldn't say who's signed in
  const assumed = useRef<string | null>(null);
  const pendingReadFailed = useRef(false);
  const knownPending = useRef<string | null>(null);

  const readWaiting = useCallback(async (email: string) => {
    const pending = await readPending(email);
    knownPending.current = pending == null ? null : email;
    return pending;
  }, []);

  /** The last account's saved profile, its saved copies now readable, or nothing */
  const savedProfile = useCallback(async () => {
    const email = assumeLastUser();
    if (email == null) return undefined;
    assumed.current = email;
    const saved = await readCache<Profile>(ME_CACHE_KEY);
    if (saved == null) return undefined;
    let pending: ProfilePatch | null = null;
    try {
      pending = (await readWaiting(email))?.patch ?? null;
      pendingReadFailed.current = false;
    } catch (err) {
      if (!pendingReadFailed.current && cacheUser() === email) {
        pendingReadFailed.current = true;
        showError(err, 'Could not read pending settings');
      }
    }
    if (cacheUser() !== email) return undefined;
    // Kept before some settings (or the picture) existed: those have their defaults. What
    // was changed here and not sent yet goes on top.
    return withPatch(
      {
        ...saved,
        picture: saved.picture ?? null,
        googlePicture: saved.googlePicture ?? false,
        settings: { ...DEFAULT_SETTINGS, ...saved.settings },
        conversion: saved.conversion ?? null,
      },
      pending,
    );
  }, [readWaiting]);

  // Loaded once: after that, this device's changes are the latest, and a refetch
  // landing mid-change would undo one
  const { data, error, refetch } = useQuery({
    queryKey: ME_KEY,
    queryFn: async () => {
      // Opened from the copy kept on this device: the server is unreachable, slow or
      // failing. Rather than wait on it, show the last account's saved profile after a
      // moment; the server's answer still replaces them when it comes.
      const startedFromDevice = openedFromDevice();
      let answered = false;
      const timer = startedFromDevice
        ? setTimeout(() => {
            if (queryClient.getQueryData(ME_KEY) != null) return;
            void savedProfile()
              .then((saved) => {
                if (saved == null || answered) return;
                fromDevice.current = true;
                queryClient.setQueryData(ME_KEY, saved);
              })
              .catch(() => undefined);
          }, DEVICE_START_WAIT_MS)
        : undefined;
      try {
        const checking = accountCheckRequired();
        let me = await api.getMe();
        answered = true;
        clearTimeout(timer);
        // Copies are kept per account; know whose before showing any
        await setCacheUser(me.email);
        // A profile requested before a confirmed mismatch may still describe the old session.
        if (!checking && accountCheckRequired()) {
          me = await api.getMe();
          await setCacheUser(me.email);
        }
        accountChecked();
        // Reminders for whoever subscribed this device before stop coming here
        void releaseForOthers(me.email);
        const shown = assumed.current;
        assumed.current = null;
        fromDevice.current = false;
        setSignInToSync(false);
        // Someone else's saved copies were shown meanwhile, and are gone from this device
        // now: start afresh as the person signed in
        if (shown != null && shown !== me.email) reloadWithOwner();
        void writeCacheAs(me.email, ME_CACHE_KEY, me);
        // What was changed here without a connection goes back over the server's older
        // copy once this answer is shown, and is sent
        setTimeout(() => void sendUnsent.current(), 0);
        return me;
      } catch (err) {
        answered = true;
        clearTimeout(timer);
        // No connection, (opened from the device) the server failing, or Cloudflare
        // Access asking to sign in again: carry on as whoever last used this device, from
        // their saved profile, until they can sign in
        const serverFailed = startedFromDevice && err instanceof ApiError && err.status >= 500;
        const toSignIn = isSignInAnswer(err) || openedSignedOut();
        if (isOfflineFailure(err) || serverFailed || toSignIn) {
          const saved = await savedProfile();
          if (saved) {
            fromDevice.current = true;
            setSignInToSync(toSignIn);
            return saved;
          }
        }
        throw err;
      }
    },
    enabled: !logoutIntent() && (!blocked || accountCheckRequired()) && !staleTab,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    // Runs offline too, so the saved profile is used rather than waiting for a connection
    networkMode: 'always',
  });
  useEffect(() => {
    let rechecking = false;
    const mismatch = () => {
      if (rechecking || logoutIntent()) return;
      rechecking = true;
      setStaleTab(true);
      // Reuse discovery already in flight. It clears the previous owner's storage before navigating.
      void refetch({ cancelRefetch: false }).then((result) => {
        rechecking = false;
        if (result.isSuccess && !accountCheckRequired()) reloadWithOwner();
      });
    };
    const checkDevice = () => {
      const owner = deviceAccount();
      if (logoutIntent() || accountCheckRequired() || !owner) return;
      // Another tab has already finished establishing the new owner, even if this tab
      // was suspended or failed its first read while sign-in was completing there.
      if (
        (cacheUser() && sessionBlocked()) ||
        (error && !cacheUser() && owner !== initialDeviceOwner.current)
      ) {
        setStaleTab(true);
        reloadWithOwner();
      }
    };
    const changed = () => {
      if (accountCheckRequired()) mismatch();
      else checkDevice();
    };
    const stop = watchDeviceSession(changed);
    window.addEventListener('online', changed);
    checkDevice();
    return () => {
      stop();
      window.removeEventListener('online', changed);
    };
  }, [error, refetch, reloadWithOwner]);
  const profile = blocked || staleTab ? null : data ?? null;
  // Signing in happens in front of the app (Cloudflare Access), so a 401 means it ran out.
  // Opened from the device because Access asked, the server can't be asked at all.
  const signedOut =
    blocked || staleTab || (error != null && (isSignInAnswer(error) || openedSignedOut()));
  const unreachable = error != null && !signedOut;
  const retry = useCallback(() => void refetch(), [refetch]);

  // Back online: fetch the real profile if this one came from the device (which sends what
  // was changed meanwhile), else send what was changed meanwhile
  useEffect(() => {
    const refresh = () => {
      if (sessionBlocked()) return;
      if (fromDevice.current) void queryClient.invalidateQueries({ queryKey: ME_KEY });
      else void sendUnsent.current();
    };
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, []);
  const { setColorScheme } = useMantineColorScheme();

  // Only touch the colour scheme when it changes: re-applying it on every settings change
  // restyles the whole page. The theme and accent are kept on the device too, so the next
  // start paints in them before the profile loads.
  const applied = useRef<{ theme: ThemeSetting; accent: Accent } | null>(null);
  const apply = useCallback(
    (next: Profile) => {
      const { theme, expenseColour } = next.settings;
      // One kept on the device from before the redesign's accents is drawn as the default
      const accent = isAccent(next.settings.accent)
        ? next.settings.accent
        : DEFAULT_SETTINGS.accent;
      showExpenseColour(expenseColour);
      if (applied.current?.theme === theme && applied.current?.accent === accent) return;
      if (applied.current?.theme !== theme) setColorScheme(theme);
      if (applied.current?.accent !== accent) showAccent(accent);
      applied.current = { theme, accent };
      saveAppearance({ theme, accent });
    },
    [setColorScheme],
  );

  const profileRef = useRef(profile);
  profileRef.current = profile;
  const replace = useCallback((next: Profile) => {
    profileRef.current = next;
    queryClient.setQueryData(ME_KEY, next);
  }, []);

  // Theme and accent follow the profile, however it changed
  useEffect(() => {
    if (profile != null) apply(profile);
  }, [profile, apply]);

  // The page a fresh start opens on is kept for this account, and a start that opened on
  // someone else's choice (or none yet) goes to theirs
  const email = profile?.email ?? null;
  const startScreen = profile?.settings.startScreen ?? null;
  useEffect(() => {
    if (email != null && startScreen != null) rememberStartScreen(email, startScreen);
  }, [email, startScreen]);

  // Each change shows straight away. The server's reply only replaces what's on screen
  // if no newer change has been made since, so quick changes never jump back.
  const latest = useRef(0);
  const sending = useRef(false);
  const change = useCallback(
    async (show: (profile: Profile) => Profile, save: () => Promise<Saved>) => {
      const current = profileRef.current;
      if (current == null) return;
      const id = ++latest.current;
      replace(show(current));
      try {
        const saved = await save();
        const now = profileRef.current;
        // The server's copy is kept on the device too, so opening the app offline later
        // shows this change, not the profile as it was before
        if (saved && typeof saved !== 'function') keepCopy(saved);
        if (saved && now != null && id === latest.current) {
          replace(typeof saved === 'function' ? saved(now) : saved);
        }
      } catch (err) {
        if (id === latest.current) replace(current);
        throw err;
      }
    },
    [replace],
  );

  // The name and preferences: shown at once and kept on the device for the account until
  // the server has them, so without a connection (or signed in no longer) they wait and are
  // sent once it's back, surviving the app being closed. A save the server answers with
  // anything else is undone, and rejects for the caller to say so.
  const update = useCallback(
    async (patch: ProfilePatch) => {
      const current = profileRef.current;
      if (current == null) return;
      if (!canWait(patch)) {
        return change(
          (p) => withPatch(p, patch),
          () => api.updateMe(patch),
        );
      }
      const { email } = current;
      const id = ++latest.current;
      replace(withPatch(current, patch));
      async function queueIfWaiting() {
        if (!isOffline()) {
          // Online saves can still work without storage. A known waiting edit must keep
          // its place even if the device can't be read again just now.
          const pending = await readWaiting(email).then(
            (waiting) => waiting != null,
            () => knownPending.current === email,
          );
          if (!pending) return false;
        }
        await keepUnsent(email, patch);
        knownPending.current = email;
        if (!isOffline()) void sendUnsent.current();
        return true;
      }

      let saved: Profile | null;
      try {
        if (await queueIfWaiting()) return;
        saved = await withProfileSendLock(email, async () => {
          if (cacheUser() !== email || (await queueIfWaiting())) return null;
          try {
            return await api.updateMe(patch);
          } catch (err) {
            if (!isOfflineFailure(err) && !isSignInAnswer(err)) throw err;
            const keep = id === latest.current ? keepUnsent : keepUnsentUnder;
            await keep(email, patch);
            knownPending.current = email;
            return null;
          }
        });
      } catch (err) {
        if (id === latest.current && profileRef.current?.email === email) replace(current);
        throw err;
      }
      if (saved == null) return;

      keepCopy(saved);
      try {
        const left = (await readWaiting(email))?.patch ?? null;
        if (id === latest.current && profileRef.current?.email === email) {
          replace(withPatch(saved, left));
        }
      } catch (err) {
        if (cacheUser() === email) showError(err, 'Could not check pending settings');
      }
    },
    [change, readWaiting, replace],
  );

  // Sends what was changed here and waits, once there's a connection: taken off the device
  // once saved, and shown as the server has it with anything changed since on top. One the
  // server refuses is let go, the server's profile shown, and said; anything else keeps it
  // for next time.
  const sendAgain = useRef(false);
  const sendingNow = useRef<Promise<void>>(Promise.resolve());
  // What the last sends ran into: a failure that keeps them waiting, and the fields refused
  const lastFailure = useRef<unknown>(null);
  const refusedFields = useRef(new Set<string>());
  sendUnsent.current = () => {
    const email = cacheUser();
    if (email == null) return Promise.resolve();
    sendAgain.current = true;
    if (sending.current) return sendingNow.current;
    sending.current = true;
    sendingNow.current = sendAll(email);
    return sendingNow.current;
  };
  const sendAll = async (email: string) => {
    try {
      while (sendAgain.current && cacheUser() === email && !isOffline()) {
        sendAgain.current = false;
        await withProfileSendLock(email, async () => {
          while (cacheUser() === email && !isOffline()) {
            const asked = latest.current;
            const unsent = await readWaiting(email);
            if (unsent == null) return;
            // Put the waiting patch back over the server's older answer before sending.
            const shown = queryClient.getQueryData<Profile>(ME_KEY);
            if (asked === latest.current && shown?.email === email) {
              replace(withPatch(shown, unsent.patch));
            }
            const send = async (patch: ProfilePatch, alone: boolean): Promise<boolean> => {
              if (cacheUser() !== email) return false;
              let saved: Profile;
              try {
                saved = await api.updateMe(patch);
              } catch (err) {
                if (isRetryable(err)) {
                  lastFailure.current = err;
                  return false;
                }
                // Refused: one field at a time, so only what the server won't take is let go.
                if (!alone) {
                  for (const one of eachField(patch)) if (!(await send(one, true))) return false;
                  return true;
                }
                await settleUnsent(email, unsent, patch);
                fieldsOf(patch).forEach((field) => refusedFields.current.add(field));
                showError(err, 'Could not save your settings');
                void queryClient.invalidateQueries({ queryKey: ME_KEY });
                return true;
              }
              keepCopy(saved);
              lastFailure.current = null;
              const left = await settleUnsent(email, unsent, patch);
              if (
                asked === latest.current &&
                queryClient.getQueryData<Profile>(ME_KEY)?.email === email
              ) {
                replace(withPatch(saved, left));
              }
              return true;
            };
            if (!(await send(unsent.patch, eachField(unsent.patch).length === 1))) return;
          }
        });
      }
    } catch (err) {
      if (cacheUser() === email) showError(err, 'Could not check pending settings');
    } finally {
      sending.current = false;
    }
  };

  // The picture shown in place of the initial. A chosen photo shows from this device until
  // the server has kept it (then the server's copy, which the browser loads); one refused
  // puts back what was there. Rejects if it isn't saved, for the caller to say so.
  const changePicture = useCallback(
    async (to: Blob | PictureChoice) => {
      if (!(to instanceof Blob)) {
        return change(
          (p) => ({
            ...p,
            picturePreview: null,
            picture: to === 'google' && p.googlePicture ? { source: 'google', version: 0 } : null,
          }),
          () => api.updateMe({ picture: to }),
        );
      }
      const preview = URL.createObjectURL(to);
      try {
        await change(
          (p) => ({ ...p, picturePreview: preview }),
          () => api.putPicture(to),
        );
      } finally {
        // Let go once the server's copy has had a moment to load in its place
        setTimeout(() => URL.revokeObjectURL(preview), 5000);
      }
    },
    [change],
  );

  // The server needs the person's own day, and only the device knows its time zone: sent
  // once a start, after the server has said who's signed in (never from the copy kept on
  // the device), whenever it isn't the one saved. A failure is left for the next start.
  const zoneSent = useRef(false);
  useEffect(() => {
    if (profile == null || fromDevice.current || zoneSent.current) return;
    zoneSent.current = true;
    const zone = quietly(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    if (!isTimeZone(zone) || zone === profile.settings.timeZone) return;
    void update({ settings: { timeZone: zone } }).catch(() => {});
  }, [profile, update]);

  // While amounts convert into a new home currency, the server is asked every few seconds
  // how it's going (one ask at a time, however slow the answers); once it's done, the ledger
  // fetches everything again in the new currency and sends the changes kept meanwhile
  // (ledger/ledger.ts). An answer that says only how far it has got goes to what shows that
  // (useConversionProgress), so the app isn't drawn again every few seconds while it waits.
  const converting = profile != null && isConverting(profile);
  useEffect(() => {
    if (!converting) return;
    let asking = false;
    const timer = setInterval(() => {
      if (asking) return;
      asking = true;
      const asked = latest.current;
      void api
        .getMe()
        .then((me) => {
          // A change made since wins; the next ask brings the rest
          if (asked !== latest.current || profileRef.current?.email !== me.email) return;
          // Only further on: said where it's shown, without drawing every screen again
          showProgress(me.conversion);
          if (sameButProgress(me, profileRef.current)) return;
          replace(me);
          void writeCacheAs(me.email, ME_CACHE_KEY, me);
        })
        .catch(() => {})
        .finally(() => {
          asking = false;
        });
    }, CONVERSION_POLL_MS);
    return () => clearInterval(timer);
  }, [converting, replace]);

  const patch = useCallback(
    (change: (profile: Profile) => Profile) => {
      if (profileRef.current != null) replace(change(profileRef.current));
    },
    [replace],
  );

  // Settings changed within moments of each other: each shown at once and kept on the
  // device straight away (so closing the app loses nothing), then, once the person has
  // stopped for SETTINGS_QUIET_MS, sent as one save. A field changed back to what it was
  // before the batch is let go unsent, and if that's everything, nothing is sent or said.
  const batch = useRef<Batch | null>(null);
  const quietTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const said = useRef(sayChanged);
  said.current = sayChanged;
  const remember = useRef<
    (patch: ProfilePatch, track?: (saving: Promise<void>) => Promise<unknown>) => void
  >(() => {});

  // Each field's latest change, counted, so a save's answer only puts back a field nothing
  // has changed since
  const fieldEdits = useRef(new Map<string, number>());
  const editCount = useRef(0);
  const nothingNewer = (edits: Map<string, number>, field: string) =>
    fieldEdits.current.get(field) === edits.get(field);
  // A change the server couldn't take just then is sent again after a while
  const resendTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Saves under way, so leaving or signing out can wait for how they went
  const flushing = useRef<Promise<void>>(Promise.resolve());

  /** Says how a batch's save went, in the one message for it */
  const say = useCallback((outcome: Outcome, patch: ProfilePatch) => {
    if (outcome.kind === 'said') return;
    if (outcome.kind === 'failed') {
      const { again, edits } = outcome;
      const fields = fieldsOf(again);
      // Sends again what wasn't saved, but none changed since
      const retry = () => {
        const still = fields.filter((f) => nothingNewer(edits, f));
        if (still.length === 0) return;
        const value = (f: string) =>
          f === 'displayName'
            ? again.displayName
            : (again.settings as Record<string, unknown> | undefined)?.[f];
        remember.current(patchOf(still, value));
      };
      const nameOnly = fields.length === 1 && 'displayName' in again;
      const fallback = nameOnly
        ? "Couldn't save your name. Try again."
        : "Couldn't save your settings.";
      const explanation =
        outcome.err instanceof ApiError && !nameOnly ? outcome.err.explanation : null;
      showToast({
        tone: 'error',
        message: explanation ?? fallback,
        action: { label: 'Retry', run: retry },
        replaces: SAVED_TOAST,
      });
      return;
    }
    const shown = profileRef.current;
    const message =
      outcome.kind === 'offline'
        ? "Saved on this device. It will sync when you're back online."
        : outcome.kind === 'signedOut'
          ? 'Saved on this device. It will sync once you sign in again.'
          : outcome.kind === 'waiting'
            ? 'Saved on this device. It will sync when the server answers.'
            : (shown != null ? said.current?.(patch, shown) : null) ?? 'Settings saved';
    showToast({ message, polite: true, autoClose: SAVED_SAY_MS, replaces: SAVED_TOAST });
  }, []);

  /**
   * Sends a batch's changes, as update() would: straight away when nothing else waits.
   * Each field is confirmed (taken off the device) or, refused, put back on screen if it
   * still shows what was sent and nothing has changed it since; one that can't be sent just
   * now stays on the device. A refusal of several is tried a field at a time, so only what
   * the server won't take is put back.
   */
  const sendBatch = useCallback(
    async (b: Batch, patch: ProfilePatch, before: ProfilePatch): Promise<Outcome> => {
      const { email } = b;
      const sent = (f: string) =>
        f === 'displayName'
          ? patch.displayName
          : (patch.settings as Record<string, unknown> | undefined)?.[f];
      const was = (f: string) =>
        f === 'displayName'
          ? before.displayName
          : (before.settings as Record<string, unknown> | undefined)?.[f];
      const putBack = (fields: string[]) => {
        const now = profileRef.current;
        if (now?.email !== email) return;
        const back = fields.filter(
          (f) => nothingNewer(b.edits, f) && sameValue(valueOf(now, f), sent(f)),
        );
        if (back.length > 0) replace(withPatch(now, patchOf(back, was)));
      };
      const failed = (err: unknown, fields: string[]): Outcome => ({
        kind: 'failed',
        err,
        again: patchOf(fields, sent),
        edits: new Map(fields.map((f) => [f, b.edits.get(f) ?? 0])),
      });

      // The device couldn't keep it: sent as update() sends anything
      if (b.kept == null || b.unkept) {
        try {
          await update(patch);
          return { kind: isOffline() ? 'offline' : 'saved' };
        } catch (err) {
          putBack(fieldsOf(patch));
          return failed(err, fieldsOf(patch));
        }
      }
      const kept = b.kept;
      if (isOffline()) return { kind: 'offline' };
      const ours = (pending: Pending | null) =>
        fieldsOf(patch).filter((f) => pending?.revisions[f] === kept.revisions[f]);
      const direct = await withProfileSendLock(email, async (): Promise<Outcome | null> => {
        if (cacheUser() !== email) return { kind: 'said' };
        const waiting = await readWaiting(email).catch(() => null);
        // Made offline, or something else waits from before: sent with what waits, in order
        if (
          b.madeOffline ||
          (waiting != null && fieldsOf(waiting.patch).some((f) => !ours(waiting).includes(f)))
        ) {
          return null;
        }
        const refused: string[] = [];
        let refusal: unknown = null;
        let stopped: Exclude<Unsaved, 'refused'> | null = null;
        let saved: Profile | null = null;
        let left: ProfilePatch | null = null;
        const send = async (part: ProfilePatch, alone: boolean): Promise<boolean> => {
          try {
            saved = await api.updateMe(part);
          } catch (err) {
            const why = unsavedBy(err);
            if (why !== 'refused') {
              stopped = why;
              return false;
            }
            if (!alone) {
              for (const one of eachField(part)) if (!(await send(one, true))) return false;
              return true;
            }
            refusal ??= err;
            refused.push(...fieldsOf(part));
            left = await settleUnsent(email, kept, part).catch(() => left);
            return true;
          }
          keepCopy(saved);
          left = await settleUnsent(email, kept, part).catch(() => left);
          return true;
        };
        await send(patch, fieldsOf(patch).length === 1);
        putBack(refused);
        // The server's copy, with what still waits on top, unless anything changed since
        if (saved != null && b.lastId === latest.current && profileRef.current?.email === email) {
          replace(withPatch(saved, left));
        }
        if (refused.length > 0) return failed(refusal, refused);
        if (stopped != null) return { kind: stopped };
        return { kind: 'saved' };
      });
      if (direct != null) return direct;

      // Sent with what waited before it; how it went is read from what's left
      lastFailure.current = null;
      refusedFields.current.clear();
      await sendUnsent.current();
      const left = await readWaiting(email).catch(() => null);
      if (ours(left).length > 0) {
        if (isOffline()) return { kind: 'offline' };
        const why = unsavedBy(lastFailure.current);
        return { kind: why === 'refused' ? 'waiting' : why };
      }
      // A refusal was said as it happened
      if (fieldsOf(patch).some((f) => refusedFields.current.has(f))) return { kind: 'said' };
      return { kind: 'saved' };
    },
    [readWaiting, replace, update],
  );

  const flushSettings = useCallback((): Promise<void> => {
    clearTimeout(quietTimer.current);
    const b = batch.current;
    // Nothing in its pause: what's already on its way, if anything
    if (b == null) return flushing.current;
    batch.current = null;
    const work = (async () => {
      let patch: ProfilePatch | null = null;
      try {
        await b.writes;
        const shown = profileRef.current;
        if (shown?.email !== b.email) return;
        const fields = [...b.before.keys()];
        const changed = fields.filter(
          (f) => b.waitedBefore.has(f) || !sameValue(valueOf(shown, f), b.before.get(f)),
        );
        const unchanged = fields.filter((f) => !changed.includes(f));
        if (b.kept != null && unchanged.length > 0) {
          const kept = b.kept;
          const back = patchOf(unchanged, (f) => valueOf(shown, f));
          await settleUnsent(b.email, kept, back).catch(() => null);
        }
        if (changed.length === 0) return;
        patch = patchOf(changed, (f) => valueOf(shown, f));
        const before = patchOf(changed, (f) => b.before.get(f));
        const outcome = await sendBatch(b, patch, before);
        if (outcome.kind === 'waiting') {
          clearTimeout(resendTimer.current);
          resendTimer.current = setTimeout(() => void sendUnsent.current(), SETTINGS_RESEND_MS);
        }
        say(outcome, patch);
      } catch (err) {
        // Stopped part-way here (the browser refused a lock): it stays kept on the device
        if (patch != null) {
          const fields = fieldsOf(patch);
          say(
            {
              kind: 'failed',
              err,
              again: patch,
              edits: new Map(fields.map((f) => [f, b.edits.get(f) ?? 0])),
            },
            patch,
          );
        }
      } finally {
        countSaving(-b.counted);
        b.counted = 0;
        b.done.forEach((resolve) => resolve());
      }
    })();
    const all = Promise.all([flushing.current, work]).then(() => undefined);
    flushing.current = all;
    return all;
  }, [say, sendBatch]);

  remember.current = (patch, track = (saving) => saving) => {
    const current = profileRef.current;
    if (current == null) return;
    // What needs a connection isn't batched (the home currency has its own flow)
    if (!canWait(patch)) {
      void track(update(patch)).catch((err: unknown) =>
        showError(err, 'Could not save your settings'),
      );
      return;
    }
    const { email } = current;
    if (batch.current != null && batch.current.email !== email) void flushSettings();
    const b: Batch = (batch.current ??= {
      email,
      before: new Map(),
      waitedBefore: new Set(),
      looked: new Set(),
      kept: null,
      unkept: false,
      madeOffline: false,
      writes: Promise.resolve(),
      lastId: 0,
      edits: new Map(),
      counted: 0,
      done: [],
    });
    if (isOffline()) b.madeOffline = true;
    const fields = fieldsOf(patch);
    for (const f of fields) if (!b.before.has(f)) b.before.set(f, valueOf(current, f));
    countSaving(b.before.size - b.counted);
    b.counted = b.before.size;
    b.lastId = ++latest.current;
    for (const f of fields) {
      fieldEdits.current.set(f, ++editCount.current);
      b.edits.set(f, editCount.current);
    }
    replace(withPatch(current, patch));
    b.writes = b.writes.then(async () => {
      try {
        const fresh = fields.filter((f) => !b.looked.has(f));
        if (fresh.length > 0) {
          const waiting = await readWaiting(email).catch(() => null);
          const waited = waiting == null ? [] : fieldsOf(waiting.patch);
          for (const f of fresh) {
            b.looked.add(f);
            if (waited.includes(f)) b.waitedBefore.add(f);
          }
        }
        const edit = await keepUnsent(email, patch);
        knownPending.current = email;
        b.kept = b.kept == null ? edit : merged(b.kept, edit);
      } catch {
        b.unkept = true;
      }
    });
    const saving = new Promise<void>((resolve) => b.done.push(resolve));
    void track(saving).catch(() => {});
    clearTimeout(quietTimer.current);
    quietTimer.current = setTimeout(() => void flushSettings(), SETTINGS_QUIET_MS);
  };

  const rememberSettings = useCallback(
    (settings: Partial<Settings>, track?: (saving: Promise<void>) => Promise<unknown>) =>
      remember.current({ settings }, track),
    [],
  );
  const rememberName = useCallback(
    (displayName: string | null) => remember.current({ displayName }),
    [],
  );

  // Hiding the page (another app, another tab, closing it) sends what waits straight away
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === 'hidden') void flushSettings();
    };
    const leaving = () => void flushSettings();
    document.addEventListener('visibilitychange', hidden);
    window.addEventListener('pagehide', leaving);
    return () => {
      document.removeEventListener('visibilitychange', hidden);
      window.removeEventListener('pagehide', leaving);
      clearTimeout(quietTimer.current);
      clearTimeout(resendTimer.current);
      // Closed mid-pause: what's kept on the device is sent at the next start, and the
      // sync cloud stops counting it
      const b = batch.current;
      if (b != null) {
        batch.current = null;
        countSaving(-b.counted);
        b.counted = 0;
        b.done.forEach((resolve) => resolve());
      }
    };
  }, [flushSettings]);

  return (
    <ProfileContext.Provider
      value={{
        profile,
        signedOut,
        signInToSync,
        unreachable,
        retry,
        change,
        update,
        rememberSettings,
        rememberName,
        flushSettings,
        changePicture,
        replace,
        patch,
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}
