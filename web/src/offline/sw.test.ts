// @vitest-environment jsdom
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { LedgerChange } from '@shared/api';
import { IMAGE_VIEWER_HEADER, MAX_CHANGES, MAX_CHANGES_BYTES, PICTURE_PATH } from '@shared/api';
import { clear, set } from 'idb-keyval';
import { ApiError, api } from '../api';
import type { Answer } from '../testing/sw';
import {
  appWindow,
  backgroundSync,
  clickNotification,
  fakeCaches,
  fetchThroughWorker,
  keptPaths,
  keptText,
  ok,
  pushToWorker,
  respond,
} from '../testing/sw';
import { IMAGE_CACHE_PREFIX, SW_USER_KEY, clearCache, setCacheUser } from './cache';
import type { Queued } from './outbox';
import {
  REFUSED_REASON,
  changesBody,
  classifySaveFailure,
  heldWith,
  refusalReason,
  nextBatch,
  readOutbox,
  writeOutbox,
} from './outbox';

// What the service worker (public/sw.js) does besides page loads, which shell.test.ts
// covers: web fonts are kept once fetched, the API is never answered from the device,
// and changes kept on the device are sent by background sync. It runs here as it would
// in the browser, with the server stood in for.

const FONT = 'https://fonts.gstatic.com/s/inter/v1/inter.woff2';

describe('the service worker, keeping web fonts', () => {
  test('keeps a font once fetched, and answers from the device after', async () => {
    const caches = fakeCaches();
    const font = { status: 200, body: 'font bytes', contentType: 'font/woff2' };
    const first = await fetchThroughWorker(FONT, font, caches);
    expect(first.fetch).toHaveBeenCalledTimes(1);
    expect(await first.response?.text()).toBe('font bytes');

    const offline = await fetchThroughWorker(FONT, { networkError: true }, caches);
    expect(offline.fetch).not.toHaveBeenCalled();
    expect(await offline.response?.text()).toBe('font bytes');
  });

  test('never keeps a failed answer', async () => {
    const caches = fakeCaches();
    await fetchThroughWorker(FONT, { status: 503, contentType: 'font/woff2' }, caches);
    expect(keptPaths(caches, 'mahnee-fonts-v1')).toEqual([]);
    const next = await fetchThroughWorker(
      FONT,
      { status: 200, body: 'font bytes', contentType: 'font/woff2' },
      caches,
    );
    expect(next.fetch).toHaveBeenCalledTimes(1);
    expect(await next.response?.text()).toBe('font bytes');
  });
});

describe('the service worker, with the API', () => {
  test('leaves every API request to the browser, so nothing an account holds is kept', async () => {
    const caches = fakeCaches();
    await expect(
      fetchThroughWorker(
        '/api/me',
        { status: 200, body: '{}', contentType: 'application/json' },
        caches,
      ),
    ).rejects.toThrow('left /api/me to the browser');
    expect(caches.stores.size).toBe(0);
  });
});

