// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { ChangesBody, LedgerChange, Transaction } from '@shared/api';
import { MAX_CHANGES, isRowId } from '@shared/api';
import { ApiError, NetworkError } from '../api';
import { clearCache, setCacheUser } from '../offline/cache';
import { get, set } from 'idb-keyval';
import { outboxKey, readOutbox } from '../offline/outbox';
import type { SaveQueue } from './save-queue';
import { createSaveQueue } from './save-queue';

// The save queue sends ledger changes in order and keeps each on the device until the
// server has it, so what the page holds can go (a reload, the app closing) without
// losing any. Here it runs against the device's real storage (fake-indexeddb), with the
// server stood in for.

const RYAN = 'ryan@example.com';
const rename = (name: string): LedgerChange => ({ op: 'updateAccount', id: 'a'.repeat(16), name });
const renames = (n: number) => Array.from({ length: n }, (_, i) => rename(`Name ${i}`));

/** A send that answers only when the test says, one request at a time */
function controlledSend() {
  const requests: { body: ChangesBody; answer: (err?: Error) => void }[] = [];
  const send = vi.fn(
    (body: ChangesBody) =>
      new Promise<unknown>((resolve, reject) =>
        requests.push({ body, answer: (err) => (err ? reject(err) : resolve({ ok: true })) }),
      ),
  );
  return { send, requests };
}

/** A queue for Ryan, with what it has kept on the device picked up */
async function openQueue(send: (body: ChangesBody) => Promise<unknown>) {
  const events = {
    send,
    saved: vi.fn(),
    found: vi.fn(),
    failed: vi.fn(),
    withdrawn: vi.fn(),
    idle: vi.fn(),
  };
  const queue = createSaveQueue(events);
  queues.push(queue);
  await queue.pickUp(RYAN);
  return { queue, events };
}
const queues: SaveQueue[] = [];

/** The changes Ryan has kept on this device */
const kept = async () => (await readOutbox(RYAN)).map((q) => q.change);

/** Answers each request with `answer`, recording what each carried */
function answering(answer: () => Promise<unknown>) {
  const sent: LedgerChange[][] = [];
  const send = vi.fn((body: ChangesBody) => {
    sent.push(body.changes);
    return answer();
  });
  return { send, sent };
}

beforeEach(() => setCacheUser(RYAN));
afterEach(async () => {
  queues.splice(0).forEach((q) => q.forget());
  vi.restoreAllMocks();
  await clearCache();
});

/** The clock the queue waits on, moved on by the test */
function controlTimers() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  onTestFinished(() => void vi.useRealTimers());
}
/** Moves the clock on, with time for what that sets going to reach the server */
async function moveOn(ms: number) {
  await vi.advanceTimersByTimeAsync(ms);
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
}

