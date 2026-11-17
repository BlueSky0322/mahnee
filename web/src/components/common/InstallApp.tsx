import { DotsThreeVertical, DownloadSimple, Export, PlusSquare } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import ResponsiveDialog from '../ui/ResponsiveDialog';
import classes from './InstallApp.module.css';

// Installing Mahnee by hand, where the browser has no prompt of its own: the steps, with
// the browser's own icons (use-install-action.tsx offers them)

export type Platform = 'ios' | 'android';

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
export default function InstallSteps({
  platform,
  onClose,
}: {
  platform: Platform | null;
  onClose: () => void;
}) {
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
