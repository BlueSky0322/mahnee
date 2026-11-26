import { useEffect, useRef } from 'react';
import { dialogOpen, inField } from '../utils/fields';
import { navigate } from './useRoute';

// Keys on a computer's keyboard, each doing what a button on the page does: N for a new
// entry, / to search, Esc to close Settings, and a page's own (Activity's J, K, X and C).
// A key is a letter in lower case, or a name such as 'Escape'. None fires while typing in a
// field (but Esc and Enter, which fields leave alone): a text-like field, a list to pick
// from or editable text, though not a tick box, a choice or a button. Nor with Ctrl, Cmd or
// Alt held (the browser's own), or while a dialog is open, which takes the keys itself.

type Shortcuts = Partial<Record<string, () => void>>;

const PASS_THROUGH_FIELDS = new Set(['Escape', 'Enter']);

/** Runs `shortcuts[key]` when that key is pressed, while `enabled` */
export function useShortcuts(shortcuts: Shortcuts, enabled = true) {
  const latest = useRef(shortcuts);
  latest.current = shortcuts;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const run = latest.current[key];
      if (run == null || dialogOpen()) return;
      if (!PASS_THROUGH_FIELDS.has(key) && inField(e.target)) return;
      e.preventDefault();
      run();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

// Set when / opened Activity, so its search takes the cursor once it's drawn
let searchWanted = false;

/**
 * Puts the cursor in the page's search box; a page without one gives its place to
 * Activity, whose search takes the cursor
 */
export function focusSearch() {
  const box = document.querySelector<HTMLInputElement>('main input[type="search"]');
  if (box != null) {
    box.focus();
    return;
  }
  searchWanted = true;
  navigate('?activity', { replace: true });
}

/** Whether the search being drawn should take the cursor; asks once */
export function takeSearchFocus() {
  const wanted = searchWanted;
  searchWanted = false;
  return wanted;
}
