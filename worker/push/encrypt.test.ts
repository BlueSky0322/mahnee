import { describe, expect, it } from 'vitest';
import { MAX_PUSH_TEXT, encryptPush } from './encrypt';
import { VAPID_SUBJECT, vapidAuthorization } from './vapid';
import {
  decrypt,
  fromBase64Url,
  newBrowser,
  newVapidKeys,
  privateKeyOf,
  readVapid,
  toBase64Url,
} from '../test/push-receiver';

// A reminder reaches the phone encrypted to it (RFC 8291, aes128gcm): only the browser
// that subscribed can read it, not the push service carrying it. The server says who it is
// with a VAPID token (RFC 8292) signed by its private key. Both are WebCrypto alone, since
// the Worker runs without Node's modules.

// RFC 8291, section 5 and appendix A
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

describe('encrypting a message to one browser', () => {
  it("matches RFC 8291's example byte for byte, given its salt and server key", async () => {
    const body = await encryptPush(
      RFC.plaintext,
      { p256dh: RFC.uaPublic, auth: RFC.auth },
      { salt: fromBase64Url(RFC.salt), serverKey: { d: RFC.asPrivate, publicKey: RFC.asPublic } },
    );
    expect(toBase64Url(body)).toBe(RFC.body);
  });

  it("is read by the example's browser", async () => {
    const publicRaw = fromBase64Url(RFC.uaPublic);
    const text = await decrypt(fromBase64Url(RFC.body), {
      privateKey: await privateKeyOf(fromBase64Url(RFC.uaPrivate), publicRaw, 'ECDH'),
      publicRaw,
      auth: fromBase64Url(RFC.auth),
    });
    expect(text).toBe(RFC.plaintext);
  });

  it('uses a fresh salt and key each time, and only the browser it was for can read it', async () => {
    const browser = await newBrowser('https://fcm.googleapis.com/fcm/send/abc');
    const other = await newBrowser('https://fcm.googleapis.com/fcm/send/def');
    const message = '{"title":"TNB RM 189.00 is added tomorrow"}';
    const [one, two] = await Promise.all([
      encryptPush(message, browser.subscription.keys),
      encryptPush(message, browser.subscription.keys),
    ]);
    expect(toBase64Url(one)).not.toBe(toBase64Url(two));
    expect(await browser.read(one)).toBe(message);
    expect(await browser.read(two)).toBe(message);
    await expect(other.read(one)).rejects.toThrow();
  });

  it('fits one record a push service takes (4096 bytes), and refuses a longer message', async () => {
    const browser = await newBrowser('https://fcm.googleapis.com/fcm/send/abc');
    const longest = 'x'.repeat(MAX_PUSH_TEXT);
    const body = await encryptPush(longest, browser.subscription.keys);
    expect(body.length).toBe(4096);
    expect(await browser.read(body)).toBe(longest);
    await expect(encryptPush(`${longest}x`, browser.subscription.keys)).rejects.toThrow();
  });
});

describe("the server's VAPID token", () => {
  it('names the push service, the app as the sender, and runs out within a day', async () => {
    const keys = await newVapidKeys();
    const now = Date.UTC(2026, 10, 18, 13, 0);
    const header = await vapidAuthorization(
      'https://fcm.googleapis.com/fcm/send/abc:def',
      { publicKey: keys.publicKey, privateJwk: keys.privateJwk },
      now,
    );
    const claims = await readVapid(header, keys.publicKey);
    expect(claims).toEqual({
      aud: 'https://fcm.googleapis.com',
      sub: 'https://mahnee.shitty-app.workers.dev',
      exp: expect.any(Number),
    });
    expect(VAPID_SUBJECT).toBe('https://mahnee.shitty-app.workers.dev');
    expect(claims.exp * 1000).toBeGreaterThan(now);
    expect(claims.exp * 1000).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000);
  });

  it('is not taken as signed by another key', async () => {
    const [keys, other] = await Promise.all([newVapidKeys(), newVapidKeys()]);
    const header = await vapidAuthorization(
      'https://web.push.apple.com/abc',
      keys,
      Date.UTC(2026, 10, 18),
    );
    await expect(
      readVapid(header.replace(keys.publicKey, other.publicKey), other.publicKey),
    ).rejects.toThrow('not signed');
  });
});
