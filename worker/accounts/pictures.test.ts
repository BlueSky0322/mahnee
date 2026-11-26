import { jpeg } from '../test/picture-fixture';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { MAX_PICTURE_BYTES } from '../../shared/api';
import { fetchGooglePicture } from './pictures';

// Copying the Google picture a sign-in names, against Google's real host: only that host
// is ever asked, redirects aren't followed, a picture too large is cut off as it streams,
// and one that couldn't be had isn't asked for again on every start.

/** A database with no Google picture kept yet, noting each statement it's asked to make */
function emptyDb() {
  const prepared: string[] = [];
  const db = {
    prepare: (sql: string) => {
      prepared.push(sql);
      return { bind: () => ({ first: () => Promise.resolve(null) }) };
    },
  } as unknown as D1Database;
  return { db, prepared };
}

let n = 0;
/** A picture address of Google's own no other test has used */
const google = () => `https://lh3.googleusercontent.com/a/photo${++n}=s96-c`;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(new Response(jpeg(500), { status: 200 }))),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('copying the Google picture', () => {
  test("fetches one at Google's own host, at 256px, without following redirects", async () => {
    const { db } = emptyDb();
    const claim = google();
    expect(await fetchGooglePicture(db, 'me@example.com', claim)).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    const [address, init] = vi.mocked(fetch).mock.calls[0] as [string, RequestInit];
    expect(address).toBe(claim.replace('=s96-c', '=s256-c'));
    expect(init.redirect).toBe('manual');
  });

  test.each([
    ['a lookalike host', 'https://lh3.googleusercontent.com.evil.com/a/photo=s96-c'],
    ['a sign-in in the address', 'https://lh3.googleusercontent.com@evil.com/a/photo=s96-c'],
    ['a name and password', 'https://me:pw@lh3.googleusercontent.com/a/photo=s96-c'],
    ['another port', 'https://lh3.googleusercontent.com:8443/a/photo=s96-c'],
    ['plain http', 'http://lh3.googleusercontent.com/a/photo=s96-c'],
    ['another Google host', 'https://lh4.googleusercontent.com/a/photo=s96-c'],
    ['not an address', 'lh3.googleusercontent.com/a/photo'],
  ])('never asks anywhere else: %s', async (_what, claim) => {
    const { db } = emptyDb();
    expect(await fetchGooglePicture(db, 'me@example.com', claim)).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  test('takes nothing from a redirect', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { Location: 'https://evil.example/x.jpg' } }),
    );
    const { db, prepared } = emptyDb();
    expect(await fetchGooglePicture(db, 'me@example.com', google())).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(prepared.some((sql) => sql.includes('INSERT'))).toBe(false);
  });

  test('stops reading a picture once it passes the limit, whatever it says its size is', async () => {
    let sent = 0;
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += 16 * 1024;
        controller.enqueue(jpeg(16 * 1024));
      },
    });
    vi.mocked(fetch).mockResolvedValueOnce(new Response(endless, { status: 200 }));
    const { db } = emptyDb();
    expect(await fetchGooglePicture(db, 'me@example.com', google())).toBeNull();
    // Read no further than one piece past the limit
    expect(sent).toBeLessThanOrEqual(MAX_PICTURE_BYTES + 2 * 16 * 1024);
  });

  test("doesn't ask again for a while after it couldn't be had", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response('gone', { status: 404 }));
    const { db } = emptyDb();
    const claim = google();
    expect(await fetchGooglePicture(db, 'me@example.com', claim)).toBeNull();
    expect(await fetchGooglePicture(db, 'me@example.com', claim)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);

    // A while later it's tried again
    vi.useFakeTimers({ now: Date.now() + 61 * 60 * 1000, toFake: ['Date'] });
    try {
      expect(await fetchGooglePicture(db, 'me@example.com', claim)).not.toBeNull();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