describe('the service worker, with the profile picture', () => {
  const PICTURE = `${PICTURE_PATH}?v=upload-1700000000000`;
  // The app's names for these, so sw.js's copies can't drift from them
  const IMAGES = IMAGE_CACHE_PREFIX;
  const pictureFor = (viewer: string, body = 'picture bytes') => ({
    status: 200,
    body,
    contentType: 'image/webp',
    headers: { [IMAGE_VIEWER_HEADER]: viewer },
  });
  const RYAN = 'ryan@example.com';

  beforeEach(async () => {
    await set(SW_USER_KEY, RYAN);
  });
  afterEach(() => clear());

  test('asks the server every time while online, and keeps a copy for whoever it was shown to', async () => {
    const caches = fakeCaches();
    await fetchThroughWorker(PICTURE, pictureFor(RYAN, 'first'), caches);
    expect(keptPaths(caches, `${IMAGES}${RYAN}`)).toEqual([PICTURE_PATH]);

    const next = await fetchThroughWorker(PICTURE, pictureFor(RYAN, 'fresh'), caches);
    expect(next.fetch).toHaveBeenCalledWith(expect.anything(), { cache: 'no-cache' });
    expect(await next.response?.text()).toBe('fresh');
  });

  test('offline, shows the signed-in account its own copy, and nobody else theirs', async () => {
    const caches = fakeCaches();
    await fetchThroughWorker(PICTURE, pictureFor(RYAN), caches);
    const offline = await fetchThroughWorker(PICTURE, { networkError: true }, caches);
    expect(await offline.response?.text()).toBe('picture bytes');

    // Someone else signs in on this browser: Ryan's picture isn't theirs to see
    await set(SW_USER_KEY, 'sam@example.com');
    expect((await fetchThroughWorker(PICTURE, { networkError: true }, caches)).response).toBeNull();
    // Nor while the server is failing
    const failing = await fetchThroughWorker(PICTURE, { status: 503 }, caches);
    expect(failing.response?.status).toBe(503);

    // And with nobody signed in, nobody's
    await clear();
    expect((await fetchThroughWorker(PICTURE, { networkError: true }, caches)).response).toBeNull();
  });

  test('shows the kept copy while the server is failing', async () => {
    const caches = fakeCaches();
    await fetchThroughWorker(PICTURE, pictureFor(RYAN), caches);
    const failing = await fetchThroughWorker(PICTURE, { status: 503 }, caches);
    expect(await failing.response?.text()).toBe('picture bytes');
  });

  test('forgets the copy once the server no longer shows it, and shows the refusal', async () => {
    const caches = fakeCaches();
    await fetchThroughWorker(PICTURE, pictureFor(RYAN), caches);
    const refused = await fetchThroughWorker(PICTURE, { status: 404, body: '{}' }, caches);
    expect(refused.response?.status).toBe(404);
    expect(keptPaths(caches, `${IMAGES}${RYAN}`)).toEqual([]);
    expect((await fetchThroughWorker(PICTURE, { networkError: true }, caches)).response).toBeNull();
  });

  test("a picture gone for the account signed in leaves another account's copy alone", async () => {
    const caches = fakeCaches();
    const SAM = 'sam@example.com';
    await fetchThroughWorker(PICTURE, pictureFor(RYAN, 'ryan'), caches);
    await set(SW_USER_KEY, SAM);
    await fetchThroughWorker(PICTURE, pictureFor(SAM, 'sam'), caches);
    // Sam goes back to the initial
    await fetchThroughWorker(PICTURE, { status: 404, body: '{}' }, caches);
    expect(keptPaths(caches, `${IMAGES}${SAM}`)).toEqual([]);
    expect(await keptText(caches, `${IMAGES}${RYAN}`, PICTURE_PATH)).toBe('ryan');
    // Ryan, back on this browser offline, still sees his
    await set(SW_USER_KEY, RYAN);
    const offline = await fetchThroughWorker(PICTURE, { networkError: true }, caches);
    expect(await offline.response?.text()).toBe('ryan');
  });

  test('never keeps a sign-in page sent in its place', async () => {
    const caches = fakeCaches();
    await fetchThroughWorker(PICTURE, pictureFor(RYAN), caches);
    const signIn = { status: 200, body: '<html>Sign in</html>', contentType: 'text/html' };
    const shown = await fetchThroughWorker(PICTURE, { ...signIn, redirected: true }, caches);
    expect(await shown.response?.text()).toBe('<html>Sign in</html>');
    expect(await keptText(caches, `${IMAGES}${RYAN}`, PICTURE_PATH)).toBe('picture bytes');
  });

  test('keeps nothing the server did not say whose it is', async () => {
    const caches = fakeCaches();
    await fetchThroughWorker(
      PICTURE,
      { status: 200, body: 'x', contentType: 'image/webp' },
      caches,
    );
    expect([...caches.stores.keys()].filter((name) => name.startsWith(IMAGES))).toEqual([]);
  });

  test('signing out forgets every kept picture', async () => {
    const caches = fakeCaches();
    vi.stubGlobal('caches', caches);
    await fetchThroughWorker(PICTURE, pictureFor(RYAN), caches);
    expect([...caches.stores.keys()]).toContain(`${IMAGES}${RYAN}`);
    await clearCache();
    expect([...caches.stores.keys()].filter((name) => name.startsWith(IMAGES))).toEqual([]);
    vi.unstubAllGlobals();
  });
});

