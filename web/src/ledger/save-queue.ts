import type { ChangesBody, LedgerChange } from '@shared/api';
import { MAX_CHANGES, MAX_CHANGES_BYTES } from '@shared/api';
import { newId } from '../utils/id';

// Sending ledger changes to the server in the order they were made: in batches as large
// as one request takes, one batch at a time, each change with an id of its own so the
// server counts one sent again once. A refused batch drops everything queued after it,
// since those were made on top of it.
//
// Kept in memory for now. Callers only queue changes and read what's still to be sent,
// so where the queue is kept can change (the device's storage, to survive going offline
// or the app closing) without changing them.

/** A change waiting to be sent, with the id the server knows it by */
export interface Queued {
  cid: string;
  change: LedgerChange;
}

const utf8 = new TextEncoder();
/** The request body's size around its changes and ids */
const WRAPPER_BYTES = utf8.encode('{"changes":[],"ids":[]}').length;

/** What's sent for these changes: each with its id */
export const changesBody = (batch: Queued[]): ChangesBody => ({
  changes: batch.map((q) => q.change),
  ids: batch.map((q) => q.cid),
});

/**
 * The changes that go in the next request, in order: at most MAX_CHANGES, and no more
 * than MAX_CHANGES_BYTES of JSON, but always at least one
 */
export function nextBatch(queued: Queued[]): Queued[] {
  let bytes = WRAPPER_BYTES;
  let count = 0;
  for (const q of queued.slice(0, MAX_CHANGES)) {
    // The change and its id, and a comma in each list for every change after the first
    bytes +=
      utf8.encode(JSON.stringify(q.change)).length +
      utf8.encode(JSON.stringify(q.cid)).length +
      (count > 0 ? 2 : 0);
    if (count > 0 && bytes > MAX_CHANGES_BYTES) break;
    count++;
  }
  return queued.slice(0, count);
}

export interface SaveQueueEvents {
  /** Sends one batch; resolves once it's saved, rejects if it's refused or never arrives */
  send: (body: ChangesBody) => Promise<unknown>;
  /** A batch was saved */
  saved: (changes: LedgerChange[]) => void;
  /** A batch failed; it and everything queued after it are dropped */
  failed: (err: unknown) => void;
  /** Everything queued has been saved, or dropped after a failure */
  idle: () => void;
}

export interface SaveQueue {
  /** Queues changes to send after any already waiting */
  add: (changes: LedgerChange[]) => void;
  /** Changes made but not yet saved, being sent or waiting, in order */
  pending: () => LedgerChange[];
  /** Forgets everything waiting; an answer to what's being sent is then ignored */
  forget: () => void;
}

export function createSaveQueue(events: SaveQueueEvents): SaveQueue {
  // The batch being sent stays at the front until it's saved
  let queued: Queued[] = [];
  let sending = false;
  // Moves on when the queue is forgotten, so an answer from before is ignored
  let round = 0;

  async function run() {
    if (sending) return;
    sending = true;
    const mine = round;
    while (queued.length > 0) {
      const batch = nextBatch(queued);
      try {
        await events.send(changesBody(batch));
      } catch (err) {
        if (mine !== round) return;
        queued = [];
        sending = false;
        events.failed(err);
        events.idle();
        return;
      }
      if (mine !== round) return;
      queued = queued.slice(batch.length);
      events.saved(batch.map((q) => q.change));
    }
    sending = false;
    events.idle();
  }

  return {
    add: (changes) => {
      queued.push(...changes.map((change) => ({ cid: newId(), change })));
      void run();
    },
    pending: () => queued.map((q) => q.change),
    forget: () => {
      round++;
      queued = [];
      sending = false;
    },
  };
}
