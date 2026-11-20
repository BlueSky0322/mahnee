import type { ChangesBody, LedgerChange } from '@shared/api';
import type { Queued } from '../offline/outbox';
import {
  appendToOutbox,
  changesBody,
  classifySaveFailure,
  discardRefused,
  groupsIn,
  heldWith,
  TIMEOUT_TRIES,
  isOtherAccount,
  isSignedOut,
  isTimedOut,
  markRefused,
  nextBatch,
  readOwnOutbox,
  refusalReason,
  removeFromOutbox,
  requestBackgroundSync,
  retryRefused,
  shownOf,
  unrefused,
  withOutbox,
} from '../offline/outbox';
import { isOffline } from '../offline/network';
import { newId } from '../utils/id';

// Sending ledger changes to the server in the order they were made: in batches as large
// as one request takes, one batch at a time, each change with an id of its own so the
// server counts one sent again once. Every change is kept on the device (the outbox) as
// soon as it's made, in a write of its own that never waits for a send, so closing the
// app straight after is safe; it stays there until it's saved, through going offline, a
// reload or the app closing. The service worker sends what's kept while the app is closed.
//
// - No connection, busy, the server failing: kept, and tried again (after 3 seconds,
//   doubling to a minute while online; offline, once the connection is back).
// - Signed out, or signed in as someone else now: kept, and tried again on coming back
//   to the app or the connection coming back, since a timer would only fail until then.
// - Too large for the server (a 413 with its reason): refused, as below. Taking too long
//   (408): tried again as above, and held as a refused one is after TIMEOUT_TRIES in a row.
// - Refused: the server says no to a whole request, so requests are halved until the
//   change it refuses is found. That change, the rest of what was made with it and what
//   was made on top of it are kept, with the server's reason, for the person to try again
//   or discard (needsAttention); everything else carries on.
// - The device can't keep a change (storage full or blocked): it's still sent from this
//   page, and the person is told, with a way to try keeping it again.
// - The device can't be read: that isn't an empty outbox. Nothing kept is let go of; the
//   page carries on with what it holds.

/** Retries wait this long, doubling each time up to the most */
export const RETRY_DELAY_MS = 3000;
const MAX_RETRY_DELAY_MS = 60_000;

export interface SaveQueueEvents {
  /** Sends one batch; resolves once it's saved, rejects if it's refused or never arrives */
  send: (body: ChangesBody) => Promise<unknown>;
  /** A batch was saved: its changes, and the id each was sent with */
  saved: (changes: LedgerChange[], ids: string[]) => void;
  /**
   * Changes waiting that this page didn't show: from before a reload, another tab, or
   * refused ones tried again
   */
  found: (changes: LedgerChange[]) => void;
  /**
   * A change was refused: it and those held with it no longer show as waiting, and are
   * kept for the person to review
   */
  failed: (err: unknown) => void;
  /** Changes shown as waiting no longer are (refused elsewhere): shown again without them */
  withdrawn: () => void;
  /** Nothing is left to send: saved, held after a refusal, or sent by someone else */
  idle: () => void;
}

/** What's waiting, for showing on screen */
export interface QueueState {
  /** Changes made but not yet saved, refused ones not counted */
  waiting: number;
  /** Sending stopped because Cloudflare Access wants them to sign in again */
  signedOut: boolean;
  /**
   * Changes this device couldn't keep (storage full or blocked): saved from the open page,
   * but lost if it closes first
   */
  unkept: number;
  /** Changes the server refused, with those held with them, waiting for the person */
  refused: number;
}

/** Changes the server refused, kept for the person to try again or discard */
export interface Refused {
  /** Names them, for trying again or discarding */
  set: string;
  /** Why, in the server's words */
  reason: string;
  /** The change refused first, then those held with it, in order, as shown */
  changes: LedgerChange[];
  /** The same, as kept */
  queued: Queued[];
}