describe('the save queue', () => {
  test('sends one batch at a time, in order, with an id for each change', async () => {
    const { send, requests } = controlledSend();
    const { queue, events } = await openQueue(send);

    queue.add([rename('one')]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    queue.add([rename('two'), rename('three')]);
    // The first is on its way; the others wait for its answer, then go together
    await new Promise((r) => setTimeout(r, 20));
    expect(requests).toHaveLength(1);
    expect(requests[0].body.changes).toEqual([rename('one')]);
    expect(queue.pending()).toEqual([rename('one'), rename('two'), rename('three')]);

    requests[0].answer();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].body.changes).toEqual([rename('two'), rename('three')]);
    // With the id it was sent with
    expect(events.saved).toHaveBeenCalledWith([rename('one')], requests[0].body.ids);
    expect(queue.pending()).toEqual([rename('two'), rename('three')]);
    expect(events.idle).not.toHaveBeenCalled();

    requests[1].answer();
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalledTimes(1));
    expect(queue.pending()).toEqual([]);
    const ids = requests.flatMap((r) => r.body.ids);
    expect(ids.every(isRowId)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  test('keeps each change on the device until it is saved, crossing off each batch', async () => {
    const { send, requests } = controlledSend();
    const { queue } = await openQueue(send);
    const all = renames(MAX_CHANGES + 1);

    queue.add(all);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0].body.changes).toEqual(all.slice(0, MAX_CHANGES));
    // Kept while it's on its way
    expect(await kept()).toEqual(all);

    requests[0].answer();
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(await kept()).toEqual(all.slice(MAX_CHANGES));

    requests[1].answer();
    await vi.waitFor(async () => expect(await kept()).toEqual([]));
    expect(queue.state().waiting).toBe(0);
  });

  test('a refused change is kept for review, with its reason; the rest still go', async () => {
    const { send, requests } = controlledSend();
    const { queue, events } = await openQueue(send);
    // Another account's: a change to the same account would wait with it
    const other: LedgerChange = { op: 'updateAccount', id: 'b'.repeat(16), name: 'made after it' };

    queue.add([rename('refused')]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    queue.add([other]);
    const refusal = new ApiError(404, 'Account not found', 'Account not found');
    requests[0].answer(refusal);
    await vi.waitFor(() => expect(events.failed).toHaveBeenCalledWith(refusal));
    // Not shown as waiting any more, but kept on the device with why
    expect(queue.pending()).toEqual([other]);
    expect(queue.needsAttention()).toEqual([
      expect.objectContaining({ reason: 'Account not found', changes: [rename('refused')] }),
    ]);
    expect(queue.state()).toMatchObject({ waiting: 1, refused: 1 });

    // The one made after it is independent of it, so it's sent on its own
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].body.changes).toEqual([other]);
    requests[1].answer();
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalledTimes(1));
    expect(events.saved).toHaveBeenCalledWith([other], requests[1].body.ids);
    expect(await kept()).toEqual([rename('refused')]);
  });

  test('sends nothing more that was made before it was forgotten', async () => {
    const { send, requests } = controlledSend();
    const { queue, events } = await openQueue(send);

    queue.add([rename('sending')]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    queue.add([rename('waiting')]);
    queue.forget();
    requests[0].answer();
    await new Promise((r) => setTimeout(r, 20));
    expect(requests).toHaveLength(1);
    expect(events.saved).not.toHaveBeenCalled();
    expect(queue.pending()).toEqual([]);
  });

  test('a page opened again picks up what was kept, shows it, and sends it once', async () => {
    const before = await openQueue(() => Promise.reject(new NetworkError('No connection')));
    before.queue.add([rename('made before the reload')]);
    await vi.waitFor(async () => expect(await kept()).toEqual([rename('made before the reload')]));
    // The page goes; what it held in memory with it
    before.queue.forget();

    const { send, sent } = answering(() => Promise.resolve({ ok: true }));
    const { events } = await openQueue(send);
    expect(events.found).toHaveBeenCalledWith([rename('made before the reload')]);
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalled());
    expect(sent).toEqual([[rename('made before the reload')]]);
    expect(await kept()).toEqual([]);
  });

  test("never picks up, or sends, another person's changes kept here", async () => {
    const { queue } = await openQueue(() => Promise.reject(new ApiError(401, 'Not signed in')));
    queue.add([rename("Ryan's")]);
    await vi.waitFor(async () => expect(await kept()).toHaveLength(1));
    queue.forget();

    // Ann signs in on the same device
    await setCacheUser('ann@example.com');
    const { send, sent } = answering(() => Promise.resolve({ ok: true }));
    const events = {
      send,
      saved: vi.fn(),
      found: vi.fn(),
      failed: vi.fn(),
      withdrawn: vi.fn(),
      idle: vi.fn(),
    };
    const anns = createSaveQueue(events);
    queues.push(anns);
    await anns.pickUp('ann@example.com');
    expect(anns.pending()).toEqual([]);
    expect(events.found).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toEqual([]);

    // Kept for Ryan, as it was, for when he's back
    await setCacheUser(RYAN);
    expect(await kept()).toEqual([rename("Ryan's")]);
  });
});

