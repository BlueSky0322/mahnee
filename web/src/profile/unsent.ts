import type { ProfilePatch } from '@shared/api';
import type { Profile } from '../api';
import { readCacheAs, removeCacheEntry, writeCacheAs } from '../offline/cache';

// Profile and preference changes made without a connection, kept on the device for the
// account they were made as until the server has them: one patch per person, the latest
// value of each field changed. Sending it twice changes nothing, so no ids are needed. Like
// the outbox, it stays theirs alone when someone else signs in here (UNSENT_PREFIXES).

/** Where a person's unsent profile changes are kept (UNSENT_PREFIXES in offline/cache.ts) */
export const PROFILE_OUTBOX_PREFIX = 'profile-outbox:';
const keyFor = (email: string) => `${PROFILE_OUTBOX_PREFIX}${email}`;

/** Only the name and preferences wait; the picture and the home currency need a connection */
export const canWait = (patch: ProfilePatch) =>
  patch.picture === undefined && patch.settings?.currency === undefined;

/** What `email` changed here that the server doesn't have yet, if anything */
export async function readUnsent(email: string): Promise<ProfilePatch | null> {
  const kept = await readCacheAs<ProfilePatch>(email, keyFor(email));
  return kept != null && typeof kept === 'object' && isEmpty(kept) === false ? kept : null;
}

const isEmpty = (patch: ProfilePatch) =>
  !('displayName' in patch) && Object.keys(patch.settings ?? {}).length === 0;

/** Adds a change to what waits, the newer value of a field winning; resolves with whether it's kept */
export async function keepUnsent(email: string, patch: ProfilePatch): Promise<boolean> {
  const before = (await readUnsent(email)) ?? {};
  return writeCacheAs(email, keyFor(email), merged(before, patch));
}

/** Two changes as one, the second's fields over the first's */
const merged = (a: ProfilePatch, b: ProfilePatch): ProfilePatch => ({
  ...('displayName' in a && { displayName: a.displayName }),
  ...('displayName' in b && { displayName: b.displayName }),
  ...((a.settings != null || b.settings != null) && { settings: { ...a.settings, ...b.settings } }),
});

/**
 * Takes what the server now has off what waits: each field still at the value sent (one
 * changed again since stays, to send next)
 */
export async function settleUnsent(email: string, sent: ProfilePatch): Promise<void> {
  const kept = await readUnsent(email);
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
      ([key, value]) => !same((sent.settings as Record<string, unknown> | undefined)?.[key], value),
    ),
  );
  if (Object.keys(settings).length > 0) left.settings = settings;
  if (isEmpty(left)) await removeCacheEntry(keyFor(email));
  else await writeCacheAs(email, keyFor(email), left);
}

/** Lets what waits go: signing out, or the server refused it */
export const dropUnsent = (email: string) => removeCacheEntry(keyFor(email));

/** A profile with changes on top of it, as it's shown */
export const withPatch = (profile: Profile, patch: ProfilePatch | null): Profile =>
  patch == null
    ? profile
    : {
        ...profile,
        ...('displayName' in patch && { displayName: patch.displayName ?? null }),
        settings: { ...profile.settings, ...patch.settings },
      };
