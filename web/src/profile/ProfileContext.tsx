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
import { ME_KEY, queryClient } from '../query-client';
import { isOffline, isOfflineFailure } from '../offline/network';
import { editOutbox, isRetryable } from '../offline/outbox';
import {
  canWait,
  dropUnsent,
  eachField,
  keepUnsent,
  keepUnsentUnder,
  readUnsent,
  settleUnsent,
  unsentNow,
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
  signInAddress,
  writeCache,
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
   * For preferences: shown at once, saved in the background, and a failure undone and
   * explained with a notification. `track` follows the save, to show it's saving.
   */
  rememberSettings: (
    settings: Partial<Settings>,
    track?: (saving: Promise<void>) => Promise<unknown>,
  ) => void;
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

/** Cloudflare Access sent the request to sign in: the session ran out */
const isSignInAnswer = (err: unknown) => err instanceof ApiError && err.status === 401;

/**
 * Goes to Cloudflare Access to sign in, then back to this page. Marked so the service
 * worker lets Access answer rather than showing its kept copy.
 */
export function signIn() {
  window.location.href = signInAddress();
}

/**
 * Stops reminders coming to this device, forgets what this device kept for the account,
 * changes waiting to be sent included, then signs out of Cloudflare Access. Changes the
 * server refused stay, theirs alone, to review when they sign in again; others' unsent
 * changes, kept from before this account signed in here, stay theirs.
 */
export async function signOut() {
  await letGoHere();
  const leaving = cacheUser();
  // Of their own, only changes the server refused stay, for them to review when they sign
  // in again; what's still waiting to be sent goes. If the device can't be written, it all
  // stays, still theirs alone.
  if (leaving != null) {
    await dropUnsent(leaving);
    await editOutbox(leaving, (kept) => kept.filter((q) => q.refused != null)).catch(
      () => undefined,
    );
  }
  await clearCache(() => true);
  window.location.href = '/cdn-cgi/access/logout';
}

export function ProfileProvider({ children }: { children: ReactNode }) {
  const fromDevice = useRef(false);
  // Sends what was changed here without a connection (set below, once update's parts are)
  const sendUnsent = useRef<() => Promise<void>>(async () => {});
  const [signInToSync, setSignInToSync] = useState(false);
  // Whose saved copies were shown while the server couldn't say who's signed in
  const assumed = useRef<string | null>(null);

  /** The last account's saved profile, its saved copies now readable, or nothing */
  const savedProfile = useCallback(async () => {
    const email = assumeLastUser();
    if (email == null) return undefined;
    assumed.current = email;
    const saved = await readCache<Profile>(ME_CACHE_KEY);
    if (saved == null) return undefined;
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
      await readUnsent(email),
    );
  }, []);

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
            void savedProfile().then((saved) => {
              if (saved == null || answered) return;
              fromDevice.current = true;
              queryClient.setQueryData(ME_KEY, saved);
            });
          }, DEVICE_START_WAIT_MS)
        : undefined;
      try {
        const me = await api.getMe();
        answered = true;
        clearTimeout(timer);
        // Copies are kept per account; know whose before showing any
        await setCacheUser(me.email);
        // Reminders for whoever subscribed this device before stop coming here
        void releaseForOthers(me.email);
        const shown = assumed.current;
        assumed.current = null;
        fromDevice.current = false;
        setSignInToSync(false);
        // Someone else's saved copies were shown meanwhile, and are gone from this device
        // now: start afresh as the person signed in
        if (shown != null && shown !== me.email) window.location.reload();
        void writeCache(ME_CACHE_KEY, me);
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
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
    // Runs offline too, so the saved profile is used rather than waiting for a connection
    networkMode: 'always',
  });
  const profile = data ?? null;
  // Signing in happens in front of the app (Cloudflare Access), so a 401 means it ran out.
  // Opened from the device because Access asked, the server can't be asked at all.
  const signedOut = error != null && (isSignInAnswer(error) || openedSignedOut());
  const unreachable = error != null && !signedOut;
  const retry = useCallback(() => void refetch(), [refetch]);

  // Back online: fetch the real profile if this one came from the device (which sends what
  // was changed meanwhile), else send what was changed meanwhile
  useEffect(() => {
    const refresh = () => {
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
      // Kept on the device before it's sent while the browser says there's no connection;
      // online it's sent straight away, and kept only if that finds no connection
      const offline = isOffline();
      const kept = offline && (await keepUnsent(email, patch));
      try {
        const saved = await api.updateMe(patch);
        if (kept) await settleUnsent(email, patch);
        keepCopy(saved);
        if (id === latest.current) replace(withPatch(saved, unsentNow(email)));
      } catch (err) {
        const waiting = isOfflineFailure(err) || isSignInAnswer(err);
        // A change made since (kept offline, say) is newer: this one goes under it
        const keep = id === latest.current ? keepUnsent : keepUnsentUnder;
        if (waiting && (kept || (await keep(email, patch)))) return;
        if (kept) await settleUnsent(email, patch);
        if (id === latest.current) replace(current);
        throw err;
      }
    },
    [change, replace],
  );

  // Sends what was changed here and waits, once there's a connection: taken off the device
  // once saved, and shown as the server has it with anything changed since on top. One the
  // server refuses is let go, the server's profile shown, and said; anything else keeps it
  // for next time.
  const sending = useRef(false);
  sendUnsent.current = async () => {
    const email = cacheUser();
    if (email == null || sending.current) return;
    const unsent = await readUnsent(email);
    if (unsent == null) return;
    sending.current = true;
    // Shown at once over whatever copy is showing, before the server has it: the copy as
    // last set, not as last drawn, since the server's answer may not be drawn yet
    const shown = queryClient.getQueryData<Profile>(ME_KEY);
    if (shown?.email === email) replace(withPatch(shown, unsent));
    const asked = latest.current;
    /** Sends a patch: whether to carry on (saved or refused), false to keep the rest waiting */
    const send = async (patch: ProfilePatch, alone: boolean): Promise<boolean> => {
      try {
        const saved = await api.updateMe(patch);
        await settleUnsent(email, patch);
        keepCopy(saved);
        if (
          asked === latest.current &&
          queryClient.getQueryData<Profile>(ME_KEY)?.email === email
        ) {
          replace(withPatch(saved, await readUnsent(email)));
        }
        return true;
      } catch (err) {
        if (isRetryable(err)) return false;
        // Refused: one field at a time, so only what the server won't take is let go
        if (!alone) {
          for (const one of eachField(patch)) if (!(await send(one, true))) return false;
          return true;
        }
        await settleUnsent(email, patch);
        showError(err, 'Could not save your settings');
        void queryClient.invalidateQueries({ queryKey: ME_KEY });
        return true;
      }
    };
    try {
      await send(unsent, eachField(unsent).length === 1);
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
          void writeCache(ME_CACHE_KEY, me);
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

  const rememberSettings = useCallback(
    (
      settings: Partial<Settings>,
      track: (saving: Promise<void>) => Promise<unknown> = (saving) => saving,
    ) =>
      void track(update({ settings })).catch((err: unknown) =>
        showError(err, 'Could not save your settings'),
      ),
    [update],
  );

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
        changePicture,
        replace,
        patch,
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}