describe('the save queue, when a send fails for want of a connection or the server', () => {
  test.each([
    ['no answer', new NetworkError('Failed to fetch')],
    ['busy', new ApiError(429, 'Too many')],
    ['failing', new ApiError(503, 'Down')],
  ])('%s: keeps it, and tries again after 3 seconds, doubling to a minute', async (_, err) => {
    controlTimers();
    const { send, sent } = answering(() => Promise.reject(err));
    const { queue, events } = await openQueue(send);
    queue.add([rename('kept')]);
    await moveOn(0);
    expect(sent).toHaveLength(1);

    for (const wait of [3, 6, 12, 24, 48, 60, 60].map((s) => s * 1000)) {
      await moveOn(wait - 1);
      const before = sent.length;
      await moveOn(1);
      expect(sent.length).toBe(before + 1);
    }
    expect(events.failed).not.toHaveBeenCalled();
    expect(await kept()).toEqual([rename('kept')]);
    expect(queue.state().waiting).toBe(1);
  });

  test.each([
    ['signed out', new ApiError(401, 'Not signed in'), true],
    [
      'made as another account',
      new ApiError(409, 'Signed in as someone else.', null, 'account_mismatch'),
      false,
    ],
  ])('%s: keeps it, and waits to be back rather than trying on a timer', async (_, err, out) => {
    controlTimers();
    let answer: Error | null = err;
    const { send, sent } = answering(() =>
      answer ? Promise.reject(answer) : Promise.resolve({ ok: true }),
    );
    const { queue } = await openQueue(send);
    queue.add([rename('kept')]);
    await moveOn(0);
    expect(sent).toHaveLength(1);
    expect(queue.state().signedOut).toBe(out);

    // Ten minutes on, nothing more was tried: each try would only fail until then
    await moveOn(10 * 60_000);
    expect(sent).toHaveLength(1);
    expect(await kept()).toEqual([rename('kept')]);

    // Signed in again (as the right account), and back to the app
    answer = null;
    queue.resume();
    await moveOn(0);
    expect(sent).toEqual([[rename('kept')], [rename('kept')]]);
    expect(await kept()).toEqual([]);
    expect(queue.state()).toEqual({ waiting: 0, signedOut: false, unkept: 0, refused: 0 });
  });

  test('offline: sends nothing until the connection is back', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { send, sent } = answering(() => Promise.resolve({ ok: true }));
    const { queue } = await openQueue(send);
    queue.add([rename('made offline')]);
    await vi.waitFor(async () => expect(await kept()).toEqual([rename('made offline')]));
    expect(sent).toEqual([]);
    expect(queue.state().waiting).toBe(1);

    onLine.mockReturnValue(true);
    queue.resume();
    await vi.waitFor(async () => expect(await kept()).toEqual([]));
    expect(sent).toEqual([[rename('made offline')]]);
  });
});

/**
 * A stand-in for the server: saves a request's changes all or none, each once by its id
 * (as receipts do), refusing a request with any change `refuses` gives a reason for
 */
function server(refuses: (change: LedgerChange) => string | null = () => null) {
  const saved = new Map<string, LedgerChange>();
  const send = vi.fn((body: ChangesBody) => {
    const why = body.changes.map(refuses).find((r) => r != null);
    if (why != null) return Promise.reject(new ApiError(404, why, why));
    body.ids.forEach((id, i) => {
      if (!saved.has(id)) saved.set(id, body.changes[i]);
    });
    return Promise.resolve({ ok: true });
  });
  /** Each change saved, once, in the order it was */
  const has = () => [...saved.values()];
  return { send, has, saved };
}

const ACCOUNT_A = 'a'.repeat(16);
const ACCOUNT_B = 'b'.repeat(16);
const NEW_ACCOUNT = 'c'.repeat(16);
const expense = (id: string, accountId: string, cents = 1000): LedgerChange => ({
  op: 'addTransaction',
  transaction: {
    id: id.repeat(16).slice(0, 16),
    kind: 'expense',
    accountId,
    toAccountId: null,
    amountCents: cents,
    categoryId: 'f'.repeat(16),
    payee: null,
    note: null,
    date: '2026-11-20',
  },
});
const editIn = (accountId: string): LedgerChange => ({
  op: 'updateAccount',
  id: accountId,
  name: 'Edited offline',
});
const offline = () => Promise.reject(new NetworkError('No connection'));
const unanswered = () => new Promise<unknown>(() => {});

