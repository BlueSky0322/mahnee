import { Button } from '@mantine/core';
import { useState } from 'react';
import { unsavedState } from '../../ledger/ledger';
import { signOut } from '../../profile/ProfileContext';
import ResponsiveDialog from '../ui/ResponsiveDialog';

/** "1 change", "3 changes" */
const changes = (n: number) => `${n} ${n === 1 ? 'change' : 'changes'}`;

/**
 * Signs out, first asking when this device has changes the server hasn't saved: those
 * still waiting are removed, and those it refused stay for when they sign in again.
 * `askToSignOut()` starts; render `dialog` alongside.
 */
export function useConfirmSignOut() {
  const [unsaved, setUnsaved] = useState(0);
  const [held, setHeld] = useState(0);
  const [asking, setAsking] = useState(false);

  const askToSignOut = () => {
    const { waiting, refused } = unsavedState();
    if (waiting === 0 && refused === 0) return void signOut();
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
