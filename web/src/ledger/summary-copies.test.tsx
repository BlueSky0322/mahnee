// @vitest-environment jsdom
import { get, set } from 'idb-keyval';
import { describe, expect, test } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { fakeServer, renderApp, settle, setupAppTests } from '../testing/app';
import { fetchSummary, fetchTrend } from './ledger';

// A month's totals and its 12 months are kept on the device for opening offline. Copies
// kept before the totals had days, entries and Tidy up are in an older shape, which
// counting changes on top of would get wrong, so they are never read: only copies in the
// current shape (summary-v2, trend-v2) are.

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
    const kept = await get<{ value: Record<string, unknown> }>('summary-v2:2025-10');
    expect(kept?.value).toMatchObject({ month: '2025-10', spentByDay: [] });
    expect(kept?.value).toHaveProperty('tidyUp');
    const keptTrend = await get<{ value: { months: unknown[] } }>('trend-v2:2025-10');
    expect(keptTrend?.value.months).toHaveLength(12);
    // Nothing goes under the old keys
    expect(await get('summary-v1:2025-10')).toBeUndefined();
    expect(await get('trend-v1:2025-10')).toBeUndefined();
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
});