/**
 * A page of the app opened afresh (a reload, another tab): its own copy of the app's code,
 * sharing only the device's storage, with Ryan's kept changes picked up
 */
async function openPage(send: (body: ChangesBody) => Promise<unknown>) {
  vi.resetModules();
  const cache = await import('../offline/cache');
  const { createSaveQueue: create } = await import('./save-queue');
  await cache.setCacheUser(RYAN);
  const events = {
    send,
    saved: vi.fn(),
    found: vi.fn(),
    failed: vi.fn(),
    withdrawn: vi.fn(),
    idle: vi.fn(),
  };
  const queue = create(events);
  queues.push(queue);
  await queue.pickUp(RYAN);
  return { queue, events };
}

describe('the save queue, when the page closes while a save is on its way', () => {
  test('a change made meanwhile is kept on the device at once, and each reaches the server once', async () => {
    // The first request reaches the server, which saves it, but its answer never comes
    // back before the page closes
    const online = server();
    let calls = 0;
    const slow = (body: ChangesBody) =>
      calls++ === 0 ? online.send(body).then(unanswered) : unanswered();
    const before = await openPage(slow);
    before.queue.add([expense('1', ACCOUNT_A, 200)]);
    await vi.waitFor(() => expect(online.send).toHaveBeenCalledTimes(1));
    before.queue.add([expense('2', ACCOUNT_A, 200)]);

    // Kept on the device while the first is still on its way, so closing now is safe
    await vi.waitFor(async () =>
      expect(await kept()).toEqual([expense('1', ACCOUNT_A, 200), expense('2', ACCOUNT_A, 200)]),
    );
    // The page closes; the request it was waiting on goes with it
    before.queue.forget();

    // Opened again: both go, and the server holds each once
    const after = await openPage(online.send);
    await vi.waitFor(() => expect(after.events.idle).toHaveBeenCalled());
    expect(online.has()).toEqual([expense('1', ACCOUNT_A, 200), expense('2', ACCOUNT_A, 200)]);
    expect(await kept()).toEqual([]);
  });
});

