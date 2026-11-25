import { useEffect, useRef, useState } from 'react';
import type React from 'react';

// Selecting many of Activity's rows with a pointer or a finger (R-Activity-Select,
// R-Desk-Bulk). With a mouse or a pen, pressing on a row and dragging up or down ticks the
// rows under the pointer, like a file manager: dragging back unticks the rows it had added,
// and what was ticked before the drag stays ticked, so a drag never loses a selection,
// wherever it starts. Near the top or bottom edge the page scrolls by itself. A press that
// moves less than a few pixels is a plain click, as before. With a finger, a long press
// (held still) starts selecting instead; scrolling never selects.

/** How far a mouse moves before a press is a drag, not a click */
export const DRAG_PX = 4;
/** How long a finger holds a row still to start selecting with it */
export const HOLD_MS = 450;
/** How far a finger may move while holding before it counts as scrolling */
export const HOLD_SLOP_PX = 10;
/** How near the top or bottom edge the pointer comes before the page scrolls by itself */
export const EDGE_PX = 48;
/** The fastest the page scrolls by itself, in pixels a step */
const SCROLL_STEP_PX = 18;
const SCROLL_EVERY_MS = 16;

/** The attribute a row carries with its entry's id, for the gestures to find it */
export const ROW_ATTR = 'data-select-id';

/** The ids from `a` to `b`, both included, in the order they're drawn */
export function between(order: readonly string[], a: string, b: string): string[] {
  const from = order.indexOf(a);
  const to = order.indexOf(b);
  if (from === -1 || to === -1) return to === -1 ? [] : [b];
  return order.slice(Math.min(from, to), Math.max(from, to) + 1);
}

/** `base` with `more` added, as a new set */
export const withAll = (base: ReadonlySet<string>, more: readonly string[]) => {
  const next = new Set(base);
  for (const id of more) next.add(id);
  return next;
};

/**
 * The row a press is on, unless it's on something inside the row with its own click: a
 * link, a button, a field or tick box, or the editor
 */
function rowOf(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null;
  const row = target.closest<HTMLElement>(`[${ROW_ATTR}]`);
  if (row == null) return null;
  const own = target.closest(
    'a, button, input, select, textarea, label, [contenteditable], [role="dialog"]',
  );
  return own != null && own !== row && row.contains(own) ? null : row;
}

/** The row under a point on the screen, where the browser can say */
function rowAt(x: number, y: number): HTMLElement | null {
  const at =
    typeof document.elementFromPoint === 'function' ? document.elementFromPoint(x, y) : null;
  return at?.closest<HTMLElement>(`[${ROW_ATTR}]`) ?? null;
}

/** What scrolls the rows: the nearest box that scrolls up and down, else the page */
function scrollerOf(el: Element): Element | null {
  for (let at = el.parentElement; at != null; at = at.parentElement) {
    const { overflowY } = getComputedStyle(at);
    // A box that scrolls only sideways has a pixel or two over at most
    if ((overflowY === 'auto' || overflowY === 'scroll') && at.scrollHeight > at.clientHeight + 4) {
      return at;
    }
  }
  return null;
}

/** How far to scroll by itself with the pointer at `y`: up (below 0), down, or not (0) */
function edgeStep(y: number, top: number, bottom: number) {
  if (y < top + EDGE_PX)
    return -Math.ceil(SCROLL_STEP_PX * Math.min(1, (top + EDGE_PX - y) / EDGE_PX));
  if (y > bottom - EDGE_PX) {
    return Math.ceil(SCROLL_STEP_PX * Math.min(1, (y - (bottom - EDGE_PX)) / EDGE_PX));
  }
  return 0;
}

/** Keeps the next click from doing anything: the release of a drag isn't a click */
function swallowNextClick() {
  const swallow = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
  };
  window.addEventListener('click', swallow, { capture: true, once: true });
  // A release with no click after it (off the row it started on) leaves the next one be
  setTimeout(() => window.removeEventListener('click', swallow, { capture: true }), 0);
}

interface Drag {
  pointerId: number;
  x: number;
  y: number;
  anchor: string;
  base: Set<string>;
  active: boolean;
  last: string;
  scroll: ReturnType<typeof setInterval> | null;
  step: number;
}

/**
 * Drag to select with a mouse or a pen, over rows marked with ROW_ATTR, in `order`.
 * `selected` is what's ticked as the drag starts; `onRange` gets what's ticked as it
 * grows or shrinks, and `onEnd` the drag's anchor and what was ticked before it, once
 * it's let go. Hand `onPointerDown` to the list.
 */
