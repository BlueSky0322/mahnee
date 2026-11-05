import { Button } from '@mantine/core';
import { useState } from 'react';
import { unsavedState } from '../../ledger/ledger';
import { signOut } from '../../profile/ProfileContext';
import ResponsiveDialog from '../ui/ResponsiveDialog';

/**
 * Signs out, first asking when this device has changes the server hasn't saved yet,
 * since signing out removes them. `askToSignOut()` starts; render `dialog` alongside.
 */
export function useConfirmSignOut() {
  const [unsaved, setUnsaved] = useState(0);
  const [asking, setAsking] = useState(false);

  const askToSignOut = () => {
    const { waiting } = unsavedState();
    if (waiting === 0) return void signOut();
    setUnsaved(waiting);
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
        <p className="sf-muted m-0 text-sm">
          {unsaved === 1 ? "1 change hasn't" : `${unsaved} changes haven't`} been saved yet. Signing
          out removes {unsaved === 1 ? 'it' : 'them'} from this device; to keep{' '}
          {unsaved === 1 ? 'it' : 'them'}, stay signed in until you're online and{' '}
          {unsaved === 1 ? "it's" : "they're"} saved.
        </p>
        <div className="flex justify-end gap-2">
          <Button
            variant="default"
            onClick={cancel}
          >
            Stay signed in
          </Button>
          <Button
            color="red"
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
