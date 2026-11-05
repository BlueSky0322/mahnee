import type { ChangesBody, LedgerChange } from '@shared/api';
import type { Queued } from '../offline/outbox';
import {
  changesBody,
  classifySaveFailure,
  isOtherAccount,
  isSignedOut,
  nextBatch,
  readOutbox,
  requestBackgroundSync,
  withOutbox,
  writeOutbox,
} from '../offline/outbox';
import { isOffline } from '../offline/network';
import { newId } from '../utils/id';

// Sending ledger changes to the server in the order they were made: in batches as large
// as one request takes, one batch at a time, each change with an id of its own so the
// server counts one sent again once. Every change is also kept on the device (the
// outbox) until it's saved, so it survives going offline, a reload or the app closing;
// the service worker sends what's kept while the app is closed.
//
// - No connection, busy, the server failing: kept, and tried again (after 3 seconds,
//   doubling to a minute while online; offline, once the connection is back).
// - Signed out, or signed in as someone else now: kept, and tried again on coming back
//   to the app or the connection coming back, since a timer would only fail until then.
// - Refused: that batch and everything queued after it are dropped, since those were
//   made on top of it.

/** Retries wait this long, doubling each time up to the most */
export const RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = 60_000;

export interface SaveQueueEvents {
  /** Sends one batch; resolves once it's saved, rejects if it's refused or never arrives */
  send: (body: ChangesBody) => Promise<unknown>;
  /** A batch was saved */
  saved: (changes: LedgerChange[]) => void;
  /** Changes kept on the device that this page didn't know of: from before a reload, or another tab */
  found: (changes: LedgerChange[]) => void;
  /** A batch was refused; it and everything queued after it are dropped */
  failed: (err: unknown) => void;
  /** Nothing is left to send: saved, dropped after a refusal, or sent by someone else */
  idle: () => void;
}

/** What's waiting, for showing on screen */
export interface QueueState {
  /** Changes made but not yet saved */
  waiting: number;
  /** Sending stopped because Cloudflare Access wants them to sign in again */
  signedOut: boolean;
}

export interface SaveQueue {
  /** Queues changes to send after any already waiting, keeping them on the device first */
  add: (changes: LedgerChange[]) => void;
  /** Changes made but not yet saved, being sent or waiting, in order */
  pending: () => LedgerChange[];
  /**
   * Whose changes these are, once known (or assumed, offline): picks up what they left
   * waiting on this device, and starts sending
   */
  pickUp: (email: string) => Promise<void>;
  /** Resolves once the signed-in person's kept changes have been picked up */
  ready: () => Promise<void>;
  /** Tries again now: back online, or back to the app */
  resume: () => void;
  /** Forgets everything waiting here; an answer to what's being sent is then ignored */
  forget: () => void;
  state: () => QueueState;
  subscribe: (listener: () => void) => () => void;
}

