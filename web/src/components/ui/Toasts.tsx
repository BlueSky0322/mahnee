import { useEffect, useRef } from 'react';
import type React from 'react';
import { useBottomPlace } from '../../utils/bottom-bars';
import { dialogOpen, inField } from '../../utils/fields';
import type { Toast } from '../../utils/toasts';
import { hideToast, holdToast, newestToast, useToasts } from '../../utils/toasts';
import { AlertIcon, CloseIcon } from './icons';
import classes from './Toasts.module.css';

// The app's messages (utils/toasts.ts), drawn as the design's toast: ink, 16px round, the
// newest nearest the foot of the screen, above whatever is fixed there (utils/bottom-bars).
// Each can be put away before it goes by itself:
// - its Dismiss button (an X, with a 44px tap area);
// - a swipe sideways, or down: it follows the finger, goes back if let go short of the
//   threshold, and flies out past it (or on a quick flick); with reduced motion it just
//   goes;
// - Esc, for the newest (or the one the keyboard is in), unless a dialog is open or the
//   keyboard is in a field. Esc puts a message away before it does anything on the page
//   (letting go of Activity's ticks), as the top layer closes first.

/** Between the messages and the bar under them */
const GAP_PX = 12;
/** How far a finger moves before it's a swipe, not a tap */
const SLOP_PX = 8;
/** How far sideways a swipe goes to put the message away, at least */
const SIDEWAYS_PX = 72;
/** How far down */
const DOWN_PX = 48;
/** A flick this fast (px a ms) over at least FLICK_PX puts it away too */
const FLICK_SPEED = 0.6;
const FLICK_PX = 24;
/** How long it takes to fly out, or go back */
const FLY_MS = 180;
/** Room left over the bars, under which the messages go to the top of the screen instead */
const ROOM_PX = 160;

const reducedMotion = () =>
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export default function Toasts() {
  const toasts = useToasts();
  const { clearance, height } = useBottomPlace();

  // Esc puts away the newest message, or the one the keyboard is in, before the page's keys
  // (useShortcuts) see it
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
      if (dialogOpen() || inField(e.target)) return;
      const inOne =
        e.target instanceof Element
          ? e.target.closest<HTMLElement>('[data-toast-id]')?.dataset.toastId
          : undefined;
      const id = inOne != null ? Number(inOne) : newestToast();
      if (id == null) return;
      e.preventDefault();
      hideToast(id);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  if (toasts.length === 0) return null;
  // Too little room over a tall sheet: at the top of the screen instead
  const atTop = clearance > 0 && clearance > height - ROOM_PX;
  const place: React.CSSProperties = atTop
    ? { top: GAP_PX, bottom: 'auto' }
    : clearance > 0
      ? { bottom: `${clearance + GAP_PX}px` }
      : {};

  return (
    <div
      className={classes.stack}
      data-at={atTop ? 'top' : 'bottom'}
      style={place}
    >
      {toasts.map((toast) => (
        <ToastCard
          key={toast.id}
          toast={toast}
        />
      ))}
    </div>
  );
}

