// A reminder encrypted to the one browser it is for (RFC 8291, "aes128gcm"), with WebCrypto
// alone: the Worker runs without Node's modules, so no web-push library. Only that
// browser can read it; the push service carrying it sees bytes. Each message gets a fresh
// key pair and salt, so no two are alike.

import { fromBase64Url, toBase64Url } from '../../shared/push';

/**
 * A push service takes at most 4096 bytes: the 86-byte header (salt, record size, the
 * server's key), the message, its one-byte delimiter and the 16-byte tag
 */
export const MAX_PUSH_TEXT = 4096 - 86 - 1 - 16;

const utf8 = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8),
  );
}

const mustRead = (text: string) => {
  const bytes = fromBase64Url(text);
  if (bytes == null) throw new Error('Not base64url');
  return bytes;
};

/** The browser's public key, refused unless it is a point on P-256 */
export const importBrowserKey = (p256dh: string) =>
  crypto.subtle.importKey(
    'raw',
    mustRead(p256dh),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

/** The server's key pair for one message: fresh, or the one given (RFC 8291's example) */
async function serverKeys(given?: { d: string; publicKey: string }) {
  if (given != null) {
    const raw = mustRead(given.publicKey);
    const privateKey = await crypto.subtle.importKey(
      'jwk',
      {
        kty: 'EC',
        crv: 'P-256',
        d: given.d,
        x: toBase64Url(raw.slice(1, 33)),
        y: toBase64Url(raw.slice(33, 65)),
      },
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits'],
    );
    return { privateKey, publicRaw: raw };
  }
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer,
  );
  return { privateKey: pair.privateKey, publicRaw };
}

/**
 * `text` encrypted to the browser whose keys these are, as one record: the body of the
 * push request. `fixed` gives the salt and server key, for checking against RFC 8291's
 * example; otherwise both are new each time.
 */
export async function encryptPush(
  text: string,
  to: { p256dh: string; auth: string },
  fixed?: { salt: Uint8Array; serverKey: { d: string; publicKey: string } },
): Promise<Uint8Array> {
  const plaintext = utf8.encode(text);
  if (plaintext.length > MAX_PUSH_TEXT) throw new Error('Push message too long');
  const browserRaw = mustRead(to.p256dh);
  const auth = mustRead(to.auth);
  const browser = await importBrowserKey(to.p256dh);
  const server = await serverKeys(fixed?.serverKey);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));

  // The other side's key, as WebCrypto names it (Workers' types call it $public)
  const ecdh = { name: 'ECDH', public: browser };
  const secret = new Uint8Array(await crypto.subtle.deriveBits(ecdh, server.privateKey, 256));
  const keyInfo = concat(utf8.encode('WebPush: info\0'), browserRaw, server.publicRaw);
  const ikm = await hkdf(auth, secret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8.encode('Content-Encoding: nonce\0'), 12);

  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  // The message and its delimiter (2: the last record), no padding
  const record = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv: nonce },
      key,
      concat(plaintext, new Uint8Array([2])),
    ),
  );
  // salt, record size (4096), the key's length and the key
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = server.publicRaw.length;
  return concat(header, server.publicRaw, record);
}