// The service worker sends what the app kept while offline, when the browser says the
// connection is back and the app isn't open. It runs here as it would in the browser:
// against the same IndexedDB the app writes, with the server stood in for.
describe('the service worker, sending changes kept on the device', () => {
  const RYAN = 'ryan@example.com';
  const rename = (n: number): LedgerChange => ({
    op: 'updateAccount',
    id: 'a'.repeat(16),
    name: `Name ${n}`,
  });
  const queued = (count: number, from = 1): Queued[] =>
    Array.from({ length: count }, (_, i) => ({
      cid: (from + i).toString(16).padStart(16, '0'),
      change: rename(from + i),
    }));
  /** What Ryan has waiting, as the app reads it */
  const kept = () => readOutbox(RYAN);
  const transaction = (id: string, accountId: string, amountCents = 1000): LedgerChange => ({
    op: 'addTransaction',
    transaction: {
      id,
      kind: 'expense',
      accountId,
      toAccountId: null,
      amountCents,
      categoryId: 'f'.repeat(16),
      payee: null,
      note: null,
      date: '2026-11-20',
    },
  });

  beforeEach(() => setCacheUser(RYAN));
  afterEach(() => clearCache());

  test('sends the signed-in account’s changes, and crosses them off', async () => {
    await writeOutbox(RYAN, queued(2));
    const { outcome, batches } = await backgroundSync(ok);
    expect(outcome).toBe('done');
    expect(batches).toEqual([[rename(1), rename(2)]]);
    expect(await kept()).toEqual([]);
  });

  test('leaves another account’s changes alone', async () => {
    await setCacheUser('ann@example.com');
    await writeOutbox('ann@example.com', queued(1));
    // Ryan signs in on Ann's device
    await setCacheUser(RYAN);
    const { outcome, fetch } = await backgroundSync(ok);
    expect(outcome).toBe('done');
    expect(fetch).not.toHaveBeenCalled();
    await setCacheUser('ann@example.com');
    expect(await readOutbox('ann@example.com')).toEqual(queued(1));
  });

  test('sends a long queue in order, in requests the server takes', async () => {
    const all = queued(2 * MAX_CHANGES + 50);
    await writeOutbox(RYAN, all);
    const { outcome, batches } = await backgroundSync(ok);
    expect(outcome).toBe('done');
    expect(batches.map((b) => b.length)).toEqual([MAX_CHANGES, MAX_CHANGES, 50]);
    expect(batches.flat()).toEqual(all.map((q) => q.change));
    expect(await kept()).toEqual([]);
  });

  test('keeps what was not sent when a later request fails, and sends only that next time', async () => {
    const all = queued(MAX_CHANGES + 1);
    await writeOutbox(RYAN, all);
    const first = await backgroundSync([ok, { status: 503 }]);
    expect(first.outcome).toBe('try later');
    expect(first.batches.map((b) => b.length)).toEqual([MAX_CHANGES, 1]);
    // The first request's changes are crossed off; the last waits, as it was
    expect(await kept()).toEqual(all.slice(MAX_CHANGES));

    const second = await backgroundSync(ok);
    expect(second.batches).toEqual([[all[MAX_CHANGES].change]]);
    expect(await kept()).toEqual([]);
  });

  test('keeps a refused change with its reason, sends the rest, and never sends it again by itself', async () => {
    const edit = queued(1)[0];
    const expense: Queued = {
      cid: 'e'.repeat(16),
      change: transaction('9'.repeat(16), 'b'.repeat(16)),
    };
    await writeOutbox(RYAN, [edit, expense]);
    const server = (changes: LedgerChange[]): Answer =>
      changes.some((c) => c.op === 'updateAccount')
        ? { status: 404, body: '{"error":"Account not found"}' }
        : ok;
    const { outcome, batches } = await backgroundSync(server);
    expect(outcome).toBe('done');
    // Refused together, then each alone: the edit is refused, the expense saved
    expect(batches).toEqual([[edit.change, expense.change], [edit.change], [expense.change]]);
    expect(await kept()).toEqual([
      { ...edit, refused: { reason: 'Account not found', set: edit.cid } },
    ]);

    // Kept for the person to review in the app: not sent by itself again
    const again = await backgroundSync(server);
    expect(again.fetch).not.toHaveBeenCalled();
    expect(await kept()).toHaveLength(1);
  });

  test('holds what was made on a refused change, and the rest of its group, as the app does', async () => {
    const newAccount = 'c'.repeat(16);
    const all: Queued[] = [
      {
        cid: '1'.repeat(16),
        change: {
          op: 'addAccount',
          account: { id: newAccount, name: 'New', kind: 'bank', openingCents: 0 },
        },
      },
      { cid: '2'.repeat(16), change: transaction('2'.repeat(16), newAccount) },
      { cid: '3'.repeat(16), change: transaction('3'.repeat(16), 'b'.repeat(16)) },
      // An import, sent and held whole
      {
        cid: '4'.repeat(16),
        change: transaction('4'.repeat(16), 'b'.repeat(16)),
        group: '4'.repeat(16),
      },
      {
        cid: '5'.repeat(16),
        change: transaction('5'.repeat(16), 'b'.repeat(16), 0),
        group: '4'.repeat(16),
      },
      { cid: '6'.repeat(16), change: transaction('6'.repeat(16), 'a'.repeat(16)) },
    ];
    await writeOutbox(RYAN, all);
    const refused = (c: LedgerChange) =>
      c.op === 'addAccount' ||
      (c.op === 'addTransaction' &&
        (c.transaction.accountId === newAccount || c.transaction.amountCents === 0));
    const { outcome } = await backgroundSync((changes) =>
      changes.some(refused) ? { status: 400, body: '{"error":"No"}' } : ok,
    );
    expect(outcome).toBe('done');
    const left = await kept();
    expect(left.map((q) => q.cid)).toEqual(['1', '2', '4', '5'].map((c) => c.repeat(16)));
    expect(left.every((q) => q.refused?.reason === 'No')).toBe(true);
    // The same changes the app holds with each refused one
    const sets = new Map<string, string[]>();
    for (const q of left) sets.set(q.refused!.set, [...(sets.get(q.refused!.set) ?? []), q.cid]);
    for (const [set, cids] of sets) {
      expect([...heldWith(all, new Set([set]))]).toEqual(cids);
    }
  });

  test('holds later changes to the same thing as a refused one, as the app does', async () => {
    const T = 't'.repeat(16);
    const C = 'c'.repeat(16);
    const q = (n: number, change: LedgerChange): Queued => ({
      cid: n.toString(16).padStart(16, '0'),
      change,
    });
    const all: Queued[] = [
      q(1, { op: 'updateTransaction', id: T, categoryId: C, amountCents: 5000 }),
      q(2, { op: 'updateTransaction', id: T, amountCents: 8000 }),
      q(3, { op: 'removeTransactions', ids: ['x'.repeat(16), T] }),
      q(4, {
        op: 'setBudget',
        categoryId: C,
        fromMonth: '2026-11',
        amountCents: 100,
        carryOver: false,
      }),
      q(5, {
        op: 'setBudget',
        categoryId: C,
        fromMonth: '2026-12',
        amountCents: 200,
        carryOver: false,
      }),
      q(6, { op: 'updateAccount', id: 'a'.repeat(16), name: 'One' }),
      q(7, { op: 'updateAccount', id: 'a'.repeat(16), name: 'Two' }),
      q(8, { op: 'updateAccount', id: 'b'.repeat(16), name: 'Other' }),
    ];
    await writeOutbox(RYAN, all);
    const refused = (c: LedgerChange) =>
      (c.op === 'updateTransaction' && c.categoryId === C) ||
      (c.op === 'setBudget' && c.fromMonth === '2026-11') ||
      (c.op === 'updateAccount' && c.name === 'One');
    const { outcome, batches } = await backgroundSync((changes) =>
      changes.some(refused) ? { status: 409, body: '{"error":"No"}' } : ok,
    );
    expect(outcome).toBe('done');
    const left = await kept();
    expect(left.map((k) => parseInt(k.cid, 16))).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(batches.filter((b) => !b.some(refused))).toEqual([[all[7].change]]);
    const sets = new Map<string, string[]>();
    for (const k of left) sets.set(k.refused!.set, [...(sets.get(k.refused!.set) ?? []), k.cid]);
    for (const [set, cids] of sets) expect([...heldWith(all, new Set([set]))]).toEqual(cids);
  });

  test('a 403 page from in between holds nothing back, for everything to be sent later', async () => {
    await writeOutbox(RYAN, queued(3));
    const first = await backgroundSync({ status: 403, body: '<html>Forbidden</html>' });
    expect(first.outcome).toBe('try later');
    expect(await kept()).toEqual(queued(3));
    const later = await backgroundSync(ok);
    expect(later.batches).toEqual([queued(3).map((k) => k.change)]);
    expect(await kept()).toEqual([]);
  });

  test('keeps each request under the size the server takes, split where the app would', async () => {
    // About 1 KB each (longer than a name can be, so the server would refuse them; it's
    // the splitting that's checked), so the size, not the count, ends each request
    const all: Queued[] = queued(100).map((q, i) => ({
      ...q,
      change: { ...rename(i), name: `${i}`.padEnd(1000, 'x') },
    }));
    await writeOutbox(RYAN, all);
    const { outcome, fetch, batches } = await backgroundSync(ok);
    expect(outcome).toBe('done');
    expect(batches.length).toBeGreaterThan(1);
    expect(batches[0].length).toBeLessThan(MAX_CHANGES);
    for (const [, init] of fetch.mock.calls) {
      expect(new Blob([init.body as string]).size).toBeLessThanOrEqual(MAX_CHANGES_BYTES);
    }
    // The same requests the app makes, every change sent once and in order
    const app: number[] = [];
    for (let left = all; left.length > 0; left = left.slice(app[app.length - 1])) {
      app.push(nextBatch(left).length);
    }
    expect(batches.map((b) => b.length)).toEqual(app);
    expect(batches.flat()).toEqual(all.map((q) => q.change));
  });
});

