import { Button } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';

/** How long a change can be taken back from its message */
const UNDO_MS = 6000;

/**
 * Says what was just done, with Undo to take it back. For changes the app can put back
 * exactly as they were (an archived account): Undo makes the opposite change.
 */
export function showUndo(message: ReactNode, undo: () => void) {
  const id = notifications.show({
    message: (
      <div className="flex items-center justify-between gap-3">
        <span>{message}</span>
        <Button
          variant="subtle"
          size="compact-sm"
          onClick={() => {
            undo();
            notifications.hide(id);
          }}
        >
          Undo
        </Button>
      </div>
    ),
    autoClose: UNDO_MS,
  });
}