describe('the save queue, when the server refuses a change', () => {
  test('a refused edit stays recoverable through a restart; an expense in another account is saved once', async () => {
    const before = await openQueue(offline);
    before.queue.add([editIn(ACCOUNT_A)]);
    before.queue.add([expense('9', ACCOUNT_B)]);
    await vi.waitFor(async () => expect(await kept()).toHaveLength(2));
    before.queue.forget();

    // Back online, the server refuses the edit (the account is gone) and takes the expense
    const online = server((c) => (c.op === 'updateAccount' ? 'Account not found' : null));
    const second = await openQueue(online.send);
    await vi.waitFor(() => expect(second.events.idle).toHaveBeenCalled());
    expect(online.has()).toEqual([expense('9', ACCOUNT_B)]);
    second.queue.forget();

    // Restarted again: the edit is still there to review, with why, and isn't sent again
    const sent = online.send.mock.calls.length;
    const third = await openQueue(online.send);
    expect(third.queue.needsAttention()).toEqual([
      expect.objectContaining({ reason: 'Account not found', changes: [editIn(ACCOUNT_A)] }),
    ]);
    expect(third.queue.state()).toMatchObject({ waiting: 0, refused: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(online.send.mock.calls.length).toBe(sent);
    expect(online.has()).toEqual([expense('9', ACCOUNT_B)]);
    expect(await kept()).toEqual([editIn(ACCOUNT_A)]);
  });

  test('changes made on a refused one are held with it; independent ones are saved', async () => {
    const before = await openQueue(offline);
    const addAccount: LedgerChange = {
      op: 'addAccount',
      account: { id: NEW_ACCOUNT, name: 'Refused', kind: 'bank', openingCents: 0 },
    };
    before.queue.add([addAccount]);
    // An expense on the new account, and one on an account the server has
    before.queue.add([expense('1', NEW_ACCOUNT)]);
    before.queue.add([expense('2', ACCOUNT_B)]);
    await vi.waitFor(async () => expect(await kept()).toHaveLength(3));
    before.queue.forget();

    const online = server((c) =>
      c.op === 'addAccount'
        ? 'That account already exists'
        : c.op === 'addTransaction' && c.transaction.accountId === NEW_ACCOUNT
          ? 'Account not found'
          : null,
    );
    const { queue, events } = await openQueue(online.send);
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalled());
    expect(online.has()).toEqual([expense('2', ACCOUNT_B)]);
    // One thing to review: the account, with the expense made on it
    expect(queue.needsAttention()).toEqual([
      expect.objectContaining({
        reason: 'That account already exists',
        changes: [addAccount, expense('1', NEW_ACCOUNT)],
      }),
    ]);
    expect(queue.state()).toMatchObject({ waiting: 0, refused: 2 });
  });

  test('an import is held whole when one of its entries is refused', async () => {
    const before = await openQueue(offline);
    const imported: LedgerChange[] = [
      expense('1', ACCOUNT_A),
      expense('2', ACCOUNT_A, 0),
      expense('3', ACCOUNT_A),
    ];
    before.queue.add(imported);
    before.queue.add([expense('4', ACCOUNT_B)]);
    await vi.waitFor(async () => expect(await kept()).toHaveLength(4));
    before.queue.forget();

    const online = server((c) =>
      c.op === 'addTransaction' && c.transaction.amountCents === 0 ? 'Enter an amount' : null,
    );
    const { queue, events } = await openQueue(online.send);
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalled());
    expect(online.has()).toEqual([expense('4', ACCOUNT_B)]);
    expect(queue.needsAttention()).toEqual([
      expect.objectContaining({ reason: 'Enter an amount', changes: imported }),
    ]);
  });

  test('try again sends it; discard lets it go, from the device too', async () => {
    const before = await openQueue(offline);
    before.queue.add([editIn(ACCOUNT_A)]);
    before.queue.add([editIn(ACCOUNT_B)]);
    await vi.waitFor(async () => expect(await kept()).toHaveLength(2));
    before.queue.forget();

    let refusing = true;
    const online = server((c) => (refusing && c.op === 'updateAccount' ? 'Busy elsewhere' : null));
    const { queue, events } = await openQueue(online.send);
    await vi.waitFor(() => expect(queue.needsAttention()).toHaveLength(2));
    const [first, second] = queue.needsAttention();
    expect([first.changes, second.changes]).toEqual([[editIn(ACCOUNT_A)], [editIn(ACCOUNT_B)]]);

    refusing = false;
    await queue.retry(first.set);
    // Shown again while it's on its way
    expect(events.found).toHaveBeenLastCalledWith([editIn(ACCOUNT_A)]);
    await vi.waitFor(() => expect(online.has()).toEqual([editIn(ACCOUNT_A)]));
    await queue.discard(second.set);
    expect(queue.needsAttention()).toEqual([]);
    await vi.waitFor(async () => expect(await kept()).toEqual([]));
    expect(queue.state()).toMatchObject({ waiting: 0, refused: 0 });
    expect(online.has()).toEqual([editIn(ACCOUNT_A)]);
  });
});

