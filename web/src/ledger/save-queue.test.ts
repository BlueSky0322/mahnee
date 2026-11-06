// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, onTestFinished, test, vi } from 'vitest';
import type { ChangesBody, LedgerChange } from '@shared/api';
import { MAX_CHANGES, isRowId } from '@shared/api';
import { ApiError, NetworkError } from '../api';
import { clearCache, setCacheUser } from '../offline/cache';
import { readOutbox } from '../offline/outbox';
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
  const events = { send, saved: vi.fn(), found: vi.fn(), failed: vi.fn(), idle: vi.fn() };
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

  test('a refused batch drops everything queued after it, on the device too', async () => {
    const { send, requests } = controlledSend();
    const { queue, events } = await openQueue(send);

    queue.add([rename('refused')]);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    queue.add([rename('made on top of it')]);
    const refusal = new ApiError(404, 'Account not found', 'Account not found');
    requests[0].answer(refusal);
    await vi.waitFor(() => expect(events.failed).toHaveBeenCalledWith(refusal));
    expect(events.saved).not.toHaveBeenCalled();
    expect(events.idle).toHaveBeenCalledTimes(1);
    expect(queue.pending()).toEqual([]);
    await vi.waitFor(async () => expect(await kept()).toEqual([]));

    // Later changes are sent as usual
    queue.add([rename('later')]);
    await vi.waitFor(() => expect(requests).toHaveLength(2));
    expect(requests[1].body.changes).toEqual([rename('later')]);
    requests[1].answer();
    await vi.waitFor(() => expect(events.idle).toHaveBeenCalledTimes(2));
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
    const events = { send, saved: vi.fn(), found: vi.fn(), failed: vi.fn(), idle: vi.fn() };
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
    expect(queue.state()).toEqual({ waiting: 0, signedOut: false });
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
