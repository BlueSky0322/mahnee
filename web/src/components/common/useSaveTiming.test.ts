// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { SAVED_FOR_MS, SAVING_AFTER_MS, useSaveTiming } from './useSaveTiming';

// When the label says "Saving" and "Saved": a save that lands quickly never flashes
// "Saving", one that takes a while says so after a moment, and once changes were sent and
// taken, "Saved" shows for a couple of seconds

interface Props {
  sending: boolean;
  waiting: number;
  refused: number;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

function timing(initial: Partial<Props> = {}) {
  const hook = renderHook((props: Props) => useSaveTiming(props), {
    initialProps: { sending: false, waiting: 0, refused: 0, ...initial },
  });
  const set = (props: Partial<Props>) =>
    hook.rerender({ ...{ sending: false, waiting: 0, refused: 0 }, ...props });
  const pass = (ms: number) => act(() => void vi.advanceTimersByTime(ms));
  return { now: () => hook.result.current, set, pass };
}

describe('saving and saved', () => {
  test('the delay and the time "Saved" stays are a moment and a couple of seconds', () => {
    expect(SAVING_AFTER_MS).toBe(400);
    expect(SAVED_FOR_MS).toBe(2000);
  });

  test('nothing is said while nothing is being sent', () => {
    const t = timing();
    t.pass(5000);
    expect(t.now()).toEqual({ savingShown: false, justSaved: false });
  });

  test('a save still going after the moment says "Saving", not before', () => {
    const t = timing();
    t.set({ sending: true, waiting: 1 });
    t.pass(SAVING_AFTER_MS - 1);
    expect(t.now()).toEqual({ savingShown: false, justSaved: false });
    t.pass(1);
    expect(t.now()).toEqual({ savingShown: true, justSaved: false });
  });

  test('a save that lands within the moment never says "Saving", then says "Saved"', () => {
    const t = timing();
    t.set({ sending: true, waiting: 1 });
    t.pass(SAVING_AFTER_MS - 100);
    t.set({ sending: false, waiting: 0 });
    expect(t.now()).toEqual({ savingShown: false, justSaved: true });
    // The moment passing after it landed doesn't bring "Saving" back
    t.pass(200);
    expect(t.now()).toEqual({ savingShown: false, justSaved: true });
    t.pass(SAVED_FOR_MS - 201);
    expect(t.now().justSaved).toBe(true);
    t.pass(1);
    expect(t.now()).toEqual({ savingShown: false, justSaved: false });
  });

  test('a long save says "Saving", then "Saved" once it lands, then nothing', () => {
    const t = timing();
    t.set({ sending: true, waiting: 2 });
    t.pass(1000);
    expect(t.now().savingShown).toBe(true);
    // One of two saved: still saving
    t.set({ sending: true, waiting: 1 });
    expect(t.now()).toEqual({ savingShown: true, justSaved: false });
    t.set({ sending: false, waiting: 0 });
    expect(t.now()).toEqual({ savingShown: false, justSaved: true });
    t.pass(SAVED_FOR_MS);
    expect(t.now()).toEqual({ savingShown: false, justSaved: false });
  });

  test('another save starting while "Saved" shows keeps it until the moment passes', () => {
    const t = timing();
    t.set({ sending: true, waiting: 1 });
    t.set({ sending: false, waiting: 0 });
    t.pass(1000);
    t.set({ sending: true, waiting: 1 });
    t.pass(SAVING_AFTER_MS - 1);
    expect(t.now()).toEqual({ savingShown: false, justSaved: true });
    t.pass(1);
    expect(t.now().savingShown).toBe(true);
    // It lands, and "Saved" stays its full time from then
    t.set({ sending: false, waiting: 0 });
    t.pass(SAVED_FOR_MS - 1);
    expect(t.now()).toEqual({ savingShown: false, justSaved: true });
    t.pass(1);
    expect(t.now().justSaved).toBe(false);
  });

  test('sending stopping with changes still waiting (offline) says nothing was saved', () => {
    const t = timing();
    t.set({ sending: true, waiting: 1 });
    t.pass(1000);
    t.set({ sending: false, waiting: 1 });
    expect(t.now()).toEqual({ savingShown: false, justSaved: false });
  });

  test('changes the server refused are not said to be saved', () => {
    const t = timing();
    t.set({ sending: true, waiting: 1 });
    t.set({ sending: false, waiting: 0, refused: 1 });
    expect(t.now()).toEqual({ savingShown: false, justSaved: false });
  });

  test('changes sent once back online are said to be saved', () => {
    const t = timing({ waiting: 2 });
    t.set({ sending: true, waiting: 2 });
    t.set({ sending: false, waiting: 0 });
    expect(t.now()).toEqual({ savingShown: false, justSaved: true });
  });
});
