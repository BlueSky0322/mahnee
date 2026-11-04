import { installState, subscribeInstall } from '../pwa/install';
import { quietly } from '../utils/quietly';

// What this device keeps (saved copies, the app's own files) can be cleared by the
// browser when space runs low. Once the app is installed, it asks the browser to keep
// it. Browsers decide for themselves: Chrome and Edge answer without
// asking (more readily for an installed app), Firefox may ask the person, and a no is
// just how it was before. So it's asked once per device, and never relied on.

/** Asked already on this device, whatever the answer */
const ASKED_KEY = 'sf-storage-asked';

let asking = false;

async function askToKeepStorage() {
  if (asking || quietly(() => localStorage.getItem(ASKED_KEY)) === '1') return;
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (storage?.persist == null) return;
  asking = true;
  quietly(() => localStorage.setItem(ASKED_KEY, '1'));
  try {
    if (!(await storage.persisted())) await storage.persist();
  } catch {
    // Not answered: the device keeps things as it did before
  }
}

/** Call once at start-up, after trackInstall: asks when the app is or becomes installed */
export function keepStorageOnceInstalled() {
  const check = () => {
    if (installState().installed) void askToKeepStorage();
  };
  check();
  subscribeInstall(check);
}
