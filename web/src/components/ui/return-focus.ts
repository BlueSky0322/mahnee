import { useEffect, useRef } from 'react';

// Where focus goes once a dialog closes, for every dialog the app draws on Mantine: each
// passes returnFocus={false} and puts this hook's ref on its root.

/** How long after closing focus goes back to what opened the dialog, as Mantine does */
const RETURN_FOCUS_MS = 10;

/**
 * Puts focus back on what opened the dialog once it closes, unless it has gone somewhere
 * else since: a toast's Undo reached right after closing keeps it, so Enter undoes
 * rather than opening the dialog again. Mantine's own return takes focus back regardless.
 */
export function useReturnFocus(opened: boolean) {
  const root = useRef<HTMLDivElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (opened) {
      opener.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null;
      return;
    }
    const back = opener.current;
    opener.current = null;
    if (back == null) return;
    const timer = window.setTimeout(() => {
      const now = document.activeElement;
      const leftHere = now == null || now === document.body || root.current?.contains(now);
      if (leftHere) back.focus({ preventScroll: true });
    }, RETURN_FOCUS_MS);
    return () => window.clearTimeout(timer);
  }, [opened]);
  return root;
}