export function createSaveQueue(events: SaveQueueEvents): SaveQueue {
  // Whose changes these are; nothing is kept or sent until that's known
  let owner: string | null = null;
  // The batch being sent stays at the front until it's saved
  let queued: Queued[] = [];
  // Changes written to the outbox: one gone from there since was sent by someone else
  let stored = new Set<string>();
  let sending = false;
  // Moves on when the queue is forgotten, so work begun before is dropped
  let round = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let signedOut = false;

  // Waited on until the signed-in person's kept changes are picked up; one still waited on
  // carries on past a forget, for whoever is signed in next
  let pickedUp: (() => void) | null = null;
  let ready = new Promise<void>((resolve) => (pickedUp = resolve));

  let current: QueueState = { waiting: 0, signedOut: false };
  const listeners = new Set<() => void>();
  function changed() {
    if (current.waiting === queued.length && current.signedOut === signedOut) return;
    current = { waiting: queued.length, signedOut };
    listeners.forEach((listener) => listener());
  }

  /**
   * Brings the outbox and this page into step, holding the outbox lock: what's kept that
   * this page didn't know of joins in, what this page wrote that's gone since was sent by
   * someone else, and what's new here is kept. False if the queue was forgotten meanwhile.
   */
  async function syncOutbox(email: string, mine: number) {
    const kept = await readOutbox(email);
    if (mine !== round) return false;
    const inOutbox = new Set(kept.map((q) => q.cid));
    const known = new Set(queued.map((q) => q.cid));
    const found = kept.filter((q) => !known.has(q.cid));
    queued = [...kept, ...queued.filter((q) => !inOutbox.has(q.cid) && !stored.has(q.cid))];
    const left = queued;
    if (found.length > 0) events.found(found.map((q) => q.change));
    changed();
    // Not kept (storage full, say): the outbox still holds what it did, and the rest are
    // sent from here
    const written = await writeOutbox(email, left);
    if (mine !== round) return false;
    stored = new Set(left.filter((q) => written || inOutbox.has(q.cid)).map((q) => q.cid));
    return true;
  }

  /** Takes saved changes off the outbox, holding its lock */
  async function crossOff(email: string, saved: Set<string>) {
    const left = (await readOutbox(email)).filter((q) => !saved.has(q.cid));
    await writeOutbox(email, left);
    saved.forEach((cid) => stored.delete(cid));
  }

  function stop() {
    sending = false;
    changed();
  }

  async function run() {
    if (sending || owner == null || queued.length === 0) return;
    clearTimeout(timer);
    if (isOffline()) {
      // Sent when the connection is back, by this page or the service worker
      requestBackgroundSync();
      return;
    }
    sending = true;
    const mine = round;
    const email = owner;
    while (queued.length > 0) {
      let batch: Queued[] = [];
      let saved = false;
      try {
        // Held while sending, so the service worker can't send the same changes
        await withOutbox(email, async () => {
          if (!(await syncOutbox(email, mine))) return;
          batch = nextBatch(queued);
          if (batch.length === 0) return;
          try {
            await events.send(changesBody(batch));
          } catch (err) {
            // Refused: everything queued after it was built on top of it, so it goes
            // too, from the device as well, before anything else can take the lock
            if (mine === round && classifySaveFailure(err) === 'refused') {
              queued = [];
              stored = new Set();
              await writeOutbox(email, []);
            }
            throw err;
          }
          saved = true;
          if (mine !== round) return;
          const ids = new Set(batch.map((q) => q.cid));
          queued = queued.filter((q) => !ids.has(q.cid));
          await crossOff(email, ids);
        });
      } catch (err) {
        if (mine !== round) return;
        if (!saved) {
          stop();
          recover(err);
          return;
        }
        // Saved; only crossing it off on the device failed, so if it's sent again the
        // server counts it once
      }
      if (mine !== round) return;
      if (saved) {
        failures = 0;
        signedOut = false;
        events.saved(batch.map((q) => q.change));
        changed();
      }
    }
    stop();
    events.idle();
  }

  function recover(err: unknown) {
    if (classifySaveFailure(err) === 'refused') {
      signedOut = false;
      changed();
      events.failed(err);
      events.idle();
      return;
    }
    // Not the change's fault: kept (still in the outbox), and tried again
    requestBackgroundSync();
    signedOut = isSignedOut(err);
    changed();
    if (isOffline() || signedOut || isOtherAccount(err)) return;
    const delay = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** failures++);
    timer = setTimeout(() => void run(), delay);
  }

  /** Keeps what's new here on the device, then sends */
  function keepAndSend() {
    if (owner == null) return;
    const email = owner;
    const mine = round;
    void withOutbox(email, () => syncOutbox(email, mine))
      .catch(() => undefined)
      .then(() => run());
  }

  return {
    add: (changes) => {
      queued.push(...changes.map((change) => ({ cid: newId(), change })));
      changed();
      keepAndSend();
    },
    pending: () => queued.map((q) => q.change),
    pickUp: async (email) => {
      owner = email;
      const mine = round;
      // Nothing could be read (no storage): nothing was left over to send
      await withOutbox(email, () => syncOutbox(email, mine)).catch(() => undefined);
      if (mine !== round) return;
      pickedUp?.();
      pickedUp = null;
      void run();
    },
    ready: () => ready,
    resume: () => {
      failures = 0;
      void run();
    },
    forget: () => {
      round++;
      owner = null;
      queued = [];
      stored = new Set();
      sending = false;
      signedOut = false;
      failures = 0;
      clearTimeout(timer);
      if (pickedUp == null) ready = new Promise<void>((resolve) => (pickedUp = resolve));
      changed();
    },
    state: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
