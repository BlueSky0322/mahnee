// @vitest-environment jsdom
import { afterEach, describe, expect, test, vi } from 'vitest';
import { MAX_BULK_TRANSACTIONS } from '@shared/ledger';
import { clearToasts, showToast, toastsNow } from './toasts';

// Messages that add up (deletes in a row) stop adding up at their stated maximum, so one
// Undo never brings back more than one change could take out.

afterEach(() => clearToasts());

const deleted = (count: number, undo: () => void) =>
  showToast({
    message: `Deleted ${count}`,
    action: { label: 'Undo', run: undo },
    counted: {
      key: 'deleted-entries',
      count,
      say: (n) => `Deleted ${n}`,
      max: MAX_BULK_TRANSACTIONS,
    },
  });

describe('adding up', () => {
  test('up to the maximum in one message; past it, a new one, each with its own Undo', () => {
    const undos = [vi.fn(), vi.fn(), vi.fn()];
    deleted(400, undos[0]);
    deleted(100, undos[1]);
    expect(toastsNow().map((t) => t.message)).toEqual(['Deleted 500']);
    deleted(1, undos[2]);
    expect(toastsNow().map((t) => t.message)).toEqual(['Deleted 500', 'Deleted 1']);

    // The newest brings back only its own
    toastsNow()[1].action!.run();
    expect(undos[2]).toHaveBeenCalledOnce();
    expect(undos[0]).not.toHaveBeenCalled();
    // The full one brings back both of its, the newest first
    toastsNow()[0].action!.run();
    expect(undos[1]).toHaveBeenCalledOnce();
    expect(undos[0]).toHaveBeenCalledOnce();
    expect(undos[1].mock.invocationCallOrder[0]).toBeLessThan(undos[0].mock.invocationCallOrder[0]);
    expect(toastsNow()).toEqual([]);
  });

  test('a later one adds up with the newest of its kind, not the full one', () => {
    deleted(500, vi.fn());
    deleted(3, vi.fn());
    deleted(2, vi.fn());
    expect(toastsNow().map((t) => t.message)).toEqual(['Deleted 500', 'Deleted 5']);
  });
});

// A message that replaces the one like it (a setting saved, then another): one message,
// in the same place, saying the latest, with its seconds started again
describe('replacing', () => {
  test('the same key replaces the one showing, keeping its id; others stay', () => {
    vi.useFakeTimers();
    try {
      showToast({ message: 'Deleted 1' });
      const first = showToast({ message: 'Accent set to Plum', replaces: 'saved', polite: true });
      vi.advanceTimersByTime(2000);
      const second = showToast({
        message: 'Theme set to Dark',
        replaces: 'saved',
        polite: true,
        autoClose: 2500,
      });
      expect(second).toBe(first);
      expect(toastsNow().map((t) => [t.message, t.polite])).toEqual([
        ['Deleted 1', false],
        ['Theme set to Dark', true],
      ]);
      // Its full seconds again, not what was left of the first
      vi.advanceTimersByTime(2400);
      expect(toastsNow().map((t) => t.message)).toEqual(['Theme set to Dark']);
      vi.advanceTimersByTime(100);
      expect(toastsNow()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
