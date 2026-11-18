import { useThisMonth } from '../../ledger/month-start';
import { Button, Text, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { ForwardIcon } from '../ui/icons';
import { useRef, useState } from 'react';
import { MAX_DISPLAY_NAME } from '@shared/api';
import { useIsDesktop } from '../../hooks/useBreakpoints';
import { useProfile } from '../../profile/ProfileContext';
import Freshness from '../common/Freshness';
import { useInstallAction } from '../common/use-install-action';
import YouPicture from '../common/YouPicture';
import { useYou } from '../common/you';
import { squarePicture } from '../../utils/picture';
import { showError } from '../../utils/notify';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import Skeleton, { Loading } from '../ui/Skeleton';
import { useSettingInView } from './setting-in-view';
import { SectionHeader } from './SettingsPage';
import classes from './Settings.module.css';

// My account (R-Set-Account, R-Desk-Settings): who's signed in, with Change name and their
// picture in the initial's place (tapping it changes it); then this
// device, saying whether everything is saved ("Up to date", or what waits), and Install the
// app where the browser can
export default function MyAccount() {
  // The person's month (shared/period.ts)
  const month = useThisMonth();
  const you = useYou();
  const isDesktop = useIsDesktop();
  const [naming, setNaming] = useState(false);
  const [picturing, setPicturing] = useState(false);
  const { install, run, stepsDialog } = useInstallAction();
  useSettingInView();
  const device = isDesktop ? 'This computer' : 'This phone';

  // The initial, or the picture in its place, opens Profile picture
  const pictureButton = you && (
    <button
      type="button"
      className={`${classes.initial} ${classes.initialLarge} ${classes.pictureButton}`}
      aria-label="Change picture"
      title="Change picture"
      onClick={() => setPicturing(true)}
    >
      <YouPicture
        initial={you.initial}
        picture={you.picture}
      />
    </button>
  );

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
          {pictureButton}
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
          {pictureButton}
          <div className={classes.who}>
            <div className={classes.name}>{you.name}</div>
            <div className={classes.detail}>{you.email}</div>
          </div>
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
      <ChangePicture
        opened={picturing}
        onClose={() => setPicturing(false)}
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

/**
 * Profile picture: choose a photo (cropped to the middle square and made small on this
 * device), or go back to the Google picture or the initial, whichever isn't showing
 */
function ChangePicture({ opened, onClose }: { opened: boolean; onClose: () => void }) {
  const { profile, changePicture } = useProfile();
  const you = useYou();
  const file = useRef<HTMLInputElement>(null);
  const [making, setMaking] = useState(false);
  const shown = profile?.picturePreview != null ? 'upload' : profile?.picture?.source ?? null;

  const choose = async (picked: File | undefined) => {
    if (picked == null) return;
    setMaking(true);
    try {
      const picture = await squarePicture(picked);
      onClose();
      // Shown at once; a refusal puts back what was there and says why
      await changePicture(picture);
    } catch (err) {
      showError(err, "Couldn't save your picture. Try again.");
    } finally {
      setMaking(false);
      if (file.current) file.current.value = '';
    }
  };
  const goBackTo = (choice: 'google' | 'initial') => {
    onClose();
    changePicture(choice).catch(() =>
      notifications.show({ color: 'red', message: "Couldn't change your picture. Try again." }),
    );
  };

  return (
    <ResponsiveDialog
      opened={opened}
      onClose={onClose}
      title="Profile picture"
      width={400}
    >
      <div className={classes.dialogForm}>
        {you != null && (
          <span
            className={`${classes.initial} ${classes.initialLarge} ${classes.pictureLarge}`}
            aria-hidden
          >
            <YouPicture
              initial={you.initial}
              picture={you.picture}
            />
          </span>
        )}
        <input
          ref={file}
          type="file"
          accept="image/*"
          aria-label="Photo to use"
          hidden
          onChange={(e) => void choose(e.currentTarget.files?.[0])}
        />
        <Button
          loading={making}
          onClick={() => file.current?.click()}
          data-autofocus
        >
          Choose a photo
        </Button>
        <Text
          size="sm"
          c="dimmed"
        >
          Cropped to a square and kept small.
        </Text>
        {profile?.googlePicture && shown !== 'google' && (
          <Button
            variant="default"
            onClick={() => goBackTo('google')}
          >
            Use Google picture
          </Button>
        )}
        {shown != null && (
          <Button
            variant="default"
            onClick={() => goBackTo('initial')}
          >
            Use initial
          </Button>
        )}
      </div>
    </ResponsiveDialog>
  );
}