function ToastCard({ toast }: { toast: Toast }) {
  const card = useRef<HTMLDivElement>(null);
  // The finger (or pointer) dragging the message: where it started, which way it goes
  const drag = useRef<{
    pointer: number;
    x: number;
    y: number;
    at: number;
    axis: 'x' | 'y' | null;
  } | null>(null);
  // Set once a press became a swipe, so its release isn't also a press of Undo; only until
  // that release's click has gone by, so a key pressed later on Undo still works
  const swiped = useRef(false);
  const afterSwipe = () => window.setTimeout(() => (swiped.current = false), 0);

  const draw = (transform: string, opacity: number, ms: number) => {
    const el = card.current;
    if (el == null) return;
    el.style.transition = ms > 0 ? `transform ${ms}ms ease-out, opacity ${ms}ms ease-out` : '';
    el.style.transform = transform;
    el.style.opacity = opacity === 1 ? '' : String(opacity);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    drag.current = { pointer: e.pointerId, x: e.clientX, y: e.clientY, at: Date.now(), axis: null };
    swiped.current = false;
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const now = drag.current;
    if (now == null || now.pointer !== e.pointerId) return;
    const dx = e.clientX - now.x;
    const dy = e.clientY - now.y;
    if (now.axis == null) {
      if (Math.abs(dx) < SLOP_PX && Math.abs(dy) < SLOP_PX) return;
      if (Math.abs(dx) >= Math.abs(dy)) now.axis = 'x';
      else if (dy > 0) now.axis = 'y';
      else {
        // Up isn't a way to put it away
        drag.current = null;
        return;
      }
      swiped.current = true;
      // The rest of the swipe is the message's, wherever the finger goes
      card.current?.setPointerCapture?.(e.pointerId);
      holdToast(toast.id, 'swipe', true);
    }
    if (now.axis === 'x') draw(`translateX(${dx}px)`, 1 - Math.min(0.6, Math.abs(dx) / 300), 0);
    else draw(`translateY(${Math.max(0, dy)}px)`, 1 - Math.min(0.6, Math.max(0, dy) / 150), 0);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const now = drag.current;
    drag.current = null;
    if (now == null || now.pointer !== e.pointerId || now.axis == null) return;
    afterSwipe();
    const dx = e.clientX - now.x;
    const dy = e.clientY - now.y;
    const width = card.current?.offsetWidth ?? 0;
    const far = now.axis === 'x' ? Math.abs(dx) : Math.max(0, dy);
    const needed = now.axis === 'x' ? Math.max(SIDEWAYS_PX, width * 0.3) : DOWN_PX;
    const speed = far / Math.max(1, Date.now() - now.at);
    if (far >= needed || (far >= FLICK_PX && speed >= FLICK_SPEED)) {
      if (reducedMotion()) {
        hideToast(toast.id);
        return;
      }
      const off =
        now.axis === 'x'
          ? `translateX(${Math.sign(dx) * (width + window.innerWidth)}px)`
          : `translateY(${(card.current?.offsetHeight ?? 0) + 120}px)`;
      draw(off, 0, FLY_MS);
      window.setTimeout(() => hideToast(toast.id), FLY_MS);
    } else {
      draw('', 1, reducedMotion() ? 0 : FLY_MS);
      holdToast(toast.id, 'swipe', false);
    }
  };

  const onPointerCancel = () => {
    if (drag.current?.axis != null) {
      draw('', 1, reducedMotion() ? 0 : FLY_MS);
      holdToast(toast.id, 'swipe', false);
      afterSwipe();
    }
    drag.current = null;
  };

  return (
    <div
      ref={card}
      // A quiet note (saved) waits its turn to be read out; anything else is read at once
      role={toast.polite ? 'status' : 'alert'}
      className={classes.toast}
      data-tone={toast.tone}
      data-toast-id={toast.id}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={(e) => {
        if (!swiped.current) return;
        // The release of a swipe started on Undo doesn't press it
        swiped.current = false;
        e.preventDefault();
        e.stopPropagation();
      }}
      // Its seconds stop while the pointer is over it or the keyboard in it
      onPointerEnter={(e) => e.pointerType === 'mouse' && holdToast(toast.id, 'hover', true)}
      onPointerLeave={(e) => e.pointerType === 'mouse' && holdToast(toast.id, 'hover', false)}
      onFocus={() => holdToast(toast.id, 'focus', true)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget)) holdToast(toast.id, 'focus', false);
      }}
      onKeyDown={() => (swiped.current = false)}
    >
      {toast.tone !== 'plain' && (
        <AlertIcon
          size={18}
          aria-hidden
          className={classes.icon}
        />
      )}
      <span className={classes.message}>{toast.message}</span>
      {toast.action != null && (
        <button
          type="button"
          className={classes.action}
          onClick={toast.action.run}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className={classes.dismiss}
        aria-label="Dismiss"
        onClick={() => hideToast(toast.id)}
      >
        <CloseIcon
          size={16}
          aria-hidden
        />
      </button>
    </div>
  );
}
