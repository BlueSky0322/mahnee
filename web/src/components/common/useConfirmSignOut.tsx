import { Button } from '@mantine/core';
import { useRef, useState } from 'react';
import type { ProfilePatch } from '@shared/api';
import { deviceChangesRead, unsavedState } from '../../ledger/ledger';
import { cacheUser } from '../../offline/cache';
import { signOut, useProfile } from '../../profile/ProfileContext';
import { readUnsent } from '../../profile/unsent';
import { SETTINGS_INDEX, SETTING_OF_FIELD } from '../settings/settings-search';
import ResponsiveDialog from '../ui/ResponsiveDialog';

/** "1 change", "3 changes" */
const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

/** The settings a waiting patch changes, as Settings names them, each once */
function settingNames(patch: ProfilePatch | null): string[] {
  if (patch == null) return [];
  const fields = [
    ...('displayName' in patch ? ['displayName'] : []),
    ...Object.keys(patch.settings ?? {}),
  ];
  const names = fields
    .map((f) => SETTINGS_INDEX.find((e) => e.key === SETTING_OF_FIELD[f])?.name)
    .filter((n): n is string => n != null);
  return [...new Set(names)];
}

/** How long Sign out waits to learn what this device keeps before asking anyway */
const READ_WAIT_MS = 2000;

/**
 * The settings changed here that the server doesn't have yet, once what this device keeps
 * for the signed-in account has been read (its waiting and refused changes too); null if
 * that can't be known within READ_WAIT_MS
 */
async function readWhatWaits(flushSettings: () => Promise<void>): Promise<string[] | null> {
  const read = (async () => {
    // Settings still in their pause are sent first, so none is asked about needlessly
    await flushSettings();
    await deviceChangesRead();
    const email = cacheUser();
    return email == null ? null : settingNames(await readUnsent(email));
  })().catch(() => null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), READ_WAIT_MS);
  });
  try {
    return await Promise.race([read, late]);
  } finally {
    clearTimeout(timer);
  }
}

/** "Start with", "Start with and Theme", "Start with, Theme and Accent" */
const listed = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * Signs out, first asking when this device has changes the server hasn't saved (settings
 * changed offline among them, named): those still waiting are removed, and those it
 * refused stay for when they sign in again. It decides only once what the device keeps
 * has been read; if that takes too long, it asks anyway, rather than sign out without
 * knowing. `askToSignOut()` starts; render `dialog` alongside.
 */
export function useConfirmSignOut() {
  const { flushSettings } = useProfile();
  const [unsaved, setUnsaved] = useState(0);
  const [held, setHeld] = useState(0);
  const [settings, setSettings] = useState<string[]>([]);
  const [unknown, setUnknown] = useState(false);
  const [asking, setAsking] = useState(false);
  // Pressed again while the device is read: the first press decides
  const checking = useRef(false);

  const decide = async () => {
    if (checking.current) return;
    checking.current = true;
    try {
      const changed = await readWhatWaits(flushSettings);
      const { waiting, refused } = unsavedState();
      if (changed != null && waiting === 0 && refused === 0 && changed.length === 0) {
        return void signOut();
      }
      setUnknown(changed == null);
      setSettings(changed ?? []);
      setUnsaved(waiting);
      setHeld(refused);
      setAsking(true);
    } finally {
      checking.current = false;
    }
  };
  const askToSignOut = () => void decide();
  const cancel = () => setAsking(false);

  const dialog = (
    <ResponsiveDialog
      opened={asking}
      onClose={cancel}
      title="Sign out anyway?"
      width={400}
      floating
    >
      <div className="flex flex-col gap-4">
        {unsaved > 0 && (
          <p className="sf-muted m-0 text-sm">
            {unsaved === 1 ? "1 change hasn't" : `${unsaved} changes haven't`} been saved yet.
            Signing out removes {unsaved === 1 ? 'it' : 'them'} from this device; to keep{' '}
            {unsaved === 1 ? 'it' : 'them'}, stay signed in until you're online and{' '}
            {unsaved === 1 ? "it's" : "they're"} saved.
          </p>
        )}
        {unknown && (
          <p className="sf-muted m-0 text-sm">
            Changes on this device are still being checked. Signing out now may remove ones that
            haven&apos;t been saved.
          </p>
        )}
        {settings.length > 0 && (
          <p className="sf-muted m-0 text-sm">
            {`Your ${settings.length === 1 ? 'change' : 'changes'} to ${listed(settings)} ${
              settings.length === 1 ? "hasn't" : "haven't"
            } been saved yet. Signing out removes ${
              settings.length === 1 ? 'it' : 'them'
            } from this device.`}
          </p>
        )}
        {held > 0 && (
          <p className="sf-muted m-0 text-sm">
            {changes(held)} the server couldn&apos;t save {held === 1 ? 'stays' : 'stay'} on this
            device for when you sign in again.
          </p>
        )}
        <div className="flex justify-end gap-2">
          <Button
            variant="default"
            onClick={cancel}
          >
            Stay signed in
          </Button>
          <Button
            variant="default"
            className="sf-danger-outline"
            onClick={() => {
              setAsking(false);
              void signOut();
            }}
          >
            Sign out anyway
          </Button>
        </div>
      </div>
    </ResponsiveDialog>
  );
  return { askToSignOut, dialog };
}
