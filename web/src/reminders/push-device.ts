import { useCallback, useEffect, useState } from 'react';
import { fromBase64Url } from '@shared/push';
import { api } from '../api';
import { UserError } from '../utils/notify';
import { quietly } from '../utils/quietly';

// Whether this device gets reminders (owner decision D6), and the one way it starts to:
// the person taps Allow notifications, the browser asks them, and the device's push
// subscription is kept on the server for the account signed in. Nothing asks on its own.
// Signing out lets the device go, on the server and in the browser; a device last
// subscribed by another account is let go in the browser as soon as someone else is known
// to be signed in, so one account's reminders never come to another's device.

/**
 * How this device stands: it can't show notifications at all (unsupported), an iPhone
 * whose app isn't on the Home Screen (install), the person blocked them (blocked), not
 * asked or not subscribed (off), or subscribed for this account (on)
 */
export type DeviceState = 'checking' | 'unsupported' | 'install' | 'blocked' | 'off' | 'on';

/** Whose reminders this device was last subscribed for (an email), kept in localStorage */
export const PUSH_OWNER_KEY = 'mahnee:pushOwner';

/** How long signing out waits for the server to let the device go */
const LET_GO_WAIT_MS = 3000;

const owner = () => quietly(() => localStorage.getItem(PUSH_OWNER_KEY)) ?? null;
const setOwner = (email: string | null) =>
  quietly(() =>
    email == null
      ? localStorage.removeItem(PUSH_OWNER_KEY)
      : localStorage.setItem(PUSH_OWNER_KEY, email),
  );

/** Whether the browser has notifications and push at all */
const hasPush = () =>
  typeof Notification === 'function' &&
  typeof PushManager === 'function' &&
  typeof navigator !== 'undefined' &&
  'serviceWorker' in navigator;

/** iPhones and iPads give web push only to an app added to the Home Screen */
const isApple = () =>
  /iphone|ipad|ipod/i.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** The service worker's registration, which holds the push subscription; null without one */
async function registration() {
  if (typeof navigator === 'undefined' || !navigator.serviceWorker?.getRegistration) return null;
  return (await navigator.serviceWorker.getRegistration().catch(() => undefined)) ?? null;
}

const currentSubscription = async () =>
  (await (await registration())?.pushManager?.getSubscription().catch(() => null)) ?? null;

/** Remove reminders already visible on this device, even after its subscription expired. */
async function releaseReminders() {
  const reg = await registration();
  const shown = await reg?.getNotifications?.().catch(() => []);
  for (const reminder of shown ?? []) quietly(() => reminder.close());
  return (await reg?.pushManager?.getSubscription().catch(() => null)) ?? null;
}

/** The subscription as the server takes it */
const bodyOf = (sub: PushSubscription) => {
  const { endpoint, keys } = sub.toJSON();
  return {
    endpoint: endpoint ?? sub.endpoint,
    keys: { p256dh: keys?.p256dh ?? '', auth: keys?.auth ?? '' },
  };
};

/**
 * How this device stands for `email`. A subscription the browser already holds, kept for
 * someone else or not known to be this account's, is kept on the server for this account
 * again (the browser isn't asked anything).
 */
export async function readDeviceState(email: string): Promise<DeviceState> {
  if (!hasPush()) return isApple() ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  if (Notification.permission !== 'granted') return 'off';
  const sub = await currentSubscription();
  if (sub == null) return 'off';
  if (owner() === email) return 'on';
  try {
    await api.subscribePush(bodyOf(sub));
    setOwner(email);
    return 'on';
  } catch {
    return 'off';
  }
}

/**
 * Asks the browser for notifications (from the person's tap: the first thing done, as
 * iPhones need) and keeps this device's subscription for `email`. Answers how it stands
 * after; throws, with nothing subscribed, when the server won't keep it.
 */
export async function turnOnHere(email: string): Promise<DeviceState> {
  if (!hasPush()) return isApple() ? 'install' : 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission === 'denied') return 'blocked';
  if (permission !== 'granted') return 'off';
  const { publicKey } = await api.getPushKey();
  const key = publicKey == null ? null : fromBase64Url(publicKey);
  if (key == null) throw new UserError("Reminders aren't ready on the server yet.");
  const reg = await registration();
  if (reg == null) return 'unsupported';
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array(key),
    }));
  try {
    await api.subscribePush(bodyOf(sub));
  } catch (err) {
    // Not kept on the server: the browser lets it go too, so nothing is left half done
    await sub.unsubscribe().catch(() => false);
    setOwner(null);
    throw err;
  }
  setOwner(email);
  return 'on';
}

/**
 * Lets this device go, as signing out does: the server stops reminding it (waiting a
 * moment at most; offline, its push service says it's gone at the next reminder) and the
 * browser drops the subscription
 */
export async function letGoHere(email?: string | null): Promise<void> {
  setOwner(null);
  const sub = await releaseReminders();
  if (sub == null) return;
  await Promise.race([
    api.unsubscribePush(sub.endpoint, email).catch(() => undefined),
    new Promise((resolve) => setTimeout(resolve, LET_GO_WAIT_MS)),
  ]);
  await sub.unsubscribe().catch(() => false);
}

/**
 * Once the server says who's signed in: a device last subscribed for another account is
 * let go in the browser, so that account's reminders stop coming here (its push service
 * then tells the server it's gone)
 */
export async function releaseForOthers(email: string): Promise<void> {
  const was = owner();
  if (was == null || was === email) return;
  setOwner(null);
  const sub = await releaseReminders();
  await sub?.unsubscribe().catch(() => false);
}

/** How this device stands for `email`, and the tap that allows notifications */
export function useReminderDevice(email: string | null) {
  const [state, setState] = useState<DeviceState>('checking');
  useEffect(() => {
    if (email == null) return;
    let live = true;
    void readDeviceState(email).then((s) => {
      if (live) setState(s);
    });
    return () => {
      live = false;
    };
  }, [email]);
  const turnOn = useCallback(async () => {
    if (email == null) return;
    setState(await turnOnHere(email));
  }, [email]);
  return { state, turnOn };
}
