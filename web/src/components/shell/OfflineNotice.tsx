import { Button } from '@mantine/core';
import { useNetwork } from '@mantine/hooks';
import { CloudSlash, SignIn } from '@phosphor-icons/react';
import { useState } from 'react';
import { AlertIcon } from '../ui/icons';
import { useIsDesktop, useIsMobile } from '../../hooks/useBreakpoints';
import { keepChangesAgain } from '../../ledger/ledger';
import { useUnsaved } from '../../ledger/useLedger';
import { signIn, useProfile } from '../../profile/ProfileContext';
import { refusedText } from './describe-change';
import RefusedChanges from './RefusedChanges';
import classes from './OfflineNotice.module.css';

/** What the device is called, by the screen's width as the layout goes */
const deviceWord = (mobile: boolean | undefined, desktop: boolean | undefined) =>
  mobile ? 'phone' : desktop ? 'computer' : 'device';

/** "1 change waiting", "3 changes waiting" */
const waitingText = (count: number) => `${count} ${count === 1 ? 'change' : 'changes'} waiting.`;

/**
 * Shown while there's no connection, so it's clear why nothing new is loading and that
 * changes are kept (how many wait is the freshness label's to say); while Cloudflare
 * Access wants them to sign in again, with the way to; while this device couldn't keep
 * changes, so they aren't lost by closing the app, with Try again; or while the server
 * refused changes, with Review to try them again or discard them: a toast at the bottom
 * of the page
 */
const OfflineNotice = () => {
  const { online } = useNetwork();
  const { signInToSync } = useProfile();
  const { waiting, signedOut, unkept, refused } = useUnsaved();
  const [reviewing, setReviewing] = useState(false);
  const device = deviceWord(useIsMobile(), useIsDesktop());
  // Offline, signing in can't work yet: say so once the connection is back
  const toSignIn = (signInToSync || (signedOut && waiting > 0)) && online;
  const review = (
    <RefusedChanges
      opened={reviewing}
      onClose={() => setReviewing(false)}
    />
  );
  if (online && unkept === 0 && refused === 0 && !toSignIn) return review;

  let icon = <CloudSlash size={16} />;
  let text = `Offline. Your changes are kept on this ${device}.`;
  let action: { label: string; run: () => void } | null = null;
  // Signed out or unable to keep changes, it says how many wait too
  let counted = false;
  if (toSignIn) {
    icon = <SignIn size={16} />;
    text =
      waiting > 0
        ? 'Signed out. Changes are kept on this device until you sign in.'
        : 'Signed out. Sign in again to see what has changed.';
    counted = true;
    action = { label: 'Sign in', run: signIn };
  } else if (unkept > 0) {
    icon = <AlertIcon size={16} />;
    text = "Couldn't save on this device. Keep the app open until your changes are saved.";
    counted = true;
    action = { label: 'Try again', run: keepChangesAgain };
  } else if (refused > 0) {
    icon = <AlertIcon size={16} />;
    text = refusedText(refused);
    action = { label: 'Review', run: () => setReviewing(true) };
  }
  return (
    <>
      <div
        className={classes.notice}
        role="status"
      >
        {icon}
        <span>
          {text}
          {counted && waiting > 0 && ` ${waitingText(waiting)}`}
        </span>
        {action != null && (
          <Button
            size="compact-sm"
            onClick={action.run}
            className={classes.action}
          >
            {action.label}
          </Button>
        )}
      </div>
      {review}
    </>
  );
};

export default OfflineNotice;
