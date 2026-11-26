// @vitest-environment jsdom
import { get, set } from 'idb-keyval';
import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, onTestFinished, test, vi } from 'vitest';
import { DEFAULT_CATEGORIES } from '@shared/categories';
import { whenCacheUserKnown } from '../offline/cache';
import { queryClient } from '../query-client';
import { fakeServer, holdNext, reloadApp, renderApp, settle, setupAppTests } from '../testing/app';
import { toDateInput } from '../utils/date-input';
import {
  change,
  changeTyped,
  fetchSummary,
  fetchTrend,
  pendingWithIds,
  SUMMARY_KEY,
  summaryKey,
  TREND_KEY,
} from './ledger';

// A month's totals and its 12 months are kept on the device for opening offline. Copies
// kept before the totals had days, entries and Tidy up are in an older shape, which
// counting changes on top of would get wrong, so they are never read: only copies in the
// current shape (summary-v3, trend-v3: with the first and last day each month was summed
// over, for the month start day) are.

setupAppTests();

const FOOD = DEFAULT_CATEGORIES.find((c) => c.name === 'Food')!.id;
const WALLET = 'a'.repeat(16);
const EXPENSES = '/?plan&category=expenses';
const chart = () => screen.findByRole('region', { name: /^All expenses, last 12 months/ });

function withWallet() {
  const server = fakeServer();
  server.accounts.push({
    id: WALLET,
    name: 'Wallet',
    kind: 'cash',
    currency: 'MYR',
    openingCents: 10_000,
    position: 0,
    archived: false,
  });
  return server;
}

