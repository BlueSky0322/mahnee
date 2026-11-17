import { Button } from '@mantine/core';
import { useNetwork } from '@mantine/hooks';
import { CloudSlash, SignIn } from '@phosphor-icons/react';
import { AlertIcon } from '../ui/icons';
import { useIsDesktop, useIsMobile } from '../../hooks/useBreakpoints';
import { useUnsaved } from '../../ledger/useLedger';
import { useKeepingWork } from '../../offline/storage-health';
import { signIn, useProfile } from '../../profile/ProfileContext';
import classes from './OfflineNotice.module.css';

/** What the device is called, by the screen's width as the layout goes */
const deviceWord = (mobile: boolean | undefined, desktop: boolean | undefined) =>
  mobile ? 'phone' : desktop ? 'computer' : 'device';

/** "1 change waiting", "3 changes waiting" */
const waitingText = (count: number) => `${count} ${count === 1 ? 'change' : 'changes'} waiting.`;

/**
 * Shown while there's no connection, so it's clear why nothing new is loading and that
 * changes are kept (how many wait is the freshness label's to say); while Cloudflare
 * Access wants them to sign in again, with the way to; or while this device can't keep
 * unsent changes, so they aren't lost by closing the app: a toast at the bottom of the page
 */
const OfflineNotice = () => {
  const { online } = useNetwork();
  const keeping = useKeepingWork();
  const { signInToSync } = useProfile();
  const { waiting, signedOut } = useUnsaved();
  const device = deviceWord(useIsMobile(), useIsDesktop());
  // Offline, signing in can't work yet: say so once the connection is back
  const toSignIn = (signInToSync || (signedOut && waiting > 0)) && online;
  if (online && keeping && !toSignIn) return null;

  let icon = <CloudSlash size={16} />;
  let text = `Offline. Your changes are kept on this ${device}.`;
  // Signed out or unable to keep changes, it says how many wait too
  let counted = false;
  if (toSignIn) {
    icon = <SignIn size={16} />;
    text =
      waiting > 0
        ? 'Signed out. Changes are kept on this device until you sign in.'
        : 'Signed out. Sign in again to see what has changed.';
    counted = true;
  } else if (!keeping) {
    icon = <AlertIcon size={16} />;
    text =
      "This device's storage is full or blocked. Keep the app open until your changes are saved.";
    counted = true;
  }
  return (
    <div
      className={classes.notice}
      role="status"
    >
      {icon}
      <span>
        {text}
        {counted && waiting > 0 && ` ${waitingText(waiting)}`}
      </span>
      {toSignIn && (
        <Button
          size="compact-sm"
          onClick={signIn}
          className={classes.action}
        >
          Sign in
        </Button>
      )}
    </div>
  );
};

export default OfflineNotice;
