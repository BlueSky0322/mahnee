import { useMantineColorScheme } from '@mantine/core';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { Profile } from '../api';
import { ApiError, api } from '../api';
import { queryClient } from '../query-client';
import { isOfflineFailure } from '../offline/network';
import {
  assumeLastUser,
  clearCache,
  openedFromDevice,
  openedSignedOut,
  readCache,
  setCacheUser,
  signInAddress,
  writeCache,
} from '../offline/cache';
import { isAccent } from '@shared/accents';
import {
  DEFAULT_SETTINGS,
  THEMES,
  type Accent,
  type ProfilePatch,
  type Settings,
  type ThemeSetting,
} from '@shared/api';
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
  /** Replaces the profile with one the server returned */
  replace: (profile: Profile) => void;
  /** Changes the profile on screen from its latest value */
  patch: (change: (profile: Profile) => Profile) => void;
}

const ProfileContext = createContext<ProfileContextValue | null>(null);

const ME_KEY = ['me'] as const;
/** Versioned like the other saved copies: one in an older shape is never read */
const ME_CACHE_KEY = 'me-v2';
/**
 * How long an app opened from the device's copy waits on the server before showing the
 * last account's saved profile
 */
export const DEVICE_START_WAIT_MS = 2000;

export const useProfile = () => {
  const value = useContext(ProfileContext);
  if (value == null) throw new Error('useProfile needs a ProfileProvider');
  return value;
};

/** The name to show for someone: their display name, else the part of the email before @ */
export const nameFor = (email: string, displayName?: string | null) =>
  displayName?.trim() || email.split('@')[0];

/** Cloudflare Access sent the request to sign in: the session ran out */
const isSignInAnswer = (err: unknown) => err instanceof ApiError && err.status === 401;

/**
 * Goes to Cloudflare Access to sign in, then back to this page. Marked so the service
 * worker lets Access answer rather than showing its kept copy.
 */
export function signIn() {
  window.location.href = signInAddress();
}

/** Forgets what this device kept for the account, then signs out of Cloudflare Access */
export async function signOut() {
  await clearCache();
  window.location.href = '/cdn-cgi/access/logout';
}

export function ProfileProvider({
  children,
  onAccentChange,
}: {
  children: ReactNode;
  onAccentChange: (accent: Accent) => void;
}) {
  const fromDevice = useRef(false);
  const [signInToSync, setSignInToSync] = useState(false);
  // Whose saved copies were shown while the server couldn't say who's signed in
  const assumed = useRef<string | null>(null);

  /** The last account's saved profile, its saved copies now readable, or nothing */
  const savedProfile = useCallback(async () => {
    const email = assumeLastUser();
    if (email == null) return undefined;
    assumed.current = email;
    return readCache<Profile>(ME_CACHE_KEY);
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
        const shown = assumed.current;
        assumed.current = null;
        fromDevice.current = false;
        setSignInToSync(false);
        // Someone else's saved copies were shown meanwhile, and are gone from this device
        // now: start afresh as the person signed in
        if (shown != null && shown !== me.email) window.location.reload();
        void writeCache(ME_CACHE_KEY, me);
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

  // Back online: fetch the real profile if this one came from the device
  useEffect(() => {
    const refresh = () => {
      if (fromDevice.current) void queryClient.invalidateQueries({ queryKey: ME_KEY });
    };
    window.addEventListener('online', refresh);
    return () => window.removeEventListener('online', refresh);
  }, []);
  const { setColorScheme } = useMantineColorScheme();

  // Only touch the colour scheme and accent when they change: re-applying them on every
  // settings change restyles the whole page
  const applied = useRef<{ theme: ThemeSetting; accent: Accent } | null>(null);
  const apply = useCallback(
    (next: Profile) => {
      const { theme, accent } = next.settings;
      if (applied.current?.theme === theme && applied.current?.accent === accent) return;
      if (applied.current?.theme !== theme) setColorScheme(theme);
      if (applied.current?.accent !== accent) onAccentChange(accent);
      applied.current = { theme, accent };
      saveAppearance({ theme, accent });
    },
    [setColorScheme, onAccentChange],
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

  const update = useCallback(
    (patch: ProfilePatch) =>
      change(
        (current) => ({
          ...current,
          ...('displayName' in patch ? { displayName: patch.displayName ?? null } : {}),
          settings: { ...current.settings, ...patch.settings },
        }),
        () => api.updateMe(patch),
      ),
    [change],
  );

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
        replace,
        patch,
      }}
    >
      {children}
    </ProfileContext.Provider>
  );
}
