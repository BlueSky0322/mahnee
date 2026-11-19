// Reminders by web push (owner decision D6): what a device sends to subscribe, and what
// the Worker (the authority) and the test stand-in take. A subscription is the browser's
// own address at its push service and the keys a message is encrypted to.

/** What a device sends to get reminders: its PushSubscription, as toJSON() gives it */
export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

/** GET /api/push: the key a device subscribes with; null while the server has none */
export interface PushKey {
  publicKey: string | null;
}

/** The longest endpoint kept; push services' addresses are a few hundred characters */
export const MAX_PUSH_ENDPOINT = 2048;

/** The most devices an account gets reminders on; a new one past it drops the oldest */
export const MAX_PUSH_DEVICES = 10;

/**
 * The browsers' push services a reminder may be sent to: Chrome, Edge and Android's
 * (Firebase), Firefox's, Safari's and iPhones' (Apple), and Windows' (WNS, on hosts of its
 * own under notify.windows.com). Anything else is refused, so the Worker never sends to an
 * address a person typed.
 */
const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
];
const PUSH_HOST_ENDINGS = ['.notify.windows.com', '.push.apple.com'];

/**
 * An https address with a path: its host (letters, digits, dots and hyphens; no port, user
 * or trailing dot)
 */
const HTTPS_ADDRESS = /^https:\/\/([a-z0-9-]+(?:\.[a-z0-9-]+)+)\/\S+$/i;

/** A web address of any scheme, without spaces */
const ADDRESS = /^[a-z][a-z0-9+.-]*:\/\/\S+$/i;

/**
 * Whether `endpoint` is on a browser's push service: https, on one of their hosts, no port
 * or user. `standIn` is one more origin taken as a push service, for tests only.
 */
export function isPushService(endpoint: string, standIn?: string): boolean {
  if (standIn && endpoint.startsWith(`${standIn}/`)) return true;
  const host = HTTPS_ADDRESS.exec(endpoint)?.[1].toLowerCase();
  if (host == null) return false;
  return PUSH_HOSTS.includes(host) || PUSH_HOST_ENDINGS.some((end) => host.endsWith(end));
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** The bytes base64url text stands for, or null when it isn't base64url */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const bytes = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const c of text) {
    value = (value << 6) | ALPHABET.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[at++] = (value >> bits) & 0xff;
    }
  }
  return bytes;
}

export function toBase64Url(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b, c] = [bytes[i], bytes[i + 1] ?? 0, bytes[i + 2] ?? 0];
    const chunk = (a << 16) | (b << 8) | c;
    const chars = i + 1 >= bytes.length ? 2 : i + 2 >= bytes.length ? 3 : 4;
    for (let k = 0; k < chars; k++) text += ALPHABET[(chunk >> (18 - 6 * k)) & 63];
  }
  return text;
}

/**
 * A subscription as sent, checked for its shape: an endpoint that is a web address of at
 * most MAX_PUSH_ENDPOINT characters, a public key shaped as an uncompressed P-256 point (65
 * bytes, starting 4) and a 16-byte auth secret, and nothing else. Whether the endpoint is
 * a push service, and the key a point on the curve, the Worker checks too.
 */
export function readPushSubscription(raw: unknown): PushSubscriptionBody | { error: string } {
  const refused = { error: 'Invalid subscription' };
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return refused;
  const { endpoint, keys, ...rest } = raw as Record<string, unknown>;
  if (Object.keys(rest).length > 0) return refused;
  if (typeof endpoint !== 'string' || endpoint.length > MAX_PUSH_ENDPOINT) return refused;
  if (!ADDRESS.test(endpoint)) return refused;
  if (keys == null || typeof keys !== 'object' || Array.isArray(keys)) return refused;
  const { p256dh, auth, ...more } = keys as Record<string, unknown>;
  if (Object.keys(more).length > 0 || typeof p256dh !== 'string' || typeof auth !== 'string') {
    return refused;
  }
  const point = fromBase64Url(p256dh);
  const secret = fromBase64Url(auth);
  if (point?.length !== 65 || point[0] !== 4 || secret?.length !== 16) return refused;
  return { endpoint, keys: { p256dh, auth } };
}
