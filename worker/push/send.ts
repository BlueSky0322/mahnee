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
  tag: string;
}

/**
 * sent: taken; gone: the device let go of it (404, 410), so the subscription goes too;
 * later: the service can't take it now (no answer, 429, 5xx), so it is tried again at the
 * next run; refused: anything else, not tried again today
 */
export type Outcome = 'sent' | 'gone' | 'later' | 'refused';

/** How long a push service keeps a reminder for a device that is off: four hours */
const TTL_S = 4 * 60 * 60;
/** How long a push service gets to answer */
const TIMEOUT_MS = 5000;

export async function sendPush(
  to: { endpoint: string; p256dh: string; auth: string },
  message: ReminderMessage,
  keys: VapidKeys,
): Promise<Outcome> {
  const body = await encryptPush(JSON.stringify(message), to);
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
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return 'later';
  }
  // Nothing in the answer is wanted
  await res.body?.cancel();
  if (res.ok) return 'sent';
  if (res.status === 404 || res.status === 410) return 'gone';
  if (res.status === 429 || res.status >= 500) return 'later';
  return 'refused';
}
