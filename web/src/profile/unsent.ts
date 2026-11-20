import type { ProfilePatch } from '@shared/api';
import type { Profile } from '../api';
import { readCacheAs, removeCacheEntry, writeCacheAs } from '../offline/cache';

// Profile and preference changes made without a connection, kept on the device for the
// account they were made as until the server has them: one patch per person, the latest
// value of each field changed. Sending it twice changes nothing, so no ids are needed. Like
// the outbox, it stays theirs alone when someone else signs in here (UNSENT_PREFIXES).
//
// Every change to what's kept reads it and writes it back holding a lock per person (Web
// Locks, shared by every tab; else turns within the page), so two quick changes, or a
// change made while a save is being crossed off, never write over each other.

/** Where a person's unsent profile changes are kept (UNSENT_PREFIXES in offline/cache.ts) */
export const PROFILE_OUTBOX_PREFIX = 'profile-outbox:';
const keyFor = (email: string) => `${PROFILE_OUTBOX_PREFIX}${email}`;

/** Only the name and preferences wait; the picture and the home currency need a connection */
export const canWait = (patch: ProfilePatch) =>
  patch.picture === undefined && patch.settings?.currency === undefined;

const isEmpty = (patch: ProfilePatch) =>
  !('displayName' in patch) && Object.keys(patch.settings ?? {}).length === 0;

// What waits, as last read or written here, for asking before signing out
let lastKnown: { email: string; patch: ProfilePatch | null } | null = null;

/** What `email` has waiting, as this page last knew it (null for nothing) */
export const unsentNow = (email: string) => (lastKnown?.email === email ? lastKnown.patch : null);

// Without Web Locks, calls in this page still take turns
const chains = new Map<string, Promise<unknown>>();

/** Runs fn holding `email`'s lock on what waits */
function withLock<T>(email: string, fn: () => Promise<T>): Promise<T> {
  const name = `mahnee-profile-outbox:${email}`;
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (locks) return locks.request(name, fn) as Promise<T>;
  const run = (chains.get(name) ?? Promise.resolve()).then(fn, fn);
  chains.set(
    name,
    run.catch(() => undefined),
  );
  return run;
}

async function read(email: string): Promise<ProfilePatch | null> {
  const kept = await readCacheAs<ProfilePatch>(email, keyFor(email));
  const patch = kept != null && typeof kept === 'object' && !isEmpty(kept) ? kept : null;
  lastKnown = { email, patch };
  return patch;
}

async function write(email: string, patch: ProfilePatch): Promise<boolean> {
  if (isEmpty(patch)) {
    lastKnown = { email, patch: null };
    return removeCacheEntry(keyFor(email));
  }
  lastKnown = { email, patch };
  return writeCacheAs(email, keyFor(email), patch);
}

/** What `email` changed here that the server doesn't have yet, if anything */
export const readUnsent = (email: string) => withLock(email, () => read(email));

/** Adds a change to what waits, the newer value of a field winning; resolves with whether it's kept */
export const keepUnsent = (email: string, patch: ProfilePatch) =>
  withLock(email, async () => write(email, merged((await read(email)) ?? {}, patch)));

/** Two changes as one, the second's fields over the first's */
const merged = (a: ProfilePatch, b: ProfilePatch): ProfilePatch => ({
  ...('displayName' in a && { displayName: a.displayName }),
  ...('displayName' in b && { displayName: b.displayName }),
  ...((a.settings != null || b.settings != null) && { settings: { ...a.settings, ...b.settings } }),
});

/**
 * Takes what the server now has (or refused) off what waits: each field still at the value
 * sent (one changed again since stays, to send next)
 */
export const settleUnsent = (email: string, sent: ProfilePatch) =>
  withLock(email, async () => {
    const kept = await read(email);
    if (kept == null) return;
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    const left: ProfilePatch = {};
    if (
      'displayName' in kept &&
      !('displayName' in sent && same(sent.displayName, kept.displayName))
    ) {
      left.displayName = kept.displayName;
    }
    const settings = Object.fromEntries(
      Object.entries(kept.settings ?? {}).filter(
        ([key, value]) =>
          !same((sent.settings as Record<string, unknown> | undefined)?.[key], value),
      ),
    );
    if (Object.keys(settings).length > 0) left.settings = settings;
    await write(email, left);
  });

/** Lets what waits go: signing out */
export const dropUnsent = (email: string) =>
  withLock(email, () => write(email, {}).then(() => undefined));

/** A patch as one patch per field, to find which one the server refuses */
export const eachField = (patch: ProfilePatch): ProfilePatch[] => [
  ...('displayName' in patch ? [{ displayName: patch.displayName }] : []),
  ...Object.entries(patch.settings ?? {}).map(([key, value]) => ({ settings: { [key]: value } })),
];

/** A profile with changes on top of it, as it's shown */
export const withPatch = (profile: Profile, patch: ProfilePatch | null): Profile =>
  patch == null
    ? profile
    : {
        ...profile,
        ...('displayName' in patch && { displayName: patch.displayName ?? null }),
        settings: { ...profile.settings, ...patch.settings },
      };
