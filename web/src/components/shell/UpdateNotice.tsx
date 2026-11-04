import { Button, CloseButton } from '@mantine/core';
import { ArrowClockwise } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import classes from './UpdateNotice.module.css';
import { isOffline } from '../../offline/network';

// A new version of the app was deployed while this one is open: offer to reload. The
// page names its built script by content hash, so a different name on the server's
// copy of the page means a different version.

const CHECK_EVERY_MS = 15 * 60 * 1000;
/** Not every glance at the app needs a check */
const MIN_GAP_MS = 60 * 1000;

const runningScript = () =>
  document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')?.src ?? null;

async function latestScript(): Promise<string | null> {
  const res = await fetch('/', { cache: 'no-store', credentials: 'same-origin' });
  if (!res.ok || res.redirected) return null;
  const match = /<script[^>]+type="module"[^>]+src="(\/assets\/[^"]+\.js)"/.exec(await res.text());
  return match ? new URL(match[1], window.location.origin).href : null;
}

const UpdateNotice = () => {
  const [ready, setReady] = useState(false);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    const running = runningScript();
    // Development builds aren't versioned this way
    if (running == null) return;
    let last = 0;
    const check = () => {
      if (document.visibilityState !== 'visible' || isOffline()) return;
      if (Date.now() - last < MIN_GAP_MS) return;
      last = Date.now();
      latestScript()
        .then((latest) => {
          if (latest != null && latest !== running) setReady(true);
        })
        // Offline or signed out: try again later
        .catch(() => undefined);
    };
    const timer = setInterval(check, CHECK_EVERY_MS);
    document.addEventListener('visibilitychange', check);
    window.addEventListener('online', check);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('online', check);
    };
  }, []);

  if (!ready || dismissed) return null;
  return (
    <div
      className={classes.notice}
      role="status"
    >
      <span className={classes.text}>New version available</span>
      <Button
        size="compact-sm"
        leftSection={<ArrowClockwise size={14} />}
        onClick={() => window.location.reload()}
        className={classes.reload}
      >
        Reload
      </Button>
      <CloseButton
        size="sm"
        aria-label="Later"
        onClick={() => setDismissed(true)}
        className={classes.close}
      />
    </div>
  );
};

export default UpdateNotice;
