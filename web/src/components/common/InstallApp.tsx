import { Button, CloseButton } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { DotsThreeVertical, DownloadSimple, Export, PlusSquare } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useInstall } from '../../pwa/useInstall';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import classes from './InstallApp.module.css';
import { quietly } from '../../utils/quietly';

// Getting people to install Mahnee as an app: a card on the home page they can put
// off for a while

const DISMISSED_KEY = 'sf-install-dismissed';
/** "Not now" hides the card this long */
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;

const snoozed = () =>
  Date.now() - Number(quietly(() => localStorage.getItem(DISMISSED_KEY)) ?? 0) < SNOOZE_MS;

type Platform = 'ios' | 'android';

const STEPS: Record<Platform, { title: string; steps: { icon: ReactNode; text: ReactNode }[] }> = {
  // Safari on iPhone and iPad has no install button
  ios: {
    title: 'Add Mahnee to your Home Screen',
    steps: [
      {
        icon: <Export size={18} />,
        text: (
          <>
            Tap <strong>Share</strong> in Safari's toolbar
          </>
        ),
      },
      {
        icon: <PlusSquare size={18} />,
        text: (
          <>
            Choose <strong>Add to Home Screen</strong>
          </>
        ),
      },
    ],
  },
  // Before Chrome offers its own prompt (or in other Android browsers), the menu has it
  android: {
    title: 'Install Mahnee',
    steps: [
      {
        icon: (
          <DotsThreeVertical
            size={18}
            weight="bold"
          />
        ),
        text: (
          <>
            Tap the <strong>menu</strong> (⋮) at the top right of your browser
          </>
        ),
      },
      {
        icon: <DownloadSimple size={18} />,
        text: (
          <>
            Choose <strong>Install app</strong> or <strong>Add to Home screen</strong>
          </>
        ),
      },
    ],
  },
};

/** The steps to install by hand, with the browser's own icons */
function InstallSteps({ platform, onClose }: { platform: Platform | null; onClose: () => void }) {
  const shown = STEPS[platform ?? 'ios'];
  return (
    <ResponsiveDialog
      opened={platform != null}
      onClose={onClose}
      title={shown.title}
      width={400}
    >
      <ol className={classes.steps}>
        {shown.steps.map(({ icon, text }, ix) => (
          <li key={ix}>
            <span className={classes.stepIcon}>{icon}</span>
            <span>{text}</span>
          </li>
        ))}
        <li>
          <span className={classes.stepIcon}>
            <img
              src="/icon-192.png"
              alt=""
            />
          </span>
          <span>
            Tap <strong>{platform === 'android' ? 'Install' : 'Add'}</strong>, then open Mahnee from
            your home screen
          </span>
        </li>
      </ol>
    </ResponsiveDialog>
  );
}

/** Installs straight away where the browser can, else shows the iOS steps */
function useInstallAction() {
  const install = useInstall();
  const [steps, setSteps] = useState<Platform | null>(null);
  const run = async () => {
    if (install.canPrompt) {
      if (await install.prompt()) {
        notifications.show({ message: 'Installed. Open Mahnee from your home screen.' });
      }
    } else if (install.ios || install.android) {
      setSteps(install.ios ? 'ios' : 'android');
    }
  };
  const stepsDialog = (
    <InstallSteps
      platform={steps}
      onClose={() => setSteps(null)}
    />
  );
  return { install, run, stepsDialog };
}

/** On the home page, until it's installed or put off */
export function InstallCard() {
  const { install, run, stepsDialog: steps } = useInstallAction();
  const [hidden, setHidden] = useState(snoozed);
  if (!install.available || hidden) return steps;
  const dismiss = () => {
    // Without storage, hidden for this visit only
    quietly(() => localStorage.setItem(DISMISSED_KEY, String(Date.now())));
    setHidden(true);
  };
  return (
    <div
      className={classes.card}
      role="region"
      aria-label="Get the app"
    >
      <img
        src="/icon-192.png"
        alt=""
        className={classes.icon}
      />
      <div className="min-w-0 flex-1">
        <div className={classes.title}>Get the Mahnee app</div>
        <div className={classes.body}>
          Opens from your home screen, full screen, and opens offline too.
        </div>
        <div className={classes.actions}>
          <Button
            size="compact-md"
            leftSection={<DownloadSimple size={16} />}
            onClick={() => void run()}
          >
            {install.canPrompt ? 'Install' : 'How to install'}
          </Button>
          <Button
            variant="subtle"
            color="gray"
            size="compact-md"
            onClick={dismiss}
          >
            Not now
          </Button>
        </div>
      </div>
      <CloseButton
        size="sm"
        aria-label="Not now"
        onClick={dismiss}
        className={classes.close}
      />
      {steps}
    </div>
  );
}
