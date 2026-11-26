import type { ReactNode } from 'react';
import type { Counted } from '../../utils/toasts';
import { showToast } from '../../utils/toasts';

/** How long a change can be taken back from its message */
const UNDO_MS = 6000;

/**
 * Says what was just done, with Undo to take it back. For changes the app can put back
 * exactly as they were (an archived account): Undo makes the opposite change. Put away
 * (Dismiss, a swipe, Esc) it goes as it would by itself, the change made. `counted` adds
 * it up with the same message still showing ("Deleted 2 entries"), whose Undo then takes
 * back both, the newest first: only for changes whose Undos don't depend on each other.
 */
export function showUndo(message: ReactNode, undo: () => void, counted?: Counted) {
  showToast({ message, action: { label: 'Undo', run: undo }, autoClose: UNDO_MS, counted });
}