describe("the save queue, when the device's storage fails", () => {
  test('a read that fails once is not taken for an empty outbox', async () => {
    const before = await openQueue(offline);
    before.queue.add([expense('1', ACCOUNT_A)]);
    await vi.waitFor(async () => expect(await kept()).toHaveLength(1));
    before.queue.forget();

    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const online = server();
    const { queue } = await openQueue(online.send);
    expect(queue.pending()).toEqual([expense('1', ACCOUNT_A)]);
    // The next read of the device fails, once
    const get = vi.spyOn(IDBObjectStore.prototype, 'get').mockImplementationOnce(() => {
      throw new DOMException('Unreadable', 'UnknownError');
    });
    queue.add([expense('2', ACCOUNT_A)]);
    queue.resume();
    await new Promise((r) => setTimeout(r, 20));
    get.mockRestore();
    if (queue.state().unkept > 0) queue.keepAgain();
    await vi.waitFor(async () =>
      expect(await kept()).toEqual([expense('1', ACCOUNT_A), expense('2', ACCOUNT_A)]),
    );
    expect(queue.state().unkept).toBe(0);

    onLine.mockRestore();
    queue.resume();
    await vi.waitFor(async () => expect(await kept()).toEqual([]));
    expect(online.has()).toEqual([expense('1', ACCOUNT_A), expense('2', ACCOUNT_A)]);
  });

  test('a change the device could not keep says so, and is kept once trying again works', async () => {
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const { queue } = await openQueue(offline);
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    queue.add([expense('1', ACCOUNT_A)]);
    await vi.waitFor(() => expect(queue.state()).toMatchObject({ waiting: 1, unkept: 1 }));
    expect(await kept()).toEqual([]);

    // Space is made, and they try again
    put.mockRestore();
    queue.keepAgain();
    await vi.waitFor(() => expect(queue.state()).toMatchObject({ waiting: 1, unkept: 0 }));
    expect(await kept()).toEqual([expense('1', ACCOUNT_A)]);
    onLine.mockRestore();
  });
});

describe('the save queue, in two tabs at once without Web Locks', () => {
  test('both tabs keep every change, and each reaches the server once', async () => {
    expect(navigator.locks).toBeUndefined();
    const onLine = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    const online = server();
    // One after the other, so each has its own copy of the app's code
    const opened = [(await openPage(online.send)).queue, (await openPage(online.send)).queue];
    const made = (tab: number, i: number) =>
      expense(`${tab}${i}`, tab === 0 ? ACCOUNT_A : ACCOUNT_B);
    for (let i = 0; i < 5; i++) {
      opened[0].add([made(0, i)]);
      opened[1].add([made(1, i)]);
    }
    const all = [0, 1, 2, 3, 4].flatMap((i) => [made(0, i), made(1, i)]);
    await vi.waitFor(async () => expect(new Set(await kept())).toEqual(new Set(all)));
    expect(await kept()).toHaveLength(10);

    onLine.mockRestore();
    opened.forEach((q) => q.resume());
    await vi.waitFor(async () => expect(await kept()).toEqual([]));
    expect(online.has()).toHaveLength(10);
    expect(new Set(online.has())).toEqual(new Set(all));
    // Each tab's own in the order it made them
    for (const tab of [0, 1]) {
      const own = online
        .has()
        .filter((c) => c.op === 'addTransaction' && c.transaction.id.startsWith(`${tab}`));
      expect(own).toEqual([0, 1, 2, 3, 4].map((i) => made(tab, i)));
    }
  });
});

describe('the save queue, with later changes to the same thing as a refused one', () => {
  test('an edit of the same entry waits for the refused one, so the newer one wins once tried again', async () => {
    const T = 't'.repeat(16);
    const C = 'c'.repeat(16);
    const older: LedgerChange = {
      op: 'updateTransaction',
      id: T,
      categoryId: C,
      amountCents: 5000,
    };
    const newer: LedgerChange = { op: 'updateTransaction', id: T, amountCents: 8000 };
    const before = await openQueue(offline);
    before.queue.add([older]);
    before.queue.add([newer]);
    await vi.waitFor(async () => expect(await kept()).toHaveLength(2));
    before.queue.forget();

    // The category was archived meanwhile; the server applies edits to the entry in turn
    let archived = true;
    let amount = 1000;
    const send = vi.fn((body: ChangesBody) => {
      if (
        archived &&
        body.changes.some((c) => c.op === 'updateTransaction' && c.categoryId === C)
      ) {
        const why = 'That category is archived';
        return Promise.reject(new ApiError(409, why, why));
      }
      for (const c of body.changes)
        if (c.op === 'updateTransaction') amount = c.amountCents ?? amount;
      return Promise.resolve({ ok: true });
    });
    const { queue, events } = await openQueue(send);
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalled());
    // The newer edit didn't overtake it: both wait together
    expect(amount).toBe(1000);
    expect(queue.needsAttention()).toEqual([
      expect.objectContaining({ reason: 'That category is archived', changes: [older, newer] }),
    ]);

    // Unarchived, and tried again: sent in the order they were made
    archived = false;
    await queue.retry(queue.needsAttention()[0].set);
    await vi.waitFor(async () => expect(await kept()).toEqual([]));
    expect(amount).toBe(8000);
  });
});

