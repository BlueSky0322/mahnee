import { useEffect, useLayoutEffect, useRef } from 'react';
import { takeComingBack } from './useRoute';

// Where each page was left on the screen. The window scrolls for every page, so without
// this a page opened over another would open at the other's depth. A page opens at the
// top, unless the person is coming back to it (its place's tab, Back or Forward, going up
// to it), when it opens where they left it. What changes within a page (Activity's
// filters, Home's month) leaves it where it is.

/** How long a page coming back is held to its place while what's on it is still drawn */
const SETTLE_MS = 1500;

/** How far down each page was left, by the page's name, while the app is drawn */
const kept = new Map<string, number>();

/** What the person does to move the page themselves, which a page settling never fights */
const OWN_MOVES = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

/**
 * Keeps `page`'s place: `page` names the page as the person sees it (two addresses that
 * draw the same page share one), and `shown` changes with every address shown
 */
export function useKeepScroll(page: string, shown: unknown) {
  const current = useRef(page);

  // The app puts pages where they belong, not the browser
  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    // The app drawn afresh (signed in again, say) starts every page at the top
    kept.clear();
    const follow = () => kept.set(current.current, window.scrollY);
    window.addEventListener('scroll', follow, { passive: true });
    return () => window.removeEventListener('scroll', follow);
  }, []);

  useLayoutEffect(() => {
    const back = takeComingBack();
    if (current.current === page) return;
    current.current = page;
    const to = back ? kept.get(page) ?? 0 : 0;
    window.scrollTo(0, to);
    if (to === 0) return;
    // What the page holds may still be drawing: it's put back each frame until it can be
    // that far down, for a moment, or until the person moves it themselves
    const until = Date.now() + SETTLE_MS;
    let frame = 0;
    const stop = () => {
      cancelAnimationFrame(frame);
      OWN_MOVES.forEach((e) => window.removeEventListener(e, stop));
    };
    const again = () => {
      if (Date.now() > until || Math.abs(window.scrollY - to) < 1) return stop();
      window.scrollTo(0, to);
      frame = requestAnimationFrame(again);
    };
    OWN_MOVES.forEach((e) => window.addEventListener(e, stop, { passive: true }));
    frame = requestAnimationFrame(again);
    return stop;
  }, [page, shown]);
}