const expense = () => ({
  id: 'b'.repeat(16),
  kind: 'expense' as const,
  accountId: WALLET,
  toAccountId: null,
  categoryId: FOOD,
  amountCents: 800,
  date: toDateInput(new Date()),
  payee: null,
  note: null,
});

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
  test('an older summary and trend reply cannot undo an acknowledged expense after an offline restart', async () => {
    const server = withWallet();
    renderApp(server, EXPENSES, { size: 'phone' });
    await within(await chart()).findAllByRole('listitem');
    await settle();

    const oldSummary = holdNext(server, 'GET', '/api/summary');
    const oldTrend = holdNext(server, 'GET', '/api/summary/trend');
    void queryClient.refetchQueries({ queryKey: SUMMARY_KEY, type: 'active' });
    void queryClient.refetchQueries({ queryKey: TREND_KEY, type: 'active' });
    await waitFor(() => expect(server.held).toHaveLength(0));

    const saved = holdNext(server, 'POST', '/api/changes');
    change({ op: 'addTransaction', transaction: expense() });
    await waitFor(() => expect(server.transactions[0]?.amountCents).toBe(800));
    expect(pendingWithIds()).toHaveLength(1);
    server.health = 'unreachable';
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => online.mockRestore());
    act(() => {
      window.dispatchEvent(new Event('offline'));
      saved.release();
    });
    await waitFor(() => expect(pendingWithIds()).toHaveLength(0));
    await act(async () => {
      oldSummary.release();
      oldTrend.release();
      await settle();
    });

    await reloadApp(server, EXPENSES, { size: 'phone' });
    expect(await screen.findByRole('heading', { name: 'All expenses' })).toBeTruthy();
    expect(await within(await chart()).findByText(/8\.00/)).toBeTruthy();
    await reloadApp(server, '/', { size: 'phone' });
    const month = await screen.findByRole('link', { name: /^Expenses so far/ });
    expect(month.textContent).toContain('RM 8.00');
  });

  test('a slow sign-in reloads totals requested before the owner was known', async () => {
    const server = withWallet();
    const profile = holdNext(server, 'GET', '/api/me');
    const unbound = holdNext(server, 'GET', '/api/summary/trend');
    renderApp(server, EXPENSES, { size: 'phone' });
    await waitFor(() => expect(server.held).toHaveLength(0));
    server.transactions.push({ ...expense(), time: null, createdAt: Date.now() });
    profile.release();
    await whenCacheUserKnown();
    unbound.release();
    expect(await within(await chart()).findByText(/RM 8\.00/)).toBeTruthy();
  });

  test('a reply counting the acknowledged FX expense keeps the settled amount offline', async () => {
    const server = withWallet();
    server.rates.set('THBMYR', 0.25);
    renderApp(server, '/', { size: 'phone' });
    await screen.findByRole('link', { name: /^Expenses so far/ });
    await settle();

    const saved = holdNext(server, 'POST', '/api/changes');
    const shown = expense();
    changeTyped(
      'THB',
      [{ op: 'addTransaction', transaction: { ...shown, amountCents: 4_000 } }],
      [{ op: 'addTransaction', transaction: shown }],
    );
    await waitFor(() => expect(server.transactions[0]?.amountCents).toBe(1_000));
    expect(pendingWithIds()).toHaveLength(1);

    // This read sees the server's RM10 and its receipt, while the POST answer is still held.
    const confirmed = holdNext(server, 'GET', '/api/summary');
    void queryClient.refetchQueries({ queryKey: summaryKey(shown.date.slice(0, 7)) });
    await waitFor(() => expect(server.held).toHaveLength(0));
    server.health = 'unreachable';
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => online.mockRestore());
    act(() => {
      window.dispatchEvent(new Event('offline'));
      saved.release();
    });
    await waitFor(() => expect(pendingWithIds()).toHaveLength(0));
    await act(async () => {
      confirmed.release();
      await settle();
    });

    await reloadApp(server, '/', { size: 'phone' });
    const month = await screen.findByRole('link', { name: /^Expenses so far/ });
    expect(month.textContent).toContain('RM 10.00');
  });

  test('an older trend from another page cannot overwrite saved totals on this device', async () => {
    const server = withWallet();
    renderApp(server, EXPENSES, { size: 'phone' });
    await within(await chart()).findAllByRole('listitem');
    await settle();

    const old = holdNext(server, 'GET', '/api/summary/trend');
    const stale = fetchTrend(expense().date.slice(0, 7));
    await waitFor(() => expect(server.held).toHaveLength(0));

    // A separate ledger and query cache, with the same signed-in account and IndexedDB.
    await reloadApp(server, EXPENSES, { size: 'phone' });
    const page = await import('./ledger');
    await within(await chart()).findAllByRole('listitem');
    await settle();
    const saved = holdNext(server, 'POST', '/api/changes');
    page.change({ op: 'addTransaction', transaction: expense() });
    await waitFor(() => expect(server.transactions[0]?.amountCents).toBe(800));
    expect(page.pendingWithIds()).toHaveLength(1);
    server.health = 'unreachable';
    const online = vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
    onTestFinished(() => online.mockRestore());
    act(() => {
      window.dispatchEvent(new Event('offline'));
      saved.release();
    });
    await waitFor(() => expect(page.pendingWithIds()).toHaveLength(0));
    await settle();

    old.release();
    expect((await stale).months.at(-1)?.spentCents).toBe(0);
    await settle();
    await reloadApp(server, EXPENSES, { size: 'phone' });
    expect(await within(await chart()).findByText(/RM 8\.00/)).toBeTruthy();
  });

  test.each(['older', 'newer'])(
    'keeps the newest server totals when the %s request answers first',
    async (first) => {
      const server = withWallet();
      renderApp(server);
      await settle();
      const month = '2025-10';
      const key = `summary-v3:${month}`;
      const earlier = holdNext(server, 'GET', '/api/summary');
      const old = fetchSummary(month);
      await waitFor(() => expect(server.held).toHaveLength(0));

      // The server has a new expense from another device. No batch was saved in this tab.
      server.transactions.push({
        ...expense(),
        date: '2025-10-02',
        time: null,
        createdAt: Date.now(),
      });
      await reloadApp(server, '/?accounts', { size: 'phone' });
      const other = await import('./ledger');
      const later = holdNext(server, 'GET', '/api/summary');
      const fresh = other.fetchSummary(month);
      await waitFor(() => expect(server.held).toHaveLength(0));

      const awaitCopy = (spentCents: number) =>
        waitFor(async () => {
          const kept = await get<{ value: { spentCents: number } }>(key);
          expect(kept?.value.spentCents).toBe(spentCents);
        });
      if (first === 'older') {
        earlier.release();
        expect((await old).spentCents).toBe(0);
        await awaitCopy(0);
        later.release();
        expect((await fresh).spentCents).toBe(800);
      } else {
        later.release();
        expect((await fresh).spentCents).toBe(800);
        await awaitCopy(800);
        earlier.release();
        expect((await old).spentCents).toBe(0);
      }
      await settle();
      server.health = 'unreachable';
      expect((await fetchSummary(month)).spentCents).toBe(800);
    },
  );

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
