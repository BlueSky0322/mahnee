import { Button } from '@mantine/core';
import { useState } from 'react';
import type { ProfilePatch } from '@shared/api';
import { unsavedState } from '../../ledger/ledger';
import { cacheUser } from '../../offline/cache';
import { signOut } from '../../profile/ProfileContext';
import { unsentNow } from '../../profile/unsent';
import { SETTINGS_INDEX } from '../settings/settings-search';
import ResponsiveDialog from '../ui/ResponsiveDialog';

/** "1 change", "3 changes" */
const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

/** Where each field of the profile is found in Settings, by the key it's searched by */
const SETTING_KEYS: Record<string, string> = {
  displayName: 'name',
  otherCurrencies: 'otherCurrencies',
  travelSense: 'travelSense',
  monthStartMode: 'monthStart',
  monthStartDay: 'monthStart',
  monthStartPayId: 'monthStart',
  weekStart: 'weekStart',
  startWith: 'startWith',
  defaultAccountId: 'account',
  suggestAsYouType: 'suggest',
  askForTime: 'time',
  theme: 'theme',
  accent: 'accent',
  expenseColour: 'expenseColour',
  homeDensity: 'homeShows',
  startScreen: 'start',
  carryOverDefault: 'carryOver',
  dailyReminder: 'dailyReminder',
  reminderTime: 'remindAt',
  scheduledReminderDays: 'beforeScheduled',
};

/** The settings a waiting patch changes, as Settings names them, each once */
function settingNames(patch: ProfilePatch | null): string[] {
  if (patch == null) return [];
  const fields = [
    ...('displayName' in patch ? ['displayName'] : []),
    ...Object.keys(patch.settings ?? {}),
  ];
  const names = fields
    .map((f) => SETTINGS_INDEX.find((e) => e.key === SETTING_KEYS[f])?.name)
    .filter((n): n is string => n != null);
  return [...new Set(names)];
}

/** "Start with", "Start with and Theme", "Start with, Theme and Accent" */
const listed = (names: string[]) =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

/**
 * Signs out, first asking when this device has changes the server hasn't saved (settings
 * changed offline among them, named): those still waiting are removed, and those it
 * refused stay for when they sign in again.
 * `askToSignOut()` starts; render `dialog` alongside.
 */
export function useConfirmSignOut() {
  const [unsaved, setUnsaved] = useState(0);
  const [held, setHeld] = useState(0);
  const [settings, setSettings] = useState<string[]>([]);
  const [asking, setAsking] = useState(false);

  const askToSignOut = () => {
    const { waiting, refused } = unsavedState();
    const email = cacheUser();
    const changed = settingNames(email == null ? null : unsentNow(email));
    if (waiting === 0 && refused === 0 && changed.length === 0) return void signOut();
    setSettings(changed);
    setUnsaved(waiting);
    setHeld(refused);
    setAsking(true);
  };
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