// How the app and the service worker each read an answer to sending changes. They must
// agree, or one keeps a change the other drops.
const answers: [string, Answer, 'sent' | 'retry' | 'refused'][] = [
  ['saved', ok, 'sent'],
  ['a JSON null', { status: 200, body: 'null' }, 'retry'],
  ['broken JSON', { status: 200, body: '{"ok":' }, 'retry'],
  ['a web page from a proxy', { status: 200, body: '<html>Gateway</html>' }, 'retry'],
  ['a sign-in redirect', { status: 200, body: '<html>Sign in</html>', redirected: true }, 'retry'],
  ['no connection', { networkError: true }, 'retry'],
  ['401', { status: 401, body: '{"error":"Not signed in"}' }, 'retry'],
  ['429', { status: 429, body: '{"error":"Too many"}' }, 'retry'],
  [
    'amounts converting',
    { status: 503, body: '{"error":"Converting your amounts","code":"converting"}' },
    'retry',
  ],
  ['500', { status: 500, body: '{"error":"Oops"}' }, 'retry'],
  [
    '503, an app too old to say whose a change is',
    { status: 503, body: '{"error":"Update the app","code":"client_update_required"}' },
    'retry',
  ],
  [
    'made as another account',
    { status: 409, body: '{"error":"Signed in as someone else.","code":"account_mismatch"}' },
    'retry',
  ],
  // Answered by Cloudflare Access, a proxy or a deploy in between, not the app's server:
  // tried again, so nothing is held back for it
  ['403, a page from in between', { status: 403, body: '<html>Forbidden</html>' }, 'retry'],
  ['404, a page from in between', { status: 404, body: '<html>Not found</html>' }, 'retry'],
  ['400 with no reason', { status: 400, body: '{}' }, 'retry'],
  ['408', { status: 408, body: '{"error":"Took too long to send"}' }, 'retry'],
  ['413, a page from in between', { status: 413, body: '<html>Too large</html>' }, 'retry'],
  // The server's own: one change over the size it takes, held with why
  ['413', { status: 413, body: '{"error":"Too large"}' }, 'refused'],
  [
    '422, the rate lookup limit for one request',
    { status: 422, body: '{"error":"Save in smaller groups.","code":"rate_lookup_limit"}' },
    'refused',
  ],
  ['425', { status: 425, body: '{"error":"Too early"}' }, 'retry'],
  ['400', { status: 400, body: '{"error":"Invalid change"}' }, 'refused'],
  ['403', { status: 403, body: '{"error":"Not allowed"}' }, 'refused'],
  ['404', { status: 404, body: '{"error":"Account not found"}' }, 'refused'],
  ['409', { status: 409, body: '{"error":"That change was saved differently before"}' }, 'refused'],
];

