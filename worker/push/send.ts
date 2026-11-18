// Hands one reminder to a device's push service: encrypted to the device, signed as the
// app, kept by the service for a few hours if the device is off. What the service answers
// says what becomes of the subscription.

import { encryptPush } from './encrypt';
import type { VapidKeys } from './vapid';
import { vapidAuthorization } from './vapid';

/** What the push service shows on the device */
export interface ReminderMessage {
  title: string;
  body: string;
  /** The app's own page a tap opens */
  url: string;
  /** One of a kind replaces the last on the device: daily, scheduled */
  tag: 'daily' | 'scheduled';
  /**
   * Which account it is for, as a tag worked out from the email (accountTag), so the
   * device shows it only while that account is signed in there
   */
  account: string;
}

/**
 * sent: taken; gone: the device let go of it (404, 410) or the subscription is bad (400),
 * so it goes too; denied: the service won't take it from this server (401, 403), which a
 * broken VAPID setup would cause for every device, so it is tried again later and goes only
 * once it keeps happening; broken: it couldn't be
 * encrypted to this device's keys, so it goes too; later: the service can't take it now
 * (no answer, 429, 5xx), so it is tried again after a while; refused: anything else (a
 * redirect, which is never followed), not tried again today
 */
export type Outcome = 'sent' | 'gone' | 'denied' | 'broken' | 'later' | 'refused';

/** How long a push service keeps a reminder for a device that is off: four hours */
const TTL_S = 4 * 60 * 60;
/** How long a push service gets to answer */
const TIMEOUT_MS = 5000;

/** What became of a message, with the push service's status when it answered */
export async function sendPush(
  to: { endpoint: string; p256dh: string; auth: string },
  message: ReminderMessage,
  keys: VapidKeys,
): Promise<{ outcome: Outcome; status: number | null }> {
  let body: Uint8Array;
  try {
    body = await encryptPush(JSON.stringify(message), to);
  } catch {
    return { outcome: 'broken', status: null };
  }
  let res: Response;
  try {
    res = await fetch(to.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': await vapidAuthorization(to.endpoint, keys, Date.now()),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': String(TTL_S),
        'Urgency': 'normal',
      },
      body,
      // A push service sending it elsewhere is a failure: the message never follows
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { outcome: 'later', status: null };
  }
  // Nothing in the answer is wanted
  await res.body?.cancel();
  const status = res.status;
  if (status >= 200 && status < 300) return { outcome: 'sent', status };
  if ([400, 404, 410].includes(status)) return { outcome: 'gone', status };
  if (status === 401 || status === 403) return { outcome: 'denied', status };
  if (status === 429 || status >= 500) return { outcome: 'later', status };
  return { outcome: 'refused', status };
}
