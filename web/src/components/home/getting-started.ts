// Whether Getting started was put away (Hide) on this device, for each account signed in

const hiddenKey = (email: string) => `getting-started-hidden:${email}`;

/** Whether this device was told to hide Getting started for this account */
export function isStartedHidden(email: string) {
  if (email === '') return false;
  try {
    return localStorage.getItem(hiddenKey(email)) === '1';
  } catch {
    return false;
  }
}

/** Hides Getting started on this device for this account; without storage, until reopened */
export function hideStarted(email: string) {
  // Never kept without an account to keep it for
  if (email === '') return;
  try {
    localStorage.setItem(hiddenKey(email), '1');
  } catch {
    // Nothing kept: it stays hidden until the app is opened again
  }
}
