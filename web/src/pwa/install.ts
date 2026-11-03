import { quietly } from '../utils/quietly';
// Installing Mahnee as an app. Chrome, Edge and Android offer an install prompt the
// app can open (beforeinstallprompt); Safari on iPhone and iPad has none, so it's
// "Share, then Add to Home Screen". Nothing is offered once it's installed, or opened
// as the app.

interface InstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export interface InstallState {
  /** The browser's own install prompt can be opened */
  canPrompt: boolean;
  /** iPhone or iPad: installing is done by hand from the Share menu */
  ios: boolean;
  /**
   * Android: the browser's menu can always install it; Chrome's own prompt only comes
   * after a tap and some time on the page
   */
  android: boolean;
  /** Running as the installed app, or installed just now */
  installed: boolean;
}

let deferred: InstallPromptEvent | null = null;
let state: InstallState = { canPrompt: false, ios: false, android: false, installed: false };
const listeners = new Set<() => void>();

const set = (patch: Partial<InstallState>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
};

const INSTALLED_KEY = 'sf-installed';

/** Installed on this device before, though now open in a browser tab */
const installedBefore = () => quietly(() => localStorage.getItem(INSTALLED_KEY)) === '1';

const rememberInstalled = () => {
  // Forgotten next time if storage is unavailable; the browser stops offering it anyway
  quietly(() => localStorage.setItem(INSTALLED_KEY, '1'));
  set({ canPrompt: false, installed: true });
};

const standalone = () =>
  window.matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;

/** Call once at start-up: the browser's prompt is offered early and only once */
export function trackInstall() {
  const ua = navigator.userAgent;
  const ios =
    /iphone|ipad|ipod/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
  const android = /android/i.test(ua);
  state = { canPrompt: false, ios, android, installed: standalone() || installedBefore() };
  // Chrome on Android can tell, from a browser tab, that the app is already installed
  // (see related_applications in the manifest)
  const nav = navigator as Navigator & { getInstalledRelatedApps?: () => Promise<unknown[]> };
  nav
    .getInstalledRelatedApps?.()
    .then((apps) => {
      if (apps.length > 0) rememberInstalled();
    })
    // Some browsers can't say; then it's simply not known
    .catch(() => undefined);
  window.addEventListener('beforeinstallprompt', (e) => {
    // Shown from the app's own buttons instead of the browser's banner
    e.preventDefault();
    deferred = e as InstallPromptEvent;
    // Offered again: it was uninstalled since
    quietly(() => localStorage.removeItem(INSTALLED_KEY));
    set({ canPrompt: true, installed: standalone() });
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    rememberInstalled();
  });
}

export const subscribeInstall = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const installState = () => state;

/** Opens the browser's install prompt; true if they went ahead */
export async function promptInstall(): Promise<boolean> {
  if (deferred == null) return false;
  const event = deferred;
  deferred = null;
  set({ canPrompt: false });
  await event.prompt();
  const { outcome } = await event.userChoice;
  if (outcome === 'accepted') rememberInstalled();
  return outcome === 'accepted';
}
