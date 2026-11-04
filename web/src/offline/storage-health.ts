import { useSyncExternalStore } from 'react';

// Whether this device kept the latest unsent work (changes, new splits). When it can't
// (storage full, or blocked as in some private windows), the work still goes from
// memory while the app is open, but would be lost if it closed first, so the app says
// so until a later write is kept.

let keeping = true;
const listeners = new Set<() => void>();

/** Called after each write of unsent work, with whether the device kept it */
export function reportKept(kept: boolean) {
  if (kept === keeping) return;
  keeping = kept;
  for (const listener of listeners) listener();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** False while this device can't keep unsent work */
export const useKeepingWork = () => useSyncExternalStore(subscribe, () => keeping);
