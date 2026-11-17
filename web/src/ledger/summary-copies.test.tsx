// @vitest-environment jsdom
import { get, set } from 'idb-keyval';
import { describe, expect, test } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { fakeServer, renderApp, settle, setupAppTests } from '../testing/app';
import { fetchSummary, fetchTrend } from './ledger';

// A month's totals and its 12 months are kept on the device for opening offline. Copies
// kept before the totals had days, entries and Tidy up are in an older shape, which
// counting changes on top of would get wrong, so they are never read: only copies in the
// current shape (summary-v3, trend-v3: with the first and last day each month was summed
// over, for the month start day) are.

setupAppTests();

const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;

/** A month's totals as kept before days, entries and Tidy up */
const oldShape = (month: string) => ({
  month,
  incomeCents: 0,
  spentCents: 800,
  leftCents: -800,
  spentByCategory: [{ categoryId: FOOD, cents: 800 }],
  incomeByCategory: [],
});

async function signedIn() {
  const server = fakeServer();
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  renderApp(server);
  await settle();
  return server;
}

describe("a month's totals kept on the device", () => {
  test('are kept in the current shape', async () => {
    await signedIn();
    await fetchSummary('2025-10');
    await fetchTrend('2025-10');
    const kept = await get<{ value: Record<string, unknown> }>('summary-v3:2025-10');
    expect(kept?.value).toMatchObject({
      month: '2025-10',
      firstDay: '2025-10-01',
      lastDay: '2025-10-31',
      spentByDay: [],
    });
    expect(kept?.value).toHaveProperty('tidyUp');
    const keptTrend = await get<{ value: { months: Record<string, unknown>[] } }>(
      'trend-v3:2025-10',
    );
    expect(keptTrend?.value.months).toHaveLength(12);
    expect(keptTrend?.value.months[11]).toMatchObject({
      firstDay: '2025-10-01',
      lastDay: '2025-10-31',
    });
    // Nothing goes under the old keys
    for (const old of ['summary-v1', 'trend-v1', 'summary-v2', 'trend-v2']) {
      expect(await get(`${old}:2025-10`)).toBeUndefined();
    }
  });

  test('in the older shape are never shown offline', async () => {
    const server = await signedIn();
    const email = server.me.email;
    await set('summary-v1:2025-09', { email, value: oldShape('2025-09'), at: Date.now() });
    await set('trend-v1:2025-09', {
      email,
      value: { month: '2025-09', months: [oldShape('2025-09')] },
      at: Date.now(),
    });
    server.health = 'unreachable';
    // With no copy in the current shape, offline is a failure to load, not old figures
    await expect(fetchSummary('2025-09')).rejects.toThrow();
    await expect(fetchTrend('2025-09')).rejects.toThrow();
  });

  test('kept before the first and last days were, are never shown offline', async () => {
    const server = await signedIn();
    const email = server.me.email;
    // Days, entries and Tidy up, but not the days it was summed over
    const v2 = {
      ...oldShape('2025-08'),
      spentByCategory: [{ categoryId: FOOD, cents: 800, entries: 1 }],
      spentByDay: [{ date: '2025-08-03', cents: 800 }],
      tidyUp: { from: '2025-07-01', entries: 0, categoryIds: [] },
    };
    await set('summary-v2:2025-08', { email, value: v2, at: Date.now() });
    await set('trend-v2:2025-08', {
      email,
      value: { month: '2025-08', months: [oldShape('2025-08')] },
      at: Date.now(),
    });
    server.health = 'unreachable';
    await expect(fetchSummary('2025-08')).rejects.toThrow();
    await expect(fetchTrend('2025-08')).rejects.toThrow();
  });
});
