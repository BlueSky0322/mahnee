import type { MouseEvent } from 'react';
import type { Place } from '../../hooks/useRoute';
import { navigate } from '../../hooks/useRoute';

/** The places, in the order the tab bar and sidebar list them, and each one's address */
export const PLACES: { place: Place; label: string; address: string }[] = [
  { place: 'home', label: 'Home', address: '' },
  { place: 'activity', label: 'Activity', address: '?activity' },
  { place: 'plan', label: 'Plan', address: '?plan' },
  { place: 'accounts', label: 'Accounts', address: '?accounts' },
];

/**
 * Goes to a place in the page's own place, so Back never walks through them. A click with
 * Ctrl or Cmd held is left to the browser, which opens it in a new tab.
 */
export function goToPlace(e: MouseEvent, address: string) {
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  navigate(address, { replace: true });
}

/** A place's link target: Home is the app's own address */
export const hrefOf = (address: string) => address || window.location.pathname;
