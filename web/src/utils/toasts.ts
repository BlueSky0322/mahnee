import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';

// The app's messages at the foot of the screen (components/ui/Toasts draws them): what was
// just done, with Undo; a refusal; a note. Each goes by itself after a few seconds, or
// sooner when the person puts it away (its Dismiss, a swipe, Esc), which never undoes
// anything: it's the same as letting it go.
//
// At most MAX_SHOWN show at once, the newest nearest the foot. An older one past that
// waits out of sight, its seconds stopped, and shows again once a newer one goes, so no
// Undo is lost before it has had its time. The same counted message again (two deletes
// in a row) adds up in the one showing ("Deleted 2 entries"), whose Undo takes back both.

/** How many messages show at once */
export const MAX_SHOWN = 2;
/** How long a message stays, unless it says otherwise */
const DEFAULT_MS = 4000;

export type ToastTone = 'plain' | 'error' | 'warning';

export interface ToastAction {
  label: string;
  run: () => void;
}

/** A message that adds up with the next one like it while it shows */
export interface Counted {
  /** Messages with the same key add up */
  key: string;
  count: number;
  /** What the message says for `count` */
  say: (count: number) => string;
}

export interface ToastInput {
  message: ReactNode;
  tone?: ToastTone;
  /** A button doing something about it (Undo), which puts the message away once pressed */
  action?: ToastAction;
  /** How long it stays, in ms */
  autoClose?: number;
  counted?: Counted;
}

export interface Toast {
  id: number;
  message: ReactNode;
  tone: ToastTone;
  action: ToastAction | null;
}

interface Kept extends Toast {
  counted: Counted | null;
  /** What its action does, before putting the message away */
  does: ToastAction | null;
  /** How long it has left while showing */
  left: number;
  /** When its seconds started running, while they are */
  since: number | null;
  timer: ReturnType<typeof setTimeout> | null;
  /** Held while the pointer is over it or the keyboard in it */
  held: boolean;
}

let kept: Kept[] = [];
let nextId = 1;
let shown: Toast[] = [];
const listeners = new Set<() => void>();

const isShown = (t: Kept) => kept.indexOf(t) >= kept.length - MAX_SHOWN;

/** Runs the seconds of the messages showing and not held; stops the others' */
function retime() {
  for (const t of kept) {
    const running = isShown(t) && !t.held;
    if (running && t.timer == null) {
      t.since = Date.now();
      t.timer = setTimeout(() => hideToast(t.id), t.left);
    } else if (!running && t.timer != null) {
      clearTimeout(t.timer);
      t.timer = null;
      t.left = Math.max(0, t.left - (Date.now() - (t.since ?? Date.now())));
      t.since = null;
    }
  }
}

function changed() {
  retime();
  shown = kept
    .slice(-MAX_SHOWN)
    .map(({ id, message, tone, action }) => ({ id, message, tone, action }));
  for (const listener of [...listeners]) listener();
}

function stop(t: Kept) {
  if (t.timer != null) clearTimeout(t.timer);
  t.timer = null;
}

/** Shows a message; answers its id */
export function showToast({
  message,
  tone = 'plain',
  action,
  autoClose = DEFAULT_MS,
  counted,
}: ToastInput): number {
  const id = nextId++;
  let undo = action ?? null;
  let said = message;
  let total = counted ?? null;
  const same = counted == null ? null : kept.find((t) => t.counted?.key === counted.key);
  if (same != null && counted != null) {
    // Adds up with the one like it: one message, and its Undo takes back both, the newest
    // first. It shows as the newest, with its full seconds again.
    const count = same.counted!.count + counted.count;
    total = { ...counted, count };
    said = counted.say(count);
    const earlier = same.does;
    const later = action;
    if (earlier != null && later != null) {
      undo = {
        label: later.label,
        run: () => {
          later.run();
          earlier.run();
        },
      };
    }
    stop(same);
    kept = kept.filter((t) => t !== same);
  }
  const t: Kept = {
    id,
    message: said,
    tone,
    action: null,
    does: undo,
    counted: total,
    left: autoClose,
    since: null,
    timer: null,
    held: false,
  };
  // Pressing the action puts the message away, once
  if (undo != null) {
    const run = undo.run;
    t.action = {
      label: undo.label,
      run: () => {
        if (!kept.includes(t)) return;
        hideToast(id);
        run();
      },
    };
  }
  kept = [...kept, t];
  changed();
  return id;
}

/** Puts a message away (gone by itself, or put away), leaving what it said as it is */
export function hideToast(id: number) {
  const t = kept.find((k) => k.id === id);
  if (t == null) return;
  stop(t);
  kept = kept.filter((k) => k !== t);
  changed();
}

/** The newest message showing, for Esc to put away */
export const newestToast = (): number | null => kept.at(-1)?.id ?? null;

/** Stops a message's seconds while the pointer is over it or the keyboard in it */
export function holdToast(id: number, held: boolean) {
  const t = kept.find((k) => k.id === id);
  if (t == null || t.held === held) return;
  t.held = held;
  changed();
}

/** Every message gone, at once (a test closing the app) */
export function clearToasts() {
  for (const t of kept) stop(t);
  kept = [];
  changed();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** The messages showing, oldest first */
export const useToasts = () =>
  useSyncExternalStore(
    subscribe,
    () => shown,
    () => shown,
  );
