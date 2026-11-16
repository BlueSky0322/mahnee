import { describe, expect, test } from 'vitest';
import type { SearchPage, Transaction } from '@shared/api';
import { applyToPages } from './apply';
import { searchTotals } from './search-totals';

// Activity's figures: how many are found and what they spent and received, in all and on
// each day. The app holds some of the results (as shown, changes still to send included)
// and the server says what matches beyond the last page loaded (`rest`), and how much of
// that falls on that page's last day (`restOfLastDay`), so every figure is what's loaded
// plus what isn't, counted once. Transfers are found, but are never spending or income.

let n = 0;
const t = (over: Partial<Transaction>): Transaction => ({
  id: (++n).toString(16).padStart(16, '0'),
  kind: 'expense',
  accountId: 'a'.repeat(16),
  toAccountId: null,
  amountCents: 100,
  categoryId: 'f'.repeat(16),
  payee: null,
  note: null,
  date: '2026-11-10',
  createdAt: n,
  ...over,
});
const none = { entries: 0, spentCents: 0, receivedCents: 0 };
const page = (over: Partial<SearchPage>): SearchPage => ({
  transactions: [],
  nextBefore: null,
  rest: none,
  restOfLastDay: null,
  ...over,
});

describe('searchTotals', () => {
  test('with everything loaded, sums what is shown, by day, transfers counted but not summed', () => {
    const shown = [
      t({ amountCents: 725, date: '2026-11-10' }),
      t({ amountCents: 1_460, date: '2026-11-10' }),
      t({ kind: 'income', amountCents: 325_000, date: '2026-11-09' }),
      t({ kind: 'transfer', categoryId: null, toAccountId: 'b'.repeat(16), date: '2026-11-09' }),
      t({ amountCents: 1, date: '2026-11-01' }),
    ];
    const totals = searchTotals(shown, [page({ transactions: shown })]);
    expect(totals.found).toEqual({ entries: 5, spentCents: 2_186, receivedCents: 325_000 });
    expect(Object.fromEntries(totals.days)).toEqual({
      '2026-11-10': { entries: 2, spentCents: 2_185, receivedCents: 0 },
      '2026-11-09': { entries: 2, spentCents: 0, receivedCents: 325_000 },
      '2026-11-01': { entries: 1, spentCents: 1, receivedCents: 0 },
    });
    expect(totals.elsewhere).toBeNull();
  });

  test('adds what the server has beyond the last page, and the rest of its last day', () => {
    const first = [
      t({ amountCents: 500, date: '2026-11-10' }),
      t({ amountCents: 300, date: '2026-11-08' }),
    ];
    const second = [t({ amountCents: 200, date: '2026-11-08' })];
    const pages = [
      page({
        transactions: first,
        nextBefore: 'cursor-1',
        rest: { entries: 9, spentCents: 9_000, receivedCents: 0 },
        restOfLastDay: { date: '2026-11-08', entries: 1, spentCents: 200, receivedCents: 0 },
      }),
      page({
        transactions: second,
        nextBefore: 'cursor-2',
        rest: { entries: 8, spentCents: 8_800, receivedCents: 4_000 },
        restOfLastDay: { date: '2026-11-08', entries: 2, spentCents: 700, receivedCents: 0 },
      }),
    ];
    const totals = searchTotals([...first, ...second], pages);
    // Only the last page's rest counts: what the first page said is loaded now
    expect(totals.found).toEqual({ entries: 11, spentCents: 9_800, receivedCents: 4_000 });
    // The 8th is partly loaded: two shown and two more on the server
    expect(totals.days.get('2026-11-08')).toEqual({
      entries: 4,
      spentCents: 1_200,
      receivedCents: 0,
    });
    expect(totals.days.get('2026-11-10')).toEqual({
      entries: 1,
      spentCents: 500,
      receivedCents: 0,
    });
  });

  test('counts a change still to send at once: what is shown is what is counted', () => {
    const saved = [t({ amountCents: 500 }), t({ amountCents: 300 })];
    const pages = [
      page({
        transactions: saved,
        nextBefore: 'cursor',
        rest: { entries: 1, spentCents: 1_000, receivedCents: 0 },
        restOfLastDay: { date: '2026-11-10', entries: 1, spentCents: 1_000, receivedCents: 0 },
      }),
    ];
    // One deleted and one added on the 10th, not yet saved
    const shown = [t({ amountCents: 4_200 }), saved[1]];
    const totals = searchTotals(shown, pages);
    expect(totals.found).toEqual({ entries: 3, spentCents: 5_500, receivedCents: 0 });
    expect(totals.days.get('2026-11-10')).toEqual({
      entries: 3,
      spentCents: 5_500,
      receivedCents: 0,
    });
  });

  test("a last day whose loaded rows were all deleted still counts the server's rest of it", () => {
    const loaded = [
      t({ amountCents: 500, date: '2026-11-10' }),
      t({ amountCents: 300, date: '2026-11-08' }),
    ];
    const pages = [
      page({
        transactions: loaded,
        nextBefore: 'cursor',
        rest: { entries: 2, spentCents: 900, receivedCents: 0 },
        restOfLastDay: { date: '2026-11-08', entries: 1, spentCents: 400, receivedCents: 0 },
      }),
    ];
    // The 8th's one loaded row is deleted, not yet saved
    const totals = searchTotals([loaded[0]], pages);
    expect(totals.days.get('2026-11-08')).toEqual({
      entries: 1,
      spentCents: 400,
      receivedCents: 0,
    });
    expect(totals.found).toEqual({ entries: 3, spentCents: 1_400, receivedCents: 0 });
  });

  test('an add older than the last row loaded, while more are to come, is not shown, so it is counted once: by the rest, once saved', () => {
    const loaded = [
      t({ amountCents: 500, date: '2026-11-10' }),
      t({ amountCents: 300, date: '2026-11-08' }),
    ];
    const pages = [
      page({
        transactions: loaded,
        nextBefore: 'cursor',
        rest: { entries: 4, spentCents: 1_000, receivedCents: 0 },
      }),
    ];
    const older = t({ amountCents: 4_242, date: '2026-11-02' });
    const shown = applyToPages(
      pages,
      [{ op: 'addTransaction', transaction: older }],
      () => true,
    ).flatMap((p) => p.transactions);
    expect(shown.map((x) => x.id)).toEqual(loaded.map((x) => x.id));
    expect(searchTotals(shown, pages).found).toEqual({
      entries: 6,
      spentCents: 1_800,
      receivedCents: 0,
    });
    // Saved (its answer perhaps lost) and read again: in the rest, and still not among the rows
    const again = [
      page({
        transactions: loaded,
        nextBefore: 'cursor',
        rest: { entries: 5, spentCents: 5_242, receivedCents: 0 },
      }),
    ];
    const shownAgain = applyToPages(
      again,
      [{ op: 'addTransaction', transaction: older }],
      () => true,
    ).flatMap((p) => p.transactions);
    expect(searchTotals(shownAgain, again).found).toEqual({
      entries: 7,
      spentCents: 6_042,
      receivedCents: 0,
    });
  });

  test('says how many match outside the days asked for, from the first page', () => {
    const totals = searchTotals([], [page({ elsewhere: 3 }), page({})]);
    expect(totals.found).toEqual(none);
    expect(totals.days.size).toBe(0);
    expect(totals.elsewhere).toBe(3);
  });

  test('has nothing to say before a page loads', () => {
    const totals = searchTotals([], []);
    expect(totals.found).toEqual(none);
    expect(totals.elsewhere).toBeNull();
  });
});
