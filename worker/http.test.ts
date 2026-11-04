import { describe, expect, test } from 'vitest';
import { readBody } from './http';

// Reading a request's body only as far as it may go: refused as soon as it's too large,
// or too slow, without waiting for the rest or keeping it

/** A body sent in these chunks, then left open unless `end`; notes whether it was cancelled */
function sending(chunks: Uint8Array[], { end = true, length }: { end?: boolean; length?: number }) {
  const state = { cancelled: false, pulled: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = chunks[state.pulled++];
      if (next) controller.enqueue(next);
      else if (end) controller.close();
      // Otherwise it never sends the rest
      else return new Promise(() => {});
    },
    cancel() {
      state.cancelled = true;
    },
  });
  const headers = length == null ? undefined : { 'Content-Length': String(length) };
  // Node needs to be told a streamed body is sent while the answer may come
  const init = { method: 'POST', body, headers, duplex: 'half' } as RequestInit;
  const req = new Request('https://x.test/api', init);
  return { req, state };
}

const kib = (n: number) => new Uint8Array(n * 1024).fill(1);

describe('readBody', () => {
  test('reads a body within the limit, however it arrives', async () => {
    const { req } = sending([kib(1), kib(2)], {});
    expect(await readBody(req, 4 * 1024)).toEqual(new Uint8Array(3 * 1024).fill(1));
  });

  test('refuses a body that says it is too large without reading any of it', async () => {
    const { req } = sending([kib(1)], { end: false, length: 5 * 1024 * 1024 });
    expect(await readBody(req, 4 * 1024 * 1024)).toBe('too large');
    expect(req.bodyUsed).toBe(false);
  });

  test('stops at the limit when it says nothing, or less than it sends, and lets go', async () => {
    // The rest is never sent: refusing doesn't wait for it
    const { req, state } = sending([kib(3), kib(3)], { end: false, length: 1024 });
    expect(await readBody(req, 4 * 1024)).toBe('too large');
    expect(state.cancelled).toBe(true);
  });

  test('gives up on a body that stops arriving', async () => {
    const { req, state } = sending([kib(1)], { end: false });
    expect(await readBody(req, 4 * 1024, 20)).toBe('too slow');
    expect(state.cancelled).toBe(true);
  });
});