describe('reading the answer to sending changes', () => {
  const RYAN = 'ryan@example.com';
  const one: Queued[] = [
    { cid: 'c'.repeat(16), change: { op: 'archiveAccount', id: 'a'.repeat(16), archived: true } },
  ];

  beforeEach(() => setCacheUser(RYAN));
  afterEach(async () => {
    vi.unstubAllGlobals();
    await clearCache();
  });

  test.each(answers)('the app: %s', async (_name, answer, expected) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => respond(answer)),
    );
    const outcome = await api.saveChanges(changesBody(one)).then(
      () => 'sent',
      (err: unknown) => classifySaveFailure(err),
    );
    expect(outcome).toBe(expected);
  });

  test.each(answers)('the service worker: %s', async (_name, answer, expected) => {
    await writeOutbox(RYAN, one);
    const { outcome } = await backgroundSync(answer);
    if (expected === 'retry') {
      expect(outcome).toBe('try later');
      expect(await readOutbox(RYAN)).toEqual(one);
    } else if (expected === 'sent') {
      expect(outcome).toBe('done');
      expect(await readOutbox(RYAN)).toEqual([]);
    } else {
      // Refused: kept with the server's reason for the person to review, not sent again
      expect(outcome).toBe('done');
      const reason = (JSON.parse((answer as { body: string }).body) as { error: string }).error;
      expect(await readOutbox(RYAN)).toEqual([{ ...one[0], refused: { reason, set: one[0].cid } }]);
    }
  });
});

