import { useCallback, useRef, useSyncExternalStore } from 'react';

// What is fixed at the foot of the screen (the tab bar, a phone's selection bar, a notice, a
// phone's sheet), measured as drawn, so the app's messages sit above it rather than over
// its buttons. Each bar puts `useBottomBar()` on its element; how far up the highest one
// reaches from the foot is `useBottomClearance()`. Measured again as a bar changes size,
// the window resizes or scrolls, the keyboard opens, and a sheet ends sliding in.

const bars = new Set<HTMLElement>();
const observed = new Map<HTMLElement, ResizeObserver>();
let clearance = 0;
let frame = 0;
const listeners = new Set<() => void>();

/** How far up from the foot of the screen the bars reach, in whole px */
function measure() {
  frame = 0;
  let reach = 0;
  for (const bar of bars) {
    if (!bar.isConnected) continue;
    const box = bar.getBoundingClientRect();
    // Hidden, or scrolled off the screen
    if (box.height <= 0 || box.top >= window.innerHeight) continue;
    reach = Math.max(reach, window.innerHeight - box.top);
  }
  const next = Math.ceil(reach);
  if (next === clearance) return;
  clearance = next;
  for (const listener of [...listeners]) listener();
}

/** Measures once the browser has drawn what changed */
function soon() {
  if (frame !== 0) return;
  frame =
    typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(measure)
      : (setTimeout(measure, 0) as unknown as number);
}

let listening = false;
function listen() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('resize', soon);
  window.addEventListener('scroll', soon, { capture: true, passive: true });
  // A sheet slides in, a notice fades in: their place is known once that ends
  document.addEventListener('transitionend', soon, true);
  document.addEventListener('animationend', soon, true);
  window.visualViewport?.addEventListener('resize', soon);
}

function add(bar: HTMLElement) {
  listen();
  bars.add(bar);
  if (typeof ResizeObserver === 'function') {
    const watch = new ResizeObserver(soon);
    watch.observe(bar);
    observed.set(bar, watch);
  }
  measure();
}

function remove(bar: HTMLElement) {
  bars.delete(bar);
  observed.get(bar)?.disconnect();
  observed.delete(bar);
  measure();
}

/** Put on what is fixed at the foot of the screen, so messages keep clear of it */
export function useBottomBar<T extends HTMLElement>() {
  const current = useRef<T | null>(null);
  return useCallback((el: T | null) => {
    if (current.current === el) return;
    if (current.current != null) remove(current.current);
    current.current = el;
    if (el != null) add(el);
  }, []);
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};

/** How far up from the foot of the screen the fixed bars reach, in px */
export const useBottomClearance = () =>
  useSyncExternalStore(
    subscribe,
    () => clearance,
    () => 0,
  );
