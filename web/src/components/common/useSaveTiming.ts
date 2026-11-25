import { useEffect, useState } from 'react';

// When the freshness label says "Saving" and "Saved". A save that lands within a moment
// never flashes "Saving"; one still going after it says so. Once changes were sent and the
// server took them, "Saved" shows for a couple of seconds, then "Up to date" again. Worked
// out once around every page (FreshnessProvider), so a label drawn on a page opened
// mid-save shows the same as the one it replaced.

/** How long a save goes before the label says "Saving" */
export const SAVING_AFTER_MS = 400;
/** How long "Saved" stays */
export const SAVED_FOR_MS = 2000;

export function useSaveTiming({
  sending,
  waiting,
  refused,
}: {
  /** Changes are on their way to a server that's answering */
  sending: boolean;
  /** Changes not yet saved */
  waiting: number;
  /** Changes the server refused, waiting for the person */
  refused: number;
}) {
  // Each stretch of sending, and each save landing, counted, so a timer only ever speaks
  // for the one it was started for
  const [was, setWas] = useState({ sending, refused, stretch: sending ? 1 : 0, saves: 0 });
  const [shownFor, setShownFor] = useState(0);
  const [savedFor, setSavedFor] = useState(0);
  let now = was;
  if (was.sending !== sending || was.refused !== refused) {
    const landed = was.sending && !sending && waiting === 0 && refused <= was.refused;
    now = {
      sending,
      refused,
      stretch: sending && !was.sending ? was.stretch + 1 : was.stretch,
      saves: landed ? was.saves + 1 : was.saves,
    };
    // Worked out while drawing, so "Saved" follows "Saving" with nothing in between
    setWas(now);
  }

  useEffect(() => {
    if (!sending) return;
    const timer = setTimeout(() => setShownFor(now.stretch), SAVING_AFTER_MS);
    return () => clearTimeout(timer);
  }, [sending, now.stretch]);

  useEffect(() => {
    if (now.saves === 0) return;
    const timer = setTimeout(() => setSavedFor(now.saves), SAVED_FOR_MS);
    return () => clearTimeout(timer);
  }, [now.saves]);

  return {
    savingShown: sending && shownFor === now.stretch,
    justSaved: now.saves > 0 && savedFor !== now.saves,
  };
}
