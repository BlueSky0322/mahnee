import { useEffect, useRef } from 'react';
import { useIsDesktop, useIsMobile } from './useBreakpoints';

// On phones, Back (the Android gesture, the iOS edge swipe) closes whatever is open on
// top before it leaves the page: each sheet, menu or dialog adds a history entry when it
// opens and closes when that entry is left. Closing one any other way takes its entry
// back off, so Back never steps through layers that are already gone.

interface Layer {
  id: number;
  /** Back was pressed with this layer on top. False keeps it open. */
  onBack: () => boolean | void;
}

const LAYER_KEY = 'sfLayer';
const layers: Layer[] = [];
/** The layers with an entry in history, in the order they were added */
let entries: number[] = [];
let nextId = 1;
// Set while this code itself goes back, so that popstate isn't taken as the user's
let selfBack = 0;
// Entries to add once those goes-back land: Back is asynchronous, and an entry pushed
// before it lands is the one it would take off (a sheet opening as another closes)
let waiting: number[] = [];
// Layers closed by code whose entries are still in history, under a layer still open
const closing = new Set<number>();

const push = (id: number) => {
  window.history.pushState({ [LAYER_KEY]: id }, '');
  entries.push(id);
};

const layerOf = (state: unknown) =>
  typeof state === 'object' && state != null ? (state as Record<string, unknown>)[LAYER_KEY] : null;

function goBack(steps: number) {
  selfBack++;
  window.history.go(-steps);
}

function onPopState() {
  if (selfBack > 0) {
    selfBack--;
    if (selfBack === 0) {
      for (const id of waiting) push(id);
      waiting = [];
    }
    return;
  }
  const now = layerOf(window.history.state);
  // Whatever was added above the entry now showing is gone
  const at = typeof now === 'number' ? entries.indexOf(now) + 1 : 0;
  const gone = entries.slice(at);
  entries = entries.slice(0, at);
  const top = layers.at(-1);
  if (top != null && gone.includes(top.id)) {
    if (top.onBack() === false) {
      // Kept open (say, to ask about unsaved changes): it needs its entry back
      push(top.id);
      return;
    }
    layers.pop();
  }
  // Landed on the entry of a layer that closed under another: step over it
  const steps = popClosed();
  if (steps > 0) goBack(steps);
}

/** Takes closed layers' entries off the top of the list; how many came off */
function popClosed() {
  let steps = 0;
  while (entries.length > 0 && closing.has(entries.at(-1)!)) {
    closing.delete(entries.pop()!);
    steps++;
  }
  return steps;
}

if (typeof window !== 'undefined') window.addEventListener('popstate', onPopState);

/**
 * Lets Back close this layer while `opened` (phones only, or tablets too with
 * `tablets`). `onBack` closes it, or returns false to keep it open.
 */
export function useBackDismiss(
  opened: boolean,
  onBack: () => boolean | void,
  { tablets = false }: { tablets?: boolean } = {},
) {
  const isMobile = useIsMobile();
  const isDesktop = useIsDesktop();
  const active = tablets ? !isDesktop : isMobile;
  const latest = useRef(onBack);
  latest.current = onBack;

  useEffect(() => {
    if (!opened || !active) return;
    const layer: Layer = { id: nextId++, onBack: () => latest.current() };
    layers.push(layer);
    if (selfBack > 0) waiting.push(layer.id);
    else push(layer.id);
    return () => {
      const at = layers.indexOf(layer);
      // Already taken off by Back
      if (at === -1) return;
      layers.splice(at, 1);
      // Closed before its entry was even added
      if (waiting.includes(layer.id)) {
        waiting = waiting.filter((id) => id !== layer.id);
        return;
      }
      if (!entries.includes(layer.id)) return;
      closing.add(layer.id);
      // Closed some other way: its entry comes off too, with those of any layers closed
      // under it (a prompt and the sheet it asked about), unless the page moved on since
      if (layerOf(window.history.state) !== entries.at(-1)) return;
      const steps = popClosed();
      if (steps > 0) goBack(steps);
    };
  }, [opened, active]);
}
