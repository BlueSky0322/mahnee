import { describe, expect, test, vi } from 'vitest';
import type { ChangesBody, LedgerChange } from '@shared/api';
import { MAX_CHANGES, MAX_CHANGES_BYTES, isRowId } from '@shared/api';
import type { Queued } from './save-queue';
import { changesBody, createSaveQueue, nextBatch } from './save-queue';

const rename = (name: string): LedgerChange => ({ op: 'updateAccount', id: 'a'.repeat(16), name });
const queued = (n: number, name = (i: number) => `Name ${i}`): Queued[] =>
  Array.from({ length: n }, (_, i) => ({
    cid: i.toString(16).padStart(16, '0'),
    change: rename(name(i)),
  }));
const bytes = (batch: Queued[]) =>
  new TextEncoder().encode(JSON.stringify(changesBody(batch))).length;

describe('nextBatch', () => {
  test('takes at most MAX_CHANGES, in order', () => {
    const all = queued(MAX_CHANGES + 50);
    expect(nextBatch(all)).toEqual(all.slice(0, MAX_CHANGES));
  });

  test('stops before the request would pass MAX_CHANGES_BYTES', () => {
    // About 1 KB each, so the limit is reached long before MAX_CHANGES
    const all = queued(100, (i) => `${i}`.padEnd(1000, 'x'));
    const batch = nextBatch(all);
    expect(batch.length).toBeGreaterThan(1);
    expect(batch.length).toBeLessThan(100);
    expect(batch).toEqual(all.slice(0, batch.length));
    expect(bytes(batch)).toBeLessThanOrEqual(MAX_CHANGES_BYTES);
    expect(bytes(all.slice(0, batch.length + 1))).toBeGreaterThan(MAX_CHANGES_BYTES);
  });

  test('still sends one change bigger than the limit, on its own', () => {
    const all = queued(3, (i) => (i === 0 ? 'x'.repeat(MAX_CHANGES_BYTES) : 'small'));
    expect(nextBatch(all)).toEqual(all.slice(0, 1));
  });
});

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

const flush = () => new Promise((r) => setTimeout(r, 0));

describe('the save queue', () => {
  test('sends one batch at a time, in order, with an id for each change', async () => {
    const { send, requests } = controlledSend();
    const events = { send, saved: vi.fn(), failed: vi.fn(), idle: vi.fn() };
    const queue = createSaveQueue(events);

    queue.add([rename('one')]);
    queue.add([rename('two'), rename('three')]);
    await flush();
    // The first goes alone; the others wait for its answer, then go together
    expect(requests.map((r) => r.body.changes)).toEqual([[rename('one')]]);
    expect(queue.pending()).toEqual([rename('one'), rename('two'), rename('three')]);

    requests[0].answer();
    await flush();
    expect(requests[1].body.changes).toEqual([rename('two'), rename('three')]);
    expect(events.saved).toHaveBeenCalledWith([rename('one')]);
    expect(queue.pending()).toEqual([rename('two'), rename('three')]);
    expect(events.idle).not.toHaveBeenCalled();

    requests[1].answer();
    await flush();
    expect(queue.pending()).toEqual([]);
    expect(events.idle).toHaveBeenCalledTimes(1);
    const ids = requests.flatMap((r) => r.body.ids);
    expect(ids.every(isRowId)).toBe(true);
    expect(new Set(ids).size).toBe(3);
  });

  test('a refused batch drops everything queued after it', async () => {
    const { send, requests } = controlledSend();
    const events = { send, saved: vi.fn(), failed: vi.fn(), idle: vi.fn() };
    const queue = createSaveQueue(events);

    queue.add([rename('refused')]);
    queue.add([rename('made on top of it')]);
    await flush();
    const refusal = new Error('Account not found');
    requests[0].answer(refusal);
    await flush();
    expect(events.failed).toHaveBeenCalledWith(refusal);
    expect(events.saved).not.toHaveBeenCalled();
    expect(events.idle).toHaveBeenCalledTimes(1);
    expect(queue.pending()).toEqual([]);
    expect(requests).toHaveLength(1);

    // Later changes are sent as usual
    queue.add([rename('later')]);
    await flush();
    expect(requests[1].body.changes).toEqual([rename('later')]);
  });

  test('sends nothing more that was made before it was forgotten', async () => {
    const { send, requests } = controlledSend();
    const events = { send, saved: vi.fn(), failed: vi.fn(), idle: vi.fn() };
    const queue = createSaveQueue(events);

    queue.add([rename('sending')]);
    queue.add([rename('waiting')]);
    await flush();
    queue.forget();
    requests[0].answer();
    await flush();
    expect(requests).toHaveLength(1);
    expect(events.saved).not.toHaveBeenCalled();
    expect(queue.pending()).toEqual([]);
  });
});
