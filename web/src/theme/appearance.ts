import { useSyncExternalStore } from 'react';
import type { Accent, ExpenseColour } from '@shared/api';
import { DEFAULT_SETTINGS } from '@shared/api';

// The accent the app is drawn in and the colour of spending, as the person chose them in
// Look and start: marked on the page (data-accent, data-expenses on <html>) for the
// stylesheets (theme/tokens.css), and kept here for Mantine's own colours (Root.tsx)

let accent: Accent = DEFAULT_SETTINGS.accent;
const listeners = new Set<() => void>();

/** Draws the app in `next`, at once */
export function showAccent(next: Accent) {
  document.documentElement.setAttribute('data-accent', next);
  if (next === accent) return;
  accent = next;
  listeners.forEach((l) => l());
}

/** Spending in ink, or in red; income is always green */
export function showExpenseColour(colour: ExpenseColour) {
  if (colour === 'red') document.documentElement.setAttribute('data-expenses', 'red');
  else document.documentElement.removeAttribute('data-expenses');
}

/** The accent the app is drawn in, following every change */
export const useAccent = () =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => accent,
  );
