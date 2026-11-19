// Who sends a reminder, as push services ask (VAPID, RFC 8292): a short token naming the
// push service and the app, signed with the server's private key (the VAPID_PRIVATE_KEY
// secret, a P-256 JWK), sent with the public key (VAPID_PUBLIC_KEY) that a device
// subscribed with. WebCrypto alone.

import { fromBase64Url, toBase64Url } from '../../shared/push';

/** Who the reminders are from: the app's own address, never an email */
export const VAPID_SUBJECT = 'https://mahnee.shitty-app.workers.dev';

/** How long a token is good for; push services take up to a day */
const TOKEN_LIFE_S = 12 * 60 * 60;

export interface VapidKeys {
  /** The public point, uncompressed, base64url */
  publicKey: string;
  /** The private key as a JWK, in JSON */
  privateJwk: string;
}

const utf8 = new TextEncoder();
const part = (value: unknown) => toBase64Url(utf8.encode(JSON.stringify(value)));

/**
 * The signing key, refused unless the JWK is a P-256 private key whose public half is
 * `publicKey`, so a token is never signed by a key the devices didn't subscribe with
 */
async function signingKey(keys: VapidKeys): Promise<CryptoKey> {
  const jwk = JSON.parse(keys.privateJwk) as JsonWebKey;
  const raw = fromBase64Url(keys.publicKey);
  if (
    jwk.kty !== 'EC' ||
    jwk.crv !== 'P-256' ||
    typeof jwk.d !== 'string' ||
    raw?.length !== 65 ||
    jwk.x !== toBase64Url(raw.slice(1, 33)) ||
    jwk.y !== toBase64Url(raw.slice(33, 65))
  ) {
    throw new Error('The VAPID keys are not a pair');
  }
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** The Authorization header for a message to `endpoint`, made at `now` (ms) */
export async function vapidAuthorization(
  endpoint: string,
  keys: VapidKeys,
  now: number,
): Promise<string> {
  const unsigned = `${part({ typ: 'JWT', alg: 'ES256' })}.${part({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + TOKEN_LIFE_S,
    sub: VAPID_SUBJECT,
  })}`;
  // WebCrypto signs as r and s side by side, as a JWT's ES256 wants
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    await signingKey(keys),
    utf8.encode(unsigned),
  );
  return `vapid t=${unsigned}.${toBase64Url(new Uint8Array(signature))}, k=${keys.publicKey}`;
}
