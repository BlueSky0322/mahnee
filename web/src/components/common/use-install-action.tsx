import { notifications } from '@mantine/notifications';
import { useState } from 'react';
import { useInstall } from '../../pwa/useInstall';
import type { Platform } from './InstallApp';
import InstallSteps from './InstallApp';

// Installing Mahnee as an app, offered on Settings › My account: the browser's own prompt
// where it has one, else the steps to do it by hand

/**
 * Installs straight away where the browser can, else shows the steps to do it by hand:
 * `install.available` says whether there's anything to offer, `run` offers it, and
 * `stepsDialog` is drawn where it's used
 */
export function useInstallAction() {
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
