import { notifications } from '@mantine/notifications';
import type { ReactNode } from 'react';
import classes from './undo-toast.module.css';

/** How long a change can be taken back from its message */
const UNDO_MS = 6000;

/**
 * Says what was just done, with Undo to take it back. For changes the app can put back
 * exactly as they were (an archived account): Undo makes the opposite change. Drawn as the
 * design's toast, ink with an underlined Undo; it goes by itself, so it has no close button
 * (other messages, such as refusals, keep theirs).
 */
export function showUndo(message: ReactNode, undo: () => void) {
  const id = notifications.show({
    message: (
      <div className={classes.content}>
        <span>{message}</span>
        <button
          type="button"
          className={classes.undo}
          onClick={() => {
            undo();
            notifications.hide(id);
          }}
        >
          Undo
        </button>
      </div>
    ),
    autoClose: UNDO_MS,
    withCloseButton: false,
    classNames: { root: classes.toast, description: classes.description, body: classes.body },
  });
}
