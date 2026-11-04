import { Button } from '@mantine/core';
import { useNetwork } from '@mantine/hooks';
import { CloudSlash, SignIn } from '@phosphor-icons/react';
import { signIn, useProfile } from '../../profile/ProfileContext';
import classes from './OfflineNotice.module.css';

/**
 * Shown while there's no connection, so it's clear why nothing new is loading, or while
 * Cloudflare Access wants them to sign in again, with the way to: a pill floating at the
 * bottom of the page
 */
const OfflineNotice = () => {
  const { online } = useNetwork();
  const { signInToSync } = useProfile();
  if (online && !signInToSync) return null;
  // Offline, signing in can't work yet: say so once the connection is back
  const toSignIn = signInToSync && online;
  return (
    <div
      className={classes.notice}
      role="status"
    >
      {toSignIn ? <SignIn size={16} /> : <CloudSlash size={16} />}
      {toSignIn
        ? 'Signed out. Sign in again to see what has changed.'
        : "Offline. You're seeing what this device last loaded."}
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