export function useDragSelect({
  order,
  selected,
  onRange,
  onEnd,
  enabled = true,
}: {
  order: readonly string[];
  selected: ReadonlySet<string>;
  onRange: (next: Set<string>) => void;
  onEnd?: (anchor: string, base: Set<string>) => void;
  enabled?: boolean;
}) {
  const [dragging, setDragging] = useState(false);
  const latest = useRef({ order, selected, onRange, onEnd });
  latest.current = { order, selected, onRange, onEnd };
  const drag = useRef<Drag | null>(null);
  const stop = useRef<(() => void) | null>(null);
  useEffect(() => () => stop.current?.(), []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!enabled || e.button !== 0 || (e.pointerType !== 'mouse' && e.pointerType !== 'pen')) {
      return;
    }
    const row = rowOf(e.target);
    const id = row?.getAttribute(ROW_ATTR);
    if (row == null || id == null) return;
    stop.current?.();
    const now: Drag = {
      pointerId: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      anchor: id,
      base: new Set(latest.current.selected),
      active: false,
      last: id,
      scroll: null,
      step: 0,
    };
    drag.current = now;
    const scroller = scrollerOf(row);
    let pointerY = e.clientY;
    let pointerX = e.clientX;

    const reach = (over: HTMLElement | null) => {
      const to = over?.getAttribute(ROW_ATTR);
      if (to == null || (to === now.last && now.active)) return;
      if (!latest.current.order.includes(to)) return;
      now.last = to;
      latest.current.onRange(withAll(now.base, between(latest.current.order, now.anchor, to)));
    };
    const scrollBy = (dy: number) => {
      if (scroller == null) window.scrollBy(0, dy);
      else scroller.scrollTop += dy;
    };
    const edges = () => {
      if (scroller == null) return { top: 0, bottom: window.innerHeight };
      const box = scroller.getBoundingClientRect();
      return { top: Math.max(0, box.top), bottom: Math.min(window.innerHeight, box.bottom) };
    };
    const autoScroll = () => {
      const { top, bottom } = edges();
      now.step = edgeStep(pointerY, top, bottom);
      if (now.step === 0 && now.scroll != null) {
        clearInterval(now.scroll);
        now.scroll = null;
      } else if (now.step !== 0 && now.scroll == null) {
        now.scroll = setInterval(() => {
          scrollBy(now.step);
          // The rows moved under a pointer held still
          reach(rowAt(pointerX, pointerY));
        }, SCROLL_EVERY_MS);
      }
    };
    const noTextSelection = (ev: Event) => ev.preventDefault();

    const move = (ev: PointerEvent) => {
      if (ev.pointerId !== now.pointerId) return;
      pointerX = ev.clientX;
      pointerY = ev.clientY;
      if (!now.active) {
        if (Math.hypot(ev.clientX - now.x, ev.clientY - now.y) < DRAG_PX) return;
        now.active = true;
        setDragging(true);
        window.getSelection?.()?.removeAllRanges();
        document.addEventListener('selectstart', noTextSelection);
        latest.current.onRange(withAll(now.base, [now.anchor]));
      }
      ev.preventDefault();
      // Off the rows (above or below the list), the range stays as it was
      reach(
        (ev.target instanceof Element ? ev.target.closest<HTMLElement>(`[${ROW_ATTR}]`) : null) ??
          rowAt(ev.clientX, ev.clientY),
      );
      autoScroll();
    };
    const end = (ev?: Event) => {
      if (ev instanceof PointerEvent && ev.pointerId !== now.pointerId) return;
      const was = now.active;
      finish();
      if (was) {
        if (ev?.type === 'pointerup') swallowNextClick();
        latest.current.onEnd?.(now.anchor, now.base);
      }
    };
    const finish = () => {
      if (now.scroll != null) clearInterval(now.scroll);
      now.scroll = null;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      document.removeEventListener('selectstart', noTextSelection);
      if (drag.current === now) drag.current = null;
      stop.current = null;
      if (now.active) setDragging(false);
    };
    stop.current = finish;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  };

  return { onPointerDown, dragging };
}

/**
 * A long press with a finger: held still for HOLD_MS calls `onHold` with the row's id, and
 * the release that follows isn't a tap. Moving more than HOLD_SLOP_PX (scrolling) lets it
 * go. A mouse never long-presses; it drags.
 */
export function useLongPress(onHold: (id: string) => void) {
  const press = useRef<{
    timer: ReturnType<typeof setTimeout> | null;
    fired: boolean;
    x: number;
    y: number;
  }>({ timer: null, fired: false, x: 0, y: 0 });
  const latest = useRef(onHold);
  latest.current = onHold;
  const letGo = () => {
    if (press.current.timer != null) clearTimeout(press.current.timer);
    press.current.timer = null;
  };
  useEffect(() => letGo, []);

  /** The handlers for the row of entry `id` */
  const handlers = (id: string) => ({
    onPointerDown: (e: React.PointerEvent) => {
      letGo();
      press.current.fired = false;
      if (e.pointerType === 'mouse') return;
      press.current.x = e.clientX;
      press.current.y = e.clientY;
      press.current.timer = setTimeout(() => {
        press.current.timer = null;
        press.current.fired = true;
        // A light tap of the phone, where it can
        if (typeof navigator.vibrate === 'function') navigator.vibrate(10);
        latest.current(id);
      }, HOLD_MS);
    },
    onPointerMove: (e: React.PointerEvent) => {
      if (press.current.timer == null) return;
      if (Math.hypot(e.clientX - press.current.x, e.clientY - press.current.y) > HOLD_SLOP_PX) {
        letGo();
      }
    },
    onPointerUp: letGo,
    onPointerLeave: letGo,
    onPointerCancel: letGo,
    // A long press on a phone would open the browser's menu
    onContextMenu: (e: React.MouseEvent) => {
      if (press.current.timer != null || press.current.fired) e.preventDefault();
    },
  });

  /** Whether the click now is the release of a long press, which then isn't a tap */
  const takeRelease = () => {
    const was = press.current.fired;
    press.current.fired = false;
    return was;
  };
  /** A fresh press, so the next tick is never mistaken for a long press's release */
  const fresh = () => (press.current.fired = false);

  return { handlers, takeRelease, fresh };
}
