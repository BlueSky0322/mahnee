// @vitest-environment jsdom
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import type { FakeServer } from '../testing/app';
import { fakeServer, renderApp, settle, setupAppTests } from '../testing/app';

// Load more after the server changed how it names where a page carries on from (entries
// gained a time of day): a page loaded before the change, or by an app from before it,
// carries the old name, which the server refuses (400). Load more then starts the list
// again from the top, keeping what's on screen meanwhile, and carries on: later rows come,
// none twice, and no error is shown. Names and figures are made up.

setupAppTests();

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 10, 20, 10, 0, 0));
});
afterEach(() => vi.useRealTimers());

const WALLET = 'a'.repeat(16);
const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;

/** A Wallet with `n` entries this month, "Kiosk 1" the oldest, one per minute saved */
function withEntries(n: number): FakeServer {
  const server = fakeServer();
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 1_000_000,
    position: 0,
    archived: false,
  });
  server.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  for (let i = 1; i <= n; i++) {
    server.transactions.push({
      id: i.toString(16).padStart(16, '0'),
      kind: 'expense',
      accountId: WALLET,
      toAccountId: null,
      amountCents: 100,
      categoryId: FOOD,
      payee: `Kiosk ${i}`,
      note: null,
      date: `2026-11-${String(1 + (i % 19)).padStart(2, '0')}`,
      createdAt: i,
    });
  }
  // The first page answered names where it carries on from as the server did before
  server.oldCursorNext = true;
  return server;
}

/** Each row's payee, in the order shown, within `region` */
const payees = (region: HTMLElement) =>
  within(region)
    .getAllByRole('button', { name: /^Kiosk \d+, / })
    .map((b) => b.getAttribute('aria-label')!.split(',')[0]);

/** How many times the app asked for `path` from the top (no place to carry on from) */
const firstPageReads = (path: string) =>
  vi
    .mocked(fetch)
    .mock.calls.map(([input]) => (input instanceof Request ? input.url : input.toString()))
    .filter((url) => url.includes(path) && !url.includes('before=')).length;

describe('Load more after a page named where to carry on from the old way', () => {
  test('on Activity, starts again from the top and carries on, nothing twice', async () => {
    const server = withEntries(210);
    renderApp(server, '/?activity', { size: 'phone' });
    const results = await screen.findByRole('region', { name: 'Results' });
    await waitFor(() => expect(payees(results)).toHaveLength(200));
    const before = firstPageReads('/api/search');
    const user = userEvent.setup();
    await user.click(within(results).getByRole('button', { name: 'Load more' }));
    await waitFor(() => expect(payees(results)).toHaveLength(210), { timeout: 5000 });
    const shown = payees(results);
    expect(new Set(shown).size).toBe(210);
    await settle();
    expect(firstPageReads('/api/search') - before).toBeLessThanOrEqual(1);
    expect(screen.queryByText(/Unknown place to carry on from|Something went wrong/)).toBeNull();
  });

  test("on an account's page, starts again from the top and carries on, nothing twice", async () => {
    const server = withEntries(60);
    renderApp(server, `/?account=${WALLET}`, { size: 'phone' });
    const list = await screen.findByRole('region', { name: 'Transactions' });
    await waitFor(() => expect(payees(list)).toHaveLength(50));
    const before = firstPageReads('/api/transactions');
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Show 50 more' }));
    await waitFor(() => expect(payees(list)).toHaveLength(60), { timeout: 5000 });
    expect(new Set(payees(list)).size).toBe(60);
    await settle();
    expect(firstPageReads('/api/transactions') - before).toBeLessThanOrEqual(1);
    expect(screen.queryByText(/Unknown place to carry on from|Something went wrong/)).toBeNull();
  });
});