export interface SaveQueue {
  /**
   * Queues changes made together to send after any already waiting, keeping them on the
   * device straight away, with the currency their amounts were typed in, and (one each,
   * for changes in another currency) each as it's shown until saved
   */
  add: (changes: LedgerChange[], currency?: string, shown?: LedgerChange[]) => void;
  /** Changes made but not yet saved, being sent or waiting, in order */
  pending: () => LedgerChange[];
  /** The same, each with the id it's sent with */
  pendingWithIds: () => Queued[];
  /** Refused changes waiting for the person, the same list until it changes */
  needsAttention: () => Refused[];
  /**
   * Sends a refused set again, shown again meanwhile; nothing changes until the device has
   * it as waiting again
   */
  retry: (set: string) => Promise<void>;
  /** Lets a refused set go, once the device has let it go */
  discard: (set: string) => Promise<void>;
  /** Tries again to keep on the device what it couldn't */
  keepAgain: () => void;
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

/** A change as this page holds it */
type Item = Queued & {
  /** Kept on the device */
  kept: boolean;
  /** Refused, but the device couldn't note it: the page's mark stands until it can */
  unnoted?: boolean;
};

/** A change as it's kept on the device */
const plain = ({ kept: _kept, unnoted: _unnoted, ...q }: Item): Queued => q;

const NOTHING: QueueState = { waiting: 0, signedOut: false, unkept: 0, refused: 0 };

export function createSaveQueue(events: SaveQueueEvents): SaveQueue {
  // Whose changes these are; nothing is kept or sent until that's known
  let owner: string | null = null;
  // Every change here, in the order kept: waiting (the batch being sent first), and refused
  let items: Item[] = [];
  // Saved, but taking them off the device failed: not shown or picked up again
  let delivered = new Set<string>();
  let sending = false;
  // Moves on when the queue is forgotten, so work begun before is dropped
  let round = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  // Requests in a row the server took too long to read
  let timeouts = 0;
  let signedOut = false;
  // The last try to keep changes on the device failed
  let keepFailed = false;
  // How many groups one request may carry: halved after a refusal until the refused change
  // is found
  let maxGroups = Infinity;
  // Keeping changes on the device, one write after another in this page
  let keeping: Promise<unknown> = Promise.resolve();
  // Reading the device into this page, trying again and discarding take turns, so one
  // never undoes what another just did
  let turn: Promise<unknown> = Promise.resolve();
  function inTurn<T>(fn: () => Promise<T>): Promise<T> {
    const run = turn.then(fn, fn);
    turn = run.catch(() => undefined);
    return run;
  }

  // Waited on until the signed-in person's kept changes are picked up; one still waited on
  // carries on past a forget, for whoever is signed in next
  let pickedUp: (() => void) | null = null;
  let ready = new Promise<void>((resolve) => (pickedUp = resolve));

  const waitingItems = () => items.filter((i) => i.refused == null);

  let current: QueueState = NOTHING;
  let attention: Refused[] = [];
  let attentionKey = '';
  const listeners = new Set<() => void>();
  // Which changes wait, in short: listeners hear only when it, the state or the refused
  // ones change, since each hearing works the waiting changes out again on screen
  let waitingKey = '';
  function changed(force = false) {
    const waiting = waitingItems();
    const next: QueueState = {
      waiting: waiting.length,
      signedOut,
      unkept: keepFailed ? items.filter((i) => !i.kept).length : 0,
      refused: items.length - waiting.length,
    };
    let heard = force;
    if ((Object.keys(next) as (keyof QueueState)[]).some((k) => next[k] !== current[k])) {
      current = next;
      heard = true;
    }
    const nowWaiting = `${waiting.length}:${waiting[0]?.cid}:${waiting[waiting.length - 1]?.cid}`;
    if (nowWaiting !== waitingKey) {
      waitingKey = nowWaiting;
      heard = true;
    }
    const refused = items.filter((i) => i.refused != null);
    const key = refused.map((i) => `${i.cid}:${i.refused!.set}`).join(',');
    if (key !== attentionKey) {
      attentionKey = key;
      heard = true;
      const sets = new Map<string, Refused>();
      for (const i of refused) {
        const { set, reason } = i.refused!;
        const found = sets.get(set) ?? { set, reason, changes: [], queued: [] };
        found.changes.push(shownOf(i));
        found.queued.push(plain(i));
        sets.set(set, found);
      }
      attention = [...sets.values()];
    }
    if (heard) listeners.forEach((listener) => listener());
  }

  /** Keeps on the device what this page hasn't yet, in order, after what's there */
  function keep(): Promise<unknown> {
    const email = owner;
    const mine = round;
    const done = keeping.then(async () => {
      const fresh = items.filter((i) => !i.kept);
      if (email == null || mine !== round || fresh.length === 0) return;
      try {
        await appendToOutbox(email, fresh.map(plain));
      } catch {
        if (mine !== round) return;
        keepFailed = true;
        changed();
        return;
      }
      if (mine !== round) return;
      fresh.forEach((i) => (i.kept = true));
      keepFailed = items.some((i) => !i.kept) && keepFailed;
      changed();
    });
    keeping = done.catch(() => undefined);
    return keeping;
  }

  /**
   * Brings this page into step with the device: what's kept that this page didn't know of
   * joins in (made before a reload, or in another tab), what this page kept that's gone
   * since was saved by someone else (or let go of), and refusals noted elsewhere are taken
   * in. A device that can't be read changes nothing here. False if the queue was forgotten
   * meanwhile.
   */
  function reconcile(email: string, mine: number) {
    return inTurn(() => reconcileNow(email, mine));
  }

  async function reconcileNow(email: string, mine: number) {
    await keeping;
    let kept: Queued[];
    try {
      kept = await readOwnOutbox(email);
    } catch {
      return mine === round;
    }
    if (mine !== round) return false;
    // Saved, but still on the device: taken off again, never shown again
    const stale = new Set(kept.filter((q) => delivered.has(q.cid)).map((q) => q.cid));
    delivered = stale;
    if (stale.size > 0) {
      void removeFromOutbox(email, stale).then(
        () => stale.forEach((cid) => delivered.delete(cid)),
        () => undefined,
      );
    }
    const here = new Map(items.map((i) => [i.cid, i]));
    const onDevice = new Set(kept.map((q) => q.cid));
    const found: Queued[] = [];
    const unnoted: Item[] = [];
    let withdrawn = false;
    const next: Item[] = [];
    for (const q of kept) {
      if (stale.has(q.cid)) continue;
      const known = here.get(q.cid);
      // Refused here, but the device couldn't note it yet: the page's mark stands
      if (known?.unnoted && q.refused == null) {
        unnoted.push(known);
        next.push(known);
        continue;
      }
      if (q.refused == null && (known == null || known.refused != null)) found.push(q);
      if (q.refused != null && known != null && known.refused == null) withdrawn = true;
      next.push({ ...q, kept: true });
    }
    items = [...next, ...items.filter((i) => !i.kept && !onDevice.has(i.cid))];
    if (unnoted.length > 0) void noteRefused(email, unnoted);
    if (found.length > 0) events.found(found.map(shownOf));
    if (withdrawn) events.withdrawn();
    changed(found.length > 0 || withdrawn);
    return true;
  }

  /** Notes refused changes on the device; until it can, this page's mark stands */
  function noteRefused(email: string, refused: Item[]) {
    return markRefused(email, refused.map(plain)).then(
      () => refused.forEach((i) => delete i.unnoted),
      () => refused.forEach((i) => (i.unnoted = true)),
    );
  }

  function stop() {
    sending = false;
    maxGroups = Infinity;
    changed();
  }

  async function run() {
    if (sending || owner == null || waitingItems().length === 0) return;
    clearTimeout(timer);
    if (isOffline()) {
      // Sent when the connection is back, by this page or the service worker
      requestBackgroundSync();
      return;
    }
    sending = true;
    const mine = round;
    const email = owner;
    for (;;) {
      let batch: Item[] = [];
      let outcome: 'none' | 'saved' | 'narrowed' | 'refused' = 'none';
      let refusal: unknown = null;
      try {
        // Held while sending, so the service worker doesn't send the same changes; keeping
        // new ones on the device never waits for it
        await withOutbox(email, async () => {
          if (!(await reconcile(email, mine))) return;
          batch = nextBatch(waitingItems(), maxGroups) as Item[];
          if (batch.length === 0) return;
          try {
            await events.send(changesBody(batch));
          } catch (err) {
            if (mine !== round) throw err;
            // One that keeps taking too long is held, as a refusal is, after a few tries
            if (isTimedOut(err)) timeouts++;
            const refused =
              classifySaveFailure(err) === 'refused' ||
              (isTimedOut(err) && timeouts >= TIMEOUT_TRIES);
            if (!refused) throw err;
            timeouts = 0;
            refusal = err;
            // The server refuses a request whole: halved until the change it refuses is found
            if (groupsIn(batch) > 1) {
              maxGroups = Math.ceil(groupsIn(batch) / 2);
              outcome = 'narrowed';
              return;
            }
            outcome = 'refused';
            maxGroups = Infinity;
            const held = heldWith(items, new Set(batch.map((q) => q.cid)));
            const why = { reason: refusalReason(err), set: batch[0].cid };
            items = items.map((i) => (held.has(i.cid) ? { ...i, refused: why } : i));
            // Noted on the device before anything else can take the lock
            await noteRefused(
              email,
              items.filter((i) => held.has(i.cid)),
            );
            return;
          }
          outcome = 'saved';
          if (mine !== round) return;
          const ids = new Set(batch.map((q) => q.cid));
          items = items.filter((i) => !ids.has(i.cid));
          ids.forEach((cid) => delivered.add(cid));
          // Saved: taken off the device, only these. If that fails they're taken off next
          // time; sent again meanwhile, the server counts them once.
          await removeFromOutbox(email, ids).then(
            () => ids.forEach((cid) => delivered.delete(cid)),
            () => undefined,
          );
        });
      } catch (err) {
        if (mine !== round) return;
        stop();
        recover(err);
        return;
      }
      if (mine !== round) return;
      if (outcome === 'none') break;
      if (outcome === 'saved') {
        failures = 0;
        timeouts = 0;
        signedOut = false;
        events.saved(
          batch.map(shownOf),
          batch.map((q) => q.cid),
        );
        changed();
      } else if (outcome === 'refused') {
        signedOut = false;
        changed();
        events.failed(refusal);
      }
    }
    stop();
    events.idle();
  }

  function recover(err: unknown) {
    // Not the change's fault: kept (still in the outbox), and tried again
    requestBackgroundSync();
    signedOut = isSignedOut(err);
    changed();
    if (isOffline() || signedOut || isOtherAccount(err)) return;
    const delay = Math.min(MAX_RETRY_DELAY_MS, RETRY_DELAY_MS * 2 ** failures++);
    timer = setTimeout(() => void run(), delay);
  }

  return {
    add: (changes, currency, shown) => {
      const group = newId();
      items.push(
        ...changes.map((change, i) => ({
          cid: i === 0 ? group : newId(),
          change,
          ...(currency && { currency }),
          ...(shown?.[i] != null && shown[i] !== change && { shown: shown[i] }),
          ...(changes.length > 1 && { group }),
          kept: false,
        })),
      );
      changed();
      void keep().then(() => run());
    },
    pending: () => waitingItems().map(shownOf),
    pendingWithIds: () => waitingItems().map(plain),
    needsAttention: () => attention,
    retry: async (set) => {
      const email = owner;
      const mine = round;
      if (email == null || !items.some((i) => i.refused?.set === set)) return;
      const tried = await inTurn(async () => {
        // The device first: until it has them as waiting, nothing changes here
        try {
          await retryRefused(email, set);
        } catch {
          return false;
        }
        if (mine !== round) return false;
        const back = items.filter((i) => i.refused?.set === set);
        items = items.map((i) => (i.refused?.set === set ? { ...unrefused(i), kept: i.kept } : i));
        changed();
        if (back.length > 0) events.found(back.map(shownOf));
        return true;
      });
      if (!tried || mine !== round) return;
      failures = 0;
      void run();
    },
    discard: async (set) => {
      const email = owner;
      const mine = round;
      if (email == null) return;
      await inTurn(async () => {
        // The device first: until it has let them go, they stay listed here
        try {
          await discardRefused(email, set);
        } catch {
          return;
        }
        if (mine !== round) return;
        items = items.filter((i) => i.refused?.set !== set);
        changed();
      });
    },
    keepAgain: () => void keep().then(() => run()),
    pickUp: async (email) => {
      owner = email;
      const mine = round;
      await reconcile(email, mine);
      // Made before it was known whose they were
      await keep();
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
      items = [];
      delivered = new Set();
      sending = false;
      signedOut = false;
      keepFailed = false;
      failures = 0;
      timeouts = 0;
      maxGroups = Infinity;
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