describe('the save queue, when something other than the server answers', () => {
  test('a 403 page from in between holds nothing back, and everything is sent later', async () => {
    controlTimers();
    let answer: Error | null = new ApiError(403, 'POST /api/changes failed', null);
    const sent: LedgerChange[][] = [];
    const send = vi.fn((body: ChangesBody) => {
      sent.push(body.changes);
      return answer ? Promise.reject(answer) : Promise.resolve({ ok: true });
    });
    const { queue, events } = await openQueue(send);
    queue.add([editIn(ACCOUNT_A)]);
    queue.add([expense('1', ACCOUNT_B)]);
    await moveOn(0);
    expect(sent.length).toBeGreaterThan(0);
    expect(events.failed).not.toHaveBeenCalled();
    expect(queue.needsAttention()).toEqual([]);
    expect(queue.state()).toMatchObject({ waiting: 2, refused: 0 });

    answer = null;
    await moveOn(3000);
    await vi.waitFor(async () => expect(await kept()).toEqual([]));
    expect(sent[sent.length - 1]).toEqual([editIn(ACCOUNT_A), expense('1', ACCOUNT_B)]);
  });
});

describe('the save queue, trying again or discarding while the device fails', () => {
  async function oneRefused() {
    const online = server((c) => (c.op === 'updateAccount' ? 'Account not found' : null));
    const { queue } = await openQueue(online.send);
    queue.add([editIn(ACCOUNT_A)]);
    await vi.waitFor(() => expect(queue.needsAttention()).toHaveLength(1));
    return { queue, online };
  }

  test('try again changes nothing until the device has it', async () => {
    const { queue, online } = await oneRefused();
    const sentBefore = online.send.mock.calls.length;
    const put = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    onTestFinished(() => put.mockRestore());
    await queue.retry(queue.needsAttention()[0].set);
    expect(queue.needsAttention()).toHaveLength(1);
    expect(queue.state()).toMatchObject({ waiting: 0, refused: 1 });
    expect(online.send.mock.calls.length).toBe(sentBefore);
  });

  test('discard changes nothing until the device has let it go', async () => {
    const { queue } = await oneRefused();
    const put = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(() => {
      throw new DOMException('Unwritable', 'UnknownError');
    });
    onTestFinished(() => put.mockRestore());
    await queue.discard(queue.needsAttention()[0].set);
    expect(queue.needsAttention()).toHaveLength(1);
    expect(await kept()).toEqual([editIn(ACCOUNT_A)]);
  });
});

describe('the save queue, with entries it does not know in the outbox', () => {
  test('keeps them, as written, when it writes the outbox', async () => {
    // From a newer build, say
    const unknown = { cid: 'u'.repeat(16), future: { op: 'somethingNew' } };
    await set(outboxKey(RYAN), { email: RYAN, value: [unknown] });
    const online = server();
    const { queue, events } = await openQueue(online.send);
    queue.add([expense('1', ACCOUNT_A)]);
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalled());
    expect(online.has()).toEqual([expense('1', ACCOUNT_A)]);
    expect(await get(outboxKey(RYAN))).toEqual({ email: RYAN, value: [unknown] });
  });
});

