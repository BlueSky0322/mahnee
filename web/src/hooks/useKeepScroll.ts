import { useEffect, useLayoutEffect, useRef } from 'react';
import { quietly } from '../utils/quietly';
import { nameVisit, takeComingBack } from './useRoute';

// Where each page was left on the screen. The window scrolls for every page, so without
// this a page opened over another would open at the other's depth. A page opens at the
// top, unless the person is coming back to it (its place's tab, Back or Forward, going up
// to it), when it opens where they left it: on that visit (each place in the browser's
// history is one), else on the last visit to that page. What changes within a page
// (Activity's filters, Home's month) leaves it where it is. A reload opens where it was.

/** How long a page coming back is held to its place while what's on it is still drawn */
const SETTLE_MS = 1500;

/** Where each visit's pages were left, kept for this tab so a reload finds its own */
const KEPT_KEY = 'mahnee:scroll';

/** At most this many visits' places are kept */
const MAX_KEPT = 200;

/** How far down each page was left on its last visit, while the app is drawn */
const byPage = new Map<string, number>();

/** How far down each page was left on each visit, by `${visit}|${page}` */
let byVisit = new Map<string, number>();

/** What the person does to move the page themselves, which a page settling never fights */
const OWN_MOVES = ['wheel', 'touchstart', 'pointerdown', 'keydown'] as const;

const readKept = () =>
  new Map(
    Object.entries(
      (quietly(() => JSON.parse(sessionStorage.getItem(KEPT_KEY) ?? '{}') as unknown) ??
        {}) as Record<string, unknown>,
    ).filter((e): e is [string, number] => typeof e[1] === 'number'),
  );

const saveKept = () =>
  quietly(() =>
    sessionStorage.setItem(
      KEPT_KEY,
      JSON.stringify(Object.fromEntries([...byVisit].slice(-MAX_KEPT))),
    ),
  );

/**
 * Keeps `page`'s place: `page` names the page as the person sees it (two addresses that
 * draw the same page share one), and `shown` changes with every address shown
 */
export function useKeepScroll(page: string, shown: unknown) {
  const current = useRef<{ page: string; key: string } | null>(null);
  // While a page settles into its place, where it gets to on the way isn't kept
  const settling = useRef(false);
  const stopSettling = useRef<(() => void) | null>(null);

  // The app puts pages where they belong, not the browser
  useEffect(() => {
    if ('scrollRestoration' in window.history) window.history.scrollRestoration = 'manual';
    const follow = () => {
      const at = current.current;
      if (at == null || settling.current) return;
      byPage.set(at.page, window.scrollY);
      byVisit.delete(at.key);
      byVisit.set(at.key, window.scrollY);
    };
    const hidden = () => {
      if (document.visibilityState === 'hidden') saveKept();
    };
    window.addEventListener('scroll', follow, { passive: true });
    window.addEventListener('pagehide', saveKept);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      stopSettling.current?.();
      window.removeEventListener('scroll', follow);
      window.removeEventListener('pagehide', saveKept);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);

  useLayoutEffect(() => {
    const back = takeComingBack();
    const key = `${nameVisit()}|${page}`;
    const before = current.current;
    current.current = { page, key };
    let to: number;
    if (before == null) {
      // The app drawn afresh (signed in again, say) starts every page at the top, but a
      // reload of this tab opens where its page was
      byPage.clear();
      byVisit = readKept();
      to = byVisit.get(key) ?? 0;
      if (to === 0) return;
    } else {
      saveKept();
      // The same page on another visit (an earlier month) stays where it is
      if (before.page === page) return;
      to = back ? byVisit.get(key) ?? byPage.get(page) ?? 0 : 0;
    }
    stopSettling.current?.();
    settling.current = true;
    window.scrollTo(0, to);
    if (to === 0) {
      settling.current = false;
      return;
    }
    // What the page holds may still be drawing: it's put back until it can be that far
    // down, for a moment, or until the person moves it themselves
    const until = Date.now() + SETTLE_MS;
    let timer = 0;
    const stop = () => {
      settling.current = false;
      stopSettling.current = null;
      window.clearTimeout(timer);
      OWN_MOVES.forEach((e) => window.removeEventListener(e, stop));
    };
    stopSettling.current = stop;
    const again = () => {
      if (Date.now() > until || Math.abs(window.scrollY - to) < 1) return stop();
      window.scrollTo(0, to);
      timer = window.setTimeout(again, 16);
    };
    OWN_MOVES.forEach((e) => window.addEventListener(e, stop, { passive: true }));
    timer = window.setTimeout(again, 16);
  }, [page, shown]);
}