describe('a refusal with an empty reason', () => {
  const RYAN = 'ryan@example.com';
  beforeEach(() => setCacheUser(RYAN));
  afterEach(() => clearCache());

  test('reads the same in the app and the service worker', async () => {
    const one: Queued[] = [
      { cid: 'c'.repeat(16), change: { op: 'undoImport', id: 'd'.repeat(16) } },
    ];
    await writeOutbox(RYAN, one);
    await backgroundSync({ status: 400, body: '{"error":""}' });
    expect(await readOutbox(RYAN)).toEqual([
      { ...one[0], refused: { reason: REFUSED_REASON, set: one[0].cid } },
    ]);
    expect(refusalReason(new ApiError(400, 'POST /api/changes failed', ''))).toBe(REFUSED_REASON);
  });
});

// Reminders (owner decision D6): the server's push message is shown as a notification, its
// text as sent (it names the item and amount, visible on a locked phone, as the owner
// chose), only while the account it is for is the one signed in here (it carries a tag
// worked out from the email, not the email), and tapping it opens the app where the
// message points, in a window already open when there is one. Only the app's own pages
// are ever opened.
describe('the service worker, with reminders', () => {
  const ORIGIN = 'https://mahnee.test';
  const RYAN = 'ryan@example.com';
  /** accountTag in worker/push/reminder-text.ts: SHA-256 of "mahnee-push:" and the email */
  const tag = (email: string) =>
    createHash('sha256').update(`mahnee-push:${email.toLowerCase()}`).digest('hex').slice(0, 16);
  const tnb = {
    title: 'TNB RM 189.00 is added tomorrow',
    body: 'From Scheduled. Tap to check it.',
    url: '/?plan=scheduled',
    tag: 'scheduled',
    account: tag(RYAN),
  };

  beforeEach(() => setCacheUser(RYAN));
  afterEach(() => clearCache());

  test('shows the message as sent, kept under its tag, to open where it points', async () => {
    expect(await pushToWorker(JSON.stringify(tnb))).toEqual([
      {
        title: 'TNB RM 189.00 is added tomorrow',
        options: {
          body: 'From Scheduled. Tap to check it.',
          tag: 'scheduled',
          icon: '/icon-192.png',
          badge: '/badge-96.png',
          data: { url: '/?plan=scheduled' },
        },
      },
    ]);
  });

  /**
   * What's shown in place of one that isn't for the account signed in here: something must
   * be, or the browser stops the subscription, so it says nothing of the reminder
   */
  const saysNothing = [
    {
      title: 'Mahnee',
      options: {
        body: 'Open Mahnee to see your reminder.',
        tag: 'reminder',
        icon: '/icon-192.png',
        badge: '/badge-96.png',
        data: { url: '/' },
      },
    },
  ];

  test('says nothing of a reminder for another account than the one signed in here', async () => {
    await setCacheUser('ann@example.com');
    expect(await pushToWorker(JSON.stringify(tnb))).toEqual(saysNothing);
  });

  test('says nothing of a reminder once no one is signed in here', async () => {
    await clearCache();
    expect(await pushToWorker(JSON.stringify(tnb))).toEqual(saysNothing);
  });

  test('says nothing of a reminder naming no account', async () => {
    const { account: _none, ...unnamed } = tnb;
    expect(await pushToWorker(JSON.stringify(unnamed))).toEqual(saysNothing);
  });

  test.each([
    ['no data', null],
    ['data that is not JSON', 'not json'],
    ['JSON without a title', '{"body":"x"}'],
  ])('still shows a notification for a message with %s, saying nothing', async (_name, text) => {
    expect(await pushToWorker(text)).toEqual([
      {
        title: 'Mahnee',
        options: {
          body: 'Open Mahnee to see your reminder.',
          tag: 'reminder',
          icon: '/icon-192.png',
          badge: '/badge-96.png',
          data: { url: '/' },
        },
      },
    ]);
  });

  test.each(['https://elsewhere.example/', '//elsewhere.example/x', 'javascript:alert(1)', 42])(
    'opens only its own pages: %s becomes Home',
    async (url) => {
      const [shown] = await pushToWorker(JSON.stringify({ ...tnb, url }));
      expect(shown.options.data).toEqual({ url: '/' });
    },
  );

  test('a tap brings an open window of the app to the page, and opens no other', async () => {
    const open = appWindow(`${ORIGIN}/?activity`);
    const { close, openWindow } = await clickNotification({ url: '/?plan=scheduled' }, [open]);
    expect(close).toHaveBeenCalled();
    expect(open.navigate).toHaveBeenCalledWith(`${ORIGIN}/?plan=scheduled`);
    expect(open.focus).toHaveBeenCalled();
    expect(openWindow).not.toHaveBeenCalled();
  });

  test('a tap uses the window in front, when several are open', async () => {
    const behind = appWindow(`${ORIGIN}/?activity`);
    const front = appWindow(`${ORIGIN}/?plan`, { focused: true });
    await clickNotification({ url: '/' }, [behind, front]);
    expect(front.navigate).toHaveBeenCalledWith(`${ORIGIN}/`);
    expect(behind.navigate).not.toHaveBeenCalled();
  });

  test('a window that can’t be brought to the page leaves a new one to open', async () => {
    const stuck = appWindow(`${ORIGIN}/?activity`, { navigates: false });
    const { openWindow } = await clickNotification({ url: '/?plan=scheduled' }, [stuck]);
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/?plan=scheduled`);
  });

  test('a tap with no window open opens the app at the page', async () => {
    const { close, openWindow } = await clickNotification({ url: '/' }, []);
    expect(close).toHaveBeenCalled();
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });

  test('a tap on a notification pointing elsewhere opens Home', async () => {
    const { openWindow } = await clickNotification({ url: 'https://elsewhere.example/' }, []);
    expect(openWindow).toHaveBeenCalledWith(`${ORIGIN}/`);
  });
});