describe('the save queue, when the server says a change is too large or too slow', () => {
  test('one change over the size the server takes is held with why; the rest still go', async () => {
    const big = editIn(ACCOUNT_A);
    const online = server();
    const send = vi.fn((body: ChangesBody) =>
      body.changes.some((c) => c.op === 'updateAccount')
        ? Promise.reject(new ApiError(413, 'Too large', 'Too large'))
        : online.send(body),
    );
    const { queue, events } = await openQueue(send);
    queue.add([big]);
    queue.add([expense('1', ACCOUNT_B)]);
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalled());
    expect(online.has()).toEqual([expense('1', ACCOUNT_B)]);
    expect(queue.needsAttention()).toEqual([
      expect.objectContaining({ reason: 'Too large', changes: [big] }),
    ]);
  });

  test('a request that keeps taking too long keeps waiting, tried less often, never held', async () => {
    controlTimers();
    const slow = new ApiError(408, 'Took too long to send', 'Took too long to send');
    let answer: Error | null = slow;
    const sent: LedgerChange[][] = [];
    const send = vi.fn((body: ChangesBody) => {
      sent.push(body.changes);
      return answer ? Promise.reject(answer) : Promise.resolve({ ok: true });
    });
    const { queue, events } = await openQueue(send);
    queue.add([editIn(ACCOUNT_A)]);
    queue.add([expense('1', ACCOUNT_B)]);
    await moveOn(0);
    expect(sent).toHaveLength(1);
    for (const wait of [3, 6, 12, 24].map((s) => s * 1000)) {
      await moveOn(wait - 1);
      const before = sent.length;
      await moveOn(1);
      expect(sent.length).toBe(before + 1);
    }
    // Five in a row: still waiting, as on a slow connection, and tried every 5 minutes
    expect(queue.needsAttention()).toEqual([]);
    expect(events.failed).not.toHaveBeenCalled();
    expect(queue.state()).toMatchObject({ waiting: 2, refused: 0 });
    expect(sent.every((batch) => batch.length === 2)).toBe(true);
    await moveOn(5 * 60_000 - 1);
    expect(sent).toHaveLength(5);
    answer = null;
    await moveOn(1);
    await vi.waitFor(async () => expect(await kept()).toEqual([]));
    expect(sent).toHaveLength(6);
  });
});

describe('the save queue, with an import that changes the opening balance', () => {
  /** An import as Import sends it: recorded first, its entries, the opening change last */
  function importOf(count: number, bad: number): LedgerChange[] {
    const id = 'i'.repeat(16);
    const entry = (expense('0', ACCOUNT_A) as unknown as { transaction: Transaction }).transaction;
    return [
      {
        op: 'addImport',
        import: {
          id,
          fileName: 'bank.csv',
          accountId: ACCOUNT_A,
          addedCount: count,
          skippedCount: 0,
        },
      },
      ...Array.from(
        { length: count },
        (_, i): LedgerChange => ({
          op: 'addTransaction',
          importId: id,
          transaction: {
            ...entry,
            id: i.toString(16).padStart(16, '0'),
            amountCents: i === bad ? 0 : 100,
          },
        }),
      ),
      { op: 'updateAccount', id: ACCOUNT_A, openingCents: 5000, importId: id },
    ];
  }
  const refusesZero = (c: LedgerChange) =>
    c.op === 'addTransaction' && c.transaction.amountCents === 0 ? 'Enter an amount' : null;

  test('a refused entry holds the whole import, its opening change too; others still go', async () => {
    const changes = importOf(3, 1);
    const online = server(refusesZero);
    const { queue, events } = await openQueue(online.send);
    queue.add(changes);
    queue.add([expense('9', ACCOUNT_B)]);
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalled());
    expect(online.has()).toEqual([expense('9', ACCOUNT_B)]);
    expect(queue.needsAttention()).toEqual([
      expect.objectContaining({ reason: 'Enter an amount', changes }),
    ]);
  });

  test('refused past its first request, the rest of the import and its opening change wait', async () => {
    const changes = importOf(MAX_CHANGES + 50, MAX_CHANGES + 10);
    const online = server(refusesZero);
    const { queue, events } = await openQueue(online.send);
    queue.add(changes);
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalled());
    // The first request was saved; the opening balance wasn't changed for rows not added
    const first = online.send.mock.calls[0][0].changes.length;
    expect(first).toBeLessThan(MAX_CHANGES + 10);
    expect(online.has()).toEqual(changes.slice(0, first));
    expect(queue.needsAttention()).toEqual([
      expect.objectContaining({ changes: changes.slice(first) }),
    ]);
    expect(online.has().some((c) => c.op === 'updateAccount')).toBe(false);
  });
});
