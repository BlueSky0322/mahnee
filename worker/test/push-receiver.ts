// A browser receiving web push, for tests: its own keys, given to the server as a
// subscription is, and what it makes of a message a push service hands it: the message
// decrypted as RFC 8291 says (aes128gcm), and the application server's VAPID token
// (RFC 8292) checked against its public key.

const utf8 = new TextEncoder();

/** Uint8Array copied onto an ArrayBuffer of their own, as WebCrypto's types take them */
const own = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => new Uint8Array(bytes);

export function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64Url(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'base64url'));
}

const concat = (...parts: Uint8Array[]): Uint8Array => new Uint8Array(Buffer.concat(parts));

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', own(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: own(info) },
      key,
      bytes * 8,
    ),
  );
}

/** A P-256 private key from its scalar and its public point (uncompressed, 65 bytes) */
export function privateKeyOf(
  d: Uint8Array,
  publicRaw: Uint8Array,
  algorithm: 'ECDH' | 'ECDSA',
): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'jwk',
    {
      kty: 'EC',
      crv: 'P-256',
      d: toBase64Url(d),
      x: toBase64Url(publicRaw.slice(1, 33)),
      y: toBase64Url(publicRaw.slice(33, 65)),
    },
    { name: algorithm, namedCurve: 'P-256' },
    false,
    algorithm === 'ECDH' ? ['deriveBits'] : ['sign'],
  );
}

/**
 * Reads a message as the browser does: the header's salt and the server's key, then the
 * one record, its padding and delimiter taken off. Throws if anything doesn't check out.
 */
export async function decrypt(
  body: Uint8Array,
  receiver: { privateKey: CryptoKey; publicRaw: Uint8Array; auth: Uint8Array },
): Promise<string> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset + 16, 4).getUint32(0);
  const idLength = body[20];
  const serverPublic = body.slice(21, 21 + idLength);
  const record = body.slice(21 + idLength);
  if (record.length > recordSize) throw new Error('More than one record');
  const sender = await crypto.subtle.importKey(
    'raw',
    serverPublic,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  // The other side's key, as WebCrypto names it (Workers' types call it $public)
  const ecdh = { name: 'ECDH', public: sender };
  const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, receiver.privateKey, 256));
  const keyInfo = concat(utf8.encode('WebPush: info\0'), receiver.publicRaw, serverPublic);
  const ikm = await hkdf(receiver.auth, secret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode('Content-Encoding: nonce\0'), 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const padded = new Uint8Array(
    await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, record),
  );
  let end = padded.length - 1;
  while (end >= 0 && padded[end] === 0) end--;
  if (padded[end] !== 2) throw new Error('No last-record delimiter');
  return new TextDecoder().decode(padded.slice(0, end));
}

/** A key pair as made, whichever runtime's types describe generateKey */
function pairOf(made: CryptoKey | CryptoKeyPair): CryptoKeyPair {
  if ('privateKey' in made) return made;
  throw new Error('Not a key pair');
}

/** A public key's raw bytes */
async function rawOf(key: CryptoKey): Promise<Uint8Array> {
  const raw: ArrayBuffer | JsonWebKey = await crypto.subtle.exportKey('raw', key);
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  throw new Error('Not raw');
}

/**
 * A browser's push subscription to `endpoint`: what the app sends the server, and how this
 * browser reads what comes for it
 */
export async function newBrowser(endpoint: string) {
  const pair = pairOf(
    await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']),
  );
  const publicRaw = await rawOf(pair.publicKey);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    subscription: {
      endpoint,
      keys: { p256dh: toBase64Url(publicRaw), auth: toBase64Url(auth) },
    },
    read: (body: Uint8Array) => decrypt(body, { privateKey: pair.privateKey, publicRaw, auth }),
  };
}

/** A VAPID key pair as the run keeps one: the public point, and the private key as a JWK */
export async function newVapidKeys() {
  const pair = pairOf(
    await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]),
  );
  return {
    publicKey: toBase64Url(await rawOf(pair.publicKey)),
    privateJwk: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)),
  };
}

/**
 * The claims of an `Authorization: vapid t=<token>, k=<key>` header, once its token is
 * signed by `publicKey` and names that key; throws otherwise
 */
export async function readVapid(
  authorization: string | undefined,
  publicKey: string,
): Promise<{ aud: string; sub: string; exp: number }> {
  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(authorization ?? '');
  if (m == null) throw new Error(`Not a VAPID header: ${authorization}`);
  const [, token, key] = m;
  if (key !== publicKey) throw new Error('Signed with another key');
  const [header, claims, signature] = token.split('.');
  const json = (part: string) =>
    JSON.parse(new TextDecoder().decode(fromBase64Url(part))) as Record<string, unknown>;
  if (JSON.stringify(json(header)) !== JSON.stringify({ typ: 'JWT', alg: 'ES256' })) {
    throw new Error(`Unexpected header ${JSON.stringify(json(header))}`);
  }
  const verifier = await crypto.subtle.importKey(
    'raw',
    own(fromBase64Url(publicKey)),
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify'],
  );
  const signed = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-256' },
    verifier,
    own(fromBase64Url(signature)),
    utf8.encode(`${header}.${claims}`),
  );
  if (!signed) throw new Error('The token is not signed by the key');
  return json(claims) as { aud: string; sub: string; exp: number };
}
