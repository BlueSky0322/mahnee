import type { ProfilePatch } from '@shared/api';
import type { Profile } from '../api';
import { createStore, get } from 'idb-keyval';
import { cacheUser } from '../offline/cache';
import { newId } from '../utils/id';

// Profile and preference changes made without a connection, kept on the device for the
// account they were made as until the server has them: one patch per person, the latest
// value of each field changed. Sending it twice changes nothing, so no ids are needed. Like
// the outbox, it stays theirs alone when someone else signs in here (UNSENT_PREFIXES).
//
// IndexedDB serializes each read and change across tabs. A field's revision distinguishes
// a new edit from an older request for the same value.

/** Where a person's unsent profile changes are kept (UNSENT_PREFIXES in offline/cache.ts) */
export const PROFILE_OUTBOX_PREFIX = 'profile-outbox:';
const keyFor = (email: string) => `${PROFILE_OUTBOX_PREFIX}${email}`;

/** Only the name and preferences wait; the picture and the home currency need a connection */
export const canWait = (patch: ProfilePatch) =>
  patch.picture === undefined && patch.settings?.currency === undefined;

const isEmpty = (patch: ProfilePatch) =>
  !('displayName' in patch) && Object.keys(patch.settings ?? {}).length === 0;

export interface Pending {
  patch: ProfilePatch;
  revisions: Partial<Record<string, string>>;
}

interface Stored {
  email: string;
  value: ProfilePatch;
  revisions?: Pending['revisions'];
}

const store = createStore('keyval-store', 'keyval');

function checkOwner(email: string) {
  if (cacheUser() !== email) throw new Error('Someone else is signed in here');
}

function unpack(email: string, stored: Stored | undefined): Pending | null {
  if (stored == null) return null;
  if (stored.email !== email || stored.value == null || typeof stored.value !== 'object') {
    throw new Error('Could not read pending settings');
  }
  return isEmpty(stored.value) ? null : { patch: stored.value, revisions: stored.revisions ?? {} };
}

async function editPending(email: string, edit: (before: Pending | null) => Pending | null) {
  checkOwner(email);
  return store('readwrite', (objectStore) => {
    const transaction = objectStore.transaction;
    return new Promise<Pending | null>((resolve, reject) => {
      let after: Pending | null;
      transaction.oncomplete = () => resolve(after);
      transaction.onabort = () => reject(new Error('Could not keep pending settings'));
      const key = keyFor(email);
      const read = objectStore.get(key);
      read.onsuccess = () => {
        try {
          checkOwner(email);
          after = edit(unpack(email, read.result as Stored | undefined));
          if (after == null) objectStore.delete(key);
          else {
            objectStore.put({ email, value: after.patch, revisions: after.revisions }, key);
          }
        } catch (err) {
          transaction.abort();
          reject(err instanceof Error ? err : new Error('Could not keep pending settings'));
        }
      };
    });
  });
}

/** The exact values and revisions to acknowledge after this request answers. */
export async function readPending(email: string): Promise<Pending | null> {
  checkOwner(email);
  const stored = await get<Stored>(keyFor(email));
  checkOwner(email);
  return unpack(email, stored);
}

/** What `email` changed here that the server doesn't have yet, if anything. */
export const readUnsent = async (email: string) => (await readPending(email))?.patch ?? null;

/** The fields a patch changes: `displayName`, and each setting by its name */
export const fieldsOf = (patch: ProfilePatch) => [
  ...('displayName' in patch ? ['displayName'] : []),
  ...Object.keys(patch.settings ?? {}),
];

/** Two changes as one, the second's fields over the first's. */
export const merged = (older: Pending, newer: Pending): Pending => ({
  patch: {
    ...('displayName' in older.patch && { displayName: older.patch.displayName }),
    ...('displayName' in newer.patch && { displayName: newer.patch.displayName }),
    ...((older.patch.settings != null || newer.patch.settings != null) && {
      settings: { ...older.patch.settings, ...newer.patch.settings },
    }),
  },
  revisions: {
    ...older.revisions,
    ...Object.fromEntries(fieldsOf(newer.patch).map((field) => [field, newer.revisions[field]])),
  },
});

async function keep(email: string, patch: ProfilePatch, older: boolean) {
  const revision = newId();
  const edit = {
    patch,
    revisions: Object.fromEntries(fieldsOf(patch).map((key) => [key, revision])),
  };
  await editPending(email, (before) => {
    if (before == null) return isEmpty(patch) ? null : edit;
    return older ? merged(edit, before) : merged(before, edit);
  });
  return edit;
}

/** Adds a change to what waits, the newer value of a field winning. */
export const keepUnsent = (email: string, patch: ProfilePatch) => keep(email, patch, false);

/** A save that was on its way when the connection dropped goes under edits since kept. */
export const keepUnsentUnder = (email: string, patch: ProfilePatch) => keep(email, patch, true);

/** Removes only the revisions answered for, or unchanged values from a legacy record. */
export async function settleUnsent(email: string, sent: Pending, answered = sent.patch) {
  const after = await editPending(email, (before) => {
    if (before == null) return null;
    const same = (key: string, value: unknown, expected: unknown) =>
      before.revisions[key] === sent.revisions[key] &&
      JSON.stringify(value) === JSON.stringify(expected);
    const left: ProfilePatch = {};
    if (
      'displayName' in before.patch &&
      !(
        'displayName' in answered &&
        same('displayName', before.patch.displayName, answered.displayName)
      )
    ) {
      left.displayName = before.patch.displayName;
    }
    const settings = answered.settings as Record<string, unknown> | undefined;
    const kept = Object.entries(before.patch.settings ?? {}).filter(
      ([key, value]) => settings == null || !(key in settings) || !same(key, value, settings[key]),
    );
    if (kept.length > 0) left.settings = Object.fromEntries(kept);
    return isEmpty(left)
      ? null
      : {
          patch: left,
          revisions: Object.fromEntries(fieldsOf(left).map((key) => [key, before.revisions[key]])),
        };
  });
  return after?.patch ?? null;
}

/** Lets what waits go when signing out. */
export const dropUnsent = (email: string) => editPending(email, () => null);

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
