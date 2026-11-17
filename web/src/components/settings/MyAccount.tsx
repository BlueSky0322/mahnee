import { useThisMonth } from '../../ledger/month-start';
import { Button, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ForwardIcon } from '../ui/icons';
import { useState } from 'react';
import { MAX_DISPLAY_NAME } from '@shared/api';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useProfile } from '../../profile/ProfileContext';
import Freshness from '../common/Freshness';
import { useInstallAction } from '../common/use-install-action';
import { useYou } from '../common/you';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import Skeleton, { Loading } from '../ui/Skeleton';
import { useSettingInView } from './setting-in-view';
import { SectionHeader } from './SettingsPage';
import classes from './Settings.module.css';

// My account (R-Set-Account, R-Desk-Settings): who's signed in, with Change name; then this
// device, saying whether everything is saved ("Up to date", or what waits), and Install the
// app where the browser can
export default function MyAccount() {
  // The person's month (shared/period.ts)
  const month = useThisMonth();
  const you = useYou();
  const isDesktop = useIsDesktop();
  const [naming, setNaming] = useState(false);
  const { install, run, stepsDialog } = useInstallAction();
  useSettingInView();
  const device = isDesktop ? 'This computer' : 'This phone';

  const changeName = (
    <Button
      variant="default"
      size="xs"
      onClick={() => setNaming(true)}
    >
      Change name
    </Button>
  );

  return (
    <div className={classes.page}>
      <SectionHeader title="My account" />
      {you == null ? (
        <Loading
          label="Loading your profile"
          className={`${classes.card} ${classes.profile}`}
        >
          <Skeleton
            circle
            width={56}
            height={56}
          />
        </Loading>
      ) : isDesktop ? (
        <section
          className={`${classes.card} ${classes.profile}`}
          aria-labelledby="my-account-name"
          data-setting="name"
          tabIndex={-1}
        >
          <span
            className={`${classes.initial} ${classes.initialLarge}`}
            aria-hidden
          >
            {you.initial}
          </span>
          <div className={classes.rowText}>
            <h2
              id="my-account-name"
              className={classes.name}
            >
              {you.name}
            </h2>
            <div className={classes.detail}>{you.email}</div>
          </div>
          {changeName}
        </section>
      ) : (
        <section
          className={`${classes.card} ${classes.profileCentred}`}
          aria-label="Profile"
          data-setting="name"
          tabIndex={-1}
        >
          <span
            className={`${classes.initial} ${classes.initialLarge}`}
            aria-hidden
          >
            {you.initial}
          </span>
          <div className={classes.name}>{you.name}</div>
          <div className={classes.detail}>{you.email}</div>
          {changeName}
        </section>
      )}

      {!isDesktop && (
        <p
          className={classes.eyebrow}
          aria-hidden
        >
          {device}
        </p>
      )}
      <section
        className={classes.card}
        aria-label={device}
      >
        {isDesktop && <h2 className={classes.cardTitle}>{device}</h2>}
        <div className={classes.row}>
          <div className={classes.rowText}>
            <div className={classes.label}>Saved</div>
          </div>
          <Freshness month={month} />
        </div>
        {install.available &&
          (isDesktop ? (
            <div
              className={classes.row}
              data-setting="install"
              tabIndex={-1}
            >
              <div className={classes.rowText}>
                <div className={classes.label}>Install the app</div>
                <div className={classes.detail}>Opens offline</div>
              </div>
              <Button
                variant="default"
                size="xs"
                onClick={() => void run()}
              >
                Install
              </Button>
            </div>
          ) : (
            <button
              type="button"
              className={classes.row}
              data-setting="install"
              onClick={() => void run()}
            >
              <div className={classes.rowText}>
                <div className={classes.label}>Install the app</div>
                <div className={classes.detail}>Opens offline</div>
              </div>
              <ForwardIcon
                size={16}
                className={classes.caret}
                aria-hidden
              />
            </button>
          ))}
      </section>
      {stepsDialog}
      <ChangeName
        opened={naming}
        onClose={() => setNaming(false)}
      />
    </div>
  );
}

/** The name shown in Settings and the initial: empty goes back to the email's */
function ChangeName({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { profile, update } = useProfile();
  const [typed, setTyped] = useState<string | null>(null);
  const shown = typed ?? profile?.displayName ?? '';

  const close = () => {
    setTyped(null);
    onClose();
  };
  const save = () => {
    const name = shown.trim();
    close();
    // Shown at once; a refusal puts the name back and says so
    update({ displayName: name === '' ? null : name }).catch(() =>
      notifications.show({ color: 'red', message: "Couldn't save your name. Try again." }),
    );
  };

  return (
    <ResponsiveDialog
      opened={opened}
      onClose={close}
      title="Change name"
      width={400}
    >
      <form
        className={classes.dialogForm}
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <TextInput
          label="Name"
          value={shown}
          maxLength={MAX_DISPLAY_NAME}
          onChange={(e) => setTyped(e.currentTarget.value)}
          data-autofocus
        />
        <Button type="submit">Save</Button>
      </form>
    </ResponsiveDialog>
  );
}
